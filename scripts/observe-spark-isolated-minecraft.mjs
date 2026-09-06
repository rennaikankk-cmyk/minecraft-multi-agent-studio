import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SingleBotRuntime } from '../apps/bot-runtime/dist/runtime.js';
import { createMineflayerClient } from '../apps/bot-runtime/dist/mineflayer-client.js';
import { serverProfileSchema } from '../apps/bot-runtime/dist/server-profile.js';
import { BotRegistry } from '../apps/coordinator/dist/bot-registry.js';
import { BotAssignmentService } from '../apps/coordinator/dist/bot-assignment.js';
import { BaseRegistry, FacilityRegistry, InMemoryWorkstationRegistry } from '../packages/skills/dist/index.js';
import { RegistryFactReader } from '../apps/coordinator/dist/spark-strategy-v1/registry-facts.js';
import { TeamProposalObserver } from '../apps/coordinator/dist/spark-strategy-v1/observer.js';
import { scheduledRouterModelClient } from '../apps/coordinator/dist/spark-strategy-v1/model-client.js';
import { loadLocalAIConfig } from '../apps/coordinator/dist/local-ai-config.js';
import { AIRouter, AIRequestScheduler, ScheduledAIRouter, VLLMAdapter } from '../packages/ai-router/dist/index.js';

if(!process.argv[2])throw new Error('explicit local AI config file required');
const aiConfig=loadLocalAIConfig(parseEnv(readFileSync(process.argv[2],'utf8')));
const runId=`observer-${Date.now()}-${randomUUID().slice(0,8)}`;
const container=`studio-e2e-${runId}`, volume=`studio-e2e-world-${runId}`;
const dir=path.resolve('runtime-data/spark-takeover',runId);mkdirSync(dir,{recursive:true});
const report={mode:'LOCAL_TEST/E2E',world:'new disposable cached-image world',bots:1,automaticDispatch:false,
  source:'real SingleBotRuntime -> protocol -> BotRegistry -> RegistryFactReader -> TeamProposalObserver',
  model:aiConfig.model,logs:[],telemetryCounts:{},runtimeEventCounts:{},fixtureCreated:false,cleanup:false};
process.env.STUDIO_MODE='LOCAL_TEST';process.env.STUDIO_GAMEPLAY_PROFILE='standard';
process.env.STUDIO_SPAWN_ESCAPE='0';process.env.STUDIO_WORLD_MIRROR_SYNC='0';
process.env.STUDIO_SHARED_STATE_URL='http://127.0.0.1:1';delete process.env.STUDIO_SHARED_STATE_TOKEN;
delete process.env.STUDIO_INCIDENT_ENDPOINT;delete process.env.STUDIO_INCIDENT_TOKEN;
process.env.STUDIO_INCIDENT_SPOOL_PATH=path.join(dir,'incidents.jsonl');
const exec=promisify(execFile);
const docker=async(args,timeout=30000)=>(await exec('docker',args,{timeout,windowsHide:true,maxBuffer:2*1024*1024})).stdout.trim();
const wait=async(predicate,timeout)=>{const deadline=Date.now()+timeout;while(!await predicate()){if(Date.now()>deadline)throw new Error('ISOLATED_OBSERVATION_TIMEOUT');await new Promise((r)=>setTimeout(r,500));}};
const registry=new BotRegistry({staleAfterMs:15000});
const assignmentEvents=[];const assignment=new BotAssignmentService({registry,onEvent:(e)=>assignmentEvents.push(e.type)});
const reader=new RegistryFactReader({registry,assignment,bases:new BaseRegistry(),facilities:new FacilityRegistry(),workstations:new InMemoryWorkstationRegistry()});
let runtime,observer,scheduler,createdVolume=false,createdContainer=false;
const logger=Object.fromEntries(['info','warn','error'].map((level)=>[level,(event)=>{report.runtimeEventCounts[event]=(report.runtimeEventCounts[event]??0)+1;}]));
try{
  await docker(['image','inspect','studio-e2e-mc-cached:1.21.11']);
  await docker(['volume','create','--label',`studio.runId=${runId}`,volume]);createdVolume=true;
  await docker(['run','-d','--pull=never','--name',container,'--label','studio.serverKind=e2e_fixture','--label',`studio.runId=${runId}`,
    '--label',`studio.ownerSessionId=${process.pid}`,'-p','127.0.0.1::25565','-v',`${volume}:/data`,
    '-e','EULA=TRUE','-e','ONLINE_MODE=FALSE','-e','TYPE=CUSTOM','-e','CUSTOM_SERVER=/opt/server.jar','-e','MEMORY=2G',
    '-e','MODE=survival','-e','DIFFICULTY=peaceful','-e','VIEW_DISTANCE=3','-e','SIMULATION_DISTANCE=3','-e','SPAWN_PROTECTION=0',
    'studio-e2e-mc-cached:1.21.11']);createdContainer=true;report.fixtureCreated=true;
  await wait(async()=>/Done \(/.test(await docker(['logs','--tail','30',container])),180000);
  const port=Number((await docker(['port',container,'25565/tcp'])).split(':').at(-1));
  const profile=serverProfileSchema.parse({schemaVersion:'1.0',id:'isolated-observer',botId:'observer-bot',purpose:'isolated-test',
    networkScope:'loopback',host:'127.0.0.1',port,minecraftVersion:'1.21.11',username:'ObserveBot',auth:'offline',
    statusIntervalMs:1000,heartbeatIntervalMs:5000,stopGracePeriodMs:3000,reconnect:{enabled:false,maxAttempts:0,baseDelayMs:500,maxDelayMs:500}});
  runtime=new SingleBotRuntime(profile,{createClient:createMineflayerClient,logger,messageSink:(message)=>{
    report.telemetryCounts[message.type]=(report.telemetryCounts[message.type]??0)+1;
    registry.ingest(message);
  }});
  runtime.start();await wait(()=>registry.inspect()[0]?.connectionState==='online'&&registry.inspect()[0]?.skillCatalog!==null,60000);
  await docker(['exec',container,'rcon-cli','give ObserveBot minecraft:bread 1']);
  await wait(()=>registry.inspect()[0]?.currentStatus?.inventory?.some((i)=>i.itemName==='bread'&&i.count===1),15000);
  report.factsBefore=reader.read(Date.now())[0].facts;
  let disabledReads=0,disabledRequests=0;
  const disabled=new TeamProposalObserver({enabled:false,read:()=>{disabledReads++;return[];},client:{complete:async()=>{disabledRequests++;throw new Error('DISABLED_REQUEST');}},log:()=>{}});
  disabled.start();await disabled.sample();await disabled.stop();report.defaultOff={reads:disabledReads,requests:disabledRequests};
  const headers=aiConfig.apiKey?{Authorization:`Bearer ${aiConfig.apiKey}`} : {};
  const metrics=await (await fetch(`${aiConfig.baseUrl}/metrics`,{headers,signal:AbortSignal.timeout(5000)})).text();
  for(const name of ['num_requests_running','num_requests_waiting']){
    const lines=metrics.split('\n').filter((line)=>line.startsWith(`vllm:${name}{`)||line.startsWith(`vllm:${name} `));
    if(!lines.length||lines.some((line)=>Number(line.trim().split(/\s+/).at(-1))!==0))throw new Error('SPARK_NOT_IDLE');
  }
  const router=new AIRouter();router.register(new VLLMAdapter(aiConfig.baseUrl,aiConfig.model,aiConfig.apiKey));
  scheduler=new AIRequestScheduler({maxConcurrency:1,perBotConcurrency:1});
  observer=new TeamProposalObserver({enabled:true,client:scheduledRouterModelClient(new ScheduledAIRouter(router,scheduler)),
    read:(now)=>reader.read(now),log:(entry)=>report.logs.push(entry)});
  await observer.sample();await observer.stop();
  report.factsAfter=reader.read(Date.now())[0].facts;
  report.assignmentEvents=assignmentEvents;report.retainedLeases=assignment.inspect().length;
  report.taskAfter=registry.inspect()[0]?.currentStatus?.currentTask===null?'idle':'not-idle';
  report.inventoryAfter=registry.inspect()[0]?.currentStatus?.inventory;
  report.skillEvents=Object.keys(report.telemetryCounts).filter((type)=>type.includes('skill')&&!type.includes('catalog'));
  report.observationSucceeded=report.logs.length===1&&report.logs[0].accounting?.outcome==='valid-proposal'&&
    report.logs[0].verdict==='acceptable'&&report.retainedLeases===0&&assignmentEvents.length===0&&report.taskAfter==='idle';
  if(!report.observationSucceeded)process.exitCode=1;
}catch(error){report.errorCode=error.message?.includes('TIMEOUT')?'ISOLATED_OBSERVATION_TIMEOUT':'ISOLATED_OBSERVATION_FAILED';report.errorType=error.name;process.exitCode=1;}
finally{
  const cleanupErrors=[];
  await observer?.stop().catch(()=>cleanupErrors.push('observer-stop'));scheduler?.close('isolated observation complete');
  if(runtime)await runtime.stop('isolated observer teardown').catch(()=>cleanupErrors.push('runtime-stop'));
  if(createdContainer)await docker(['rm','-f',container],60000).catch(()=>cleanupErrors.push('container-remove'));
  if(createdVolume)await docker(['volume','rm',volume],30000).catch(()=>cleanupErrors.push('volume-remove'));
  report.cleanup=cleanupErrors.length===0;report.cleanupErrors=cleanupErrors;if(cleanupErrors.length)process.exitCode=1;
  writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({dir,observationSucceeded:report.observationSucceeded,errorCode:report.errorCode,cleanup:report.cleanup,logs:report.logs}));
}
