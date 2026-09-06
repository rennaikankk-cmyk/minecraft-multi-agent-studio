import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AIRouter, AIRequestScheduler, ScheduledAIRouter, VLLMAdapter, aiRequestPriorities } from '../packages/ai-router/dist/index.js';
import { loadLocalAIConfig } from '../apps/coordinator/dist/local-ai-config.js';
import { buildSituationSummary } from '../apps/coordinator/dist/spark-strategy-v1/summary.js';
import { askTeamProposal, scheduledRouterModelClient } from '../apps/coordinator/dist/spark-strategy-v1/model-client.js';
import { TEAM_OBSERVER_SYSTEM } from '../apps/coordinator/dist/spark-strategy-v1/observer.js';
import { scenario, scenarioNames, scoreScenario, negativeControls } from './spark-takeover-scenarios.mjs';

const mode = process.argv[2];
if (!['inspect','serial','capacity','mixed'].includes(mode)) throw new Error('explicit inspect/serial/capacity/mixed required');
const config = loadLocalAIConfig();
if (config.provider !== 'vllm' || !config.baseUrl || !config.model) throw new Error('verified vLLM configuration required');
const level = Number(process.argv[3] ?? 1);
if (!Number.isInteger(level) || level < 1 || level > 4) throw new Error('level outside verified boundary');
const botCount = Number(process.argv[4] ?? 5);
if (mode === 'mixed' && ![5,10].includes(botCount)) throw new Error('mixed Bot-ID count');
const dir = path.resolve('runtime-data/spark-takeover', `${Date.now()}-${mode}-${level}-${randomUUID().slice(0,8)}`);
mkdirSync(dir,{recursive:true});
const headers = config.apiKey ? {Authorization:`Bearer ${config.apiKey}`} : {};
const began = Date.now();
const report = {mode, level, botCount:mode==='mixed'?botCount:null, model:config.model,
  configuredCoordinator:{maxConcurrency:config.maxConcurrency,perBotConcurrency:config.perBotConcurrency,requestTimeoutMs:config.requestTimeoutMs},
  productionProcess:'not-attached-to-this-evaluation', source:'MEASURED client; SOURCE-REPORTED vLLM usage/finish/metrics',
  inputKind:'synthetic scoped planning workload, no Minecraft connection',automaticDispatch:false,
  budget:'docs/spark-strategy-v1/LIVE_BUDGET_2026-09-06.md',ttftMs:'unavailable',firstStructuredDecisionMs:'unavailable',samples:[],metrics:[],stopReasons:[]};
const save = () => writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
async function metrics() {
  const response = await fetch(`${config.baseUrl}/metrics`,{headers,signal:AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error('METRICS_UNAVAILABLE');
  const text = await response.text();
  const out = {atMs:Date.now()};
  for (const key of ['num_requests_running','num_requests_waiting','kv_cache_usage_perc','gpu_cache_usage_perc','num_preemptions_total','prompt_tokens_total','generation_tokens_total']) {
    const lines = text.split('\n').filter((line) => line.startsWith(`vllm:${key}{`) || line.startsWith(`vllm:${key} `));
    out[key] = lines.length ? lines.reduce((sum,line)=>sum+Number(line.trim().split(/\s+/).at(-1)),0) : null;
  }
  report.metrics.push(out); return out;
}
const modelsResponse = await fetch(`${config.baseUrl}/v1/models`,{headers,signal:AbortSignal.timeout(5000)});
if (!modelsResponse.ok) throw new Error('MODELS_UNAVAILABLE');
const advertised = (await modelsResponse.json()).data.map((m)=>m.id);
if (!advertised.includes(config.model)) throw new Error('MODEL_ID_MISMATCH');
report.advertisedModels = advertised;
const initial = await metrics();
if (mode === 'inspect') { save(); console.log(JSON.stringify({dir,...report})); process.exit(0); }
if (initial.num_requests_running !== 0 || initial.num_requests_waiting !== 0) { report.stopReasons.push('SERVICE_NOT_IDLE'); save(); console.log(JSON.stringify({dir,stopReasons:report.stopReasons})); process.exit(2); }
const router = new AIRouter(); router.register(new VLLMAdapter(config.baseUrl,config.model,config.apiKey));
const events = [];
const scheduler = new AIRequestScheduler({maxConcurrency:mode==='serial'?1:level,perBotConcurrency:1,maxQueue:64,defaultTimeoutMs:120000,
  onEvent:(event)=>events.push({...event,atMs:Date.now()})});
const scheduled = new ScheduledAIRouter(router,scheduler);
const client = scheduledRouterModelClient(scheduled);
let waitingSamples = 0, polling = false;
const timer = setInterval(async()=>{
  if (polling) return; polling=true;
  try {
    const current = await metrics();
    waitingSamples = current.num_requests_waiting > 0 ? waitingSamples + 1 : 0;
    if (waitingSamples >= 3) report.stopReasons.push('SUSTAINED_SERVER_QUEUE');
    if (current.num_preemptions_total > initial.num_preemptions_total) report.stopReasons.push('PREEMPTIONS_INCREASED');
    if (current.num_requests_running > scheduler.snapshot().running) report.stopReasons.push('POSSIBLE_EXTERNAL_INTERFERENCE');
    if (Date.now()-began>45*60_000) report.stopReasons.push('WALL_BUDGET');
    if (report.stopReasons.length) scheduler.close('evaluation stop condition');
  } catch { report.stopReasons.push('METRICS_POLL_FAILED'); scheduler.close('metrics unavailable'); }
  finally { polling=false; }
},2000);
async function planning(name,index,priority=aiRequestPriorities.background,botId=`planning-client-${index}`) {
  const sample = scenario(name,Date.now(),`-${index}`);
  const summary = buildSituationSummary(sample.facts);
  const prompt = `${summary.text}\nPROPOSAL_EXPIRY=${sample.facts.capturedAtMs+180000}`;
  if ((TEAM_OBSERVER_SYSTEM.length+prompt.length)/4>8000) throw new Error('PREFLIGHT_INPUT_BUDGET');
  const requestId = `takeover-${mode}-${index}-${randomUUID()}`;
  const requestedAtMs=Date.now();
  const result=await askTeamProposal({client,request:{requestId,botId,priority,system:TEAM_OBSERVER_SYSTEM,prompt,maxTokens:3000,
    timeoutMs:priority===aiRequestPriorities.planning?45000:120000,temperature:0}});
  const score=scoreScenario(sample,result.proposal,Date.now());
  const row={scenario:name,index,botId,priority,requestedAtMs,completedAtMs:Date.now(),promptChars:prompt.length,systemChars:TEAM_OBSERVER_SYSTEM.length,
    accounting:{...result.accounting,detail:undefined},score,proposal:result.proposal};
  report.samples.push(row); appendFileSync(path.join(dir,'samples.jsonl'),JSON.stringify(row)+'\n');
  if (result.accounting.outcome==='request-failed'||result.accounting.outcome==='cancelled') report.stopReasons.push('REQUEST_ERROR');
  if (result.accounting.outcome==='parse-failed') report.stopReasons.push('PARSE_FAILED');
  if (result.accounting.finishReason==='length') report.stopReasons.push('TRUNCATION');
  if (score.wrongAcceptedAction) report.stopReasons.push('WRONG_ACTION_ACCEPTED');
  if ((result.accounting.usage?.promptTokens??0)>8000) report.stopReasons.push('INPUT_TOKEN_BUDGET');
  console.log(JSON.stringify({index,scenario:name,outcome:result.accounting.outcome,...score,latencyMs:result.accounting.clientLatencyMs}));
  return row;
}
async function chat(index) {
  const start=Date.now(); const botId=`mixed-bot-${index}`;
  try {
    const result=await scheduled.generate({requestId:`chat-${randomUUID()}`,botId,priority:aiRequestPriorities.chat,
      systemPrompt:'You are a Minecraft logistics assistant. Give a concise factual response in two sentences. Do not invent world facts or issue game commands.',
      prompt:'The observed player inventory has 16 bread, 8 oak logs, a stone pickaxe, and 12 torches. A furnace is currently leased by another worker and farm production is unverified. Explain which supplies can support the next short scouting trip and what needs fresh observation before relying on a base. Do not assume shared storage contents.',
      maxTokens:384,temperature:0,timeoutMs:15000,traceId:'mixed-chat'});
    report.samples.push({scenario:'chat',index,botId,priority:aiRequestPriorities.chat,accounting:{outcome:'complete',clientLatencyMs:Date.now()-start,
      finishReason:result.value.finishReason??'unknown',usage:result.value.usage,schedulerTimings:{queueTimeMs:result.queueTimeMs,executionTimeMs:result.executionTimeMs,totalTimeMs:result.totalTimeMs,attempts:result.attempts}},text:result.value.content});
    if(result.value.finishReason==='length')report.stopReasons.push('CHAT_TRUNCATION');
  }catch(error){report.samples.push({scenario:'chat',index,botId,accounting:{outcome:'request-failed',errorCode:error.code??'ERROR',clientLatencyMs:Date.now()-start}});report.stopReasons.push('CHAT_ERROR');}
}
try {
  report.negativeControls=negativeControls(Date.now());
  if(report.negativeControls.some((c)=>c.wrongAccepted))throw new Error('NEGATIVE_CONTROL_ACCEPTED');
  if(mode==='serial') await planning('food',0);
  else if(mode==='capacity') {
    for(let i=0;i<scenarioNames.length;i+=level){
      const settled=await Promise.allSettled(scenarioNames.slice(i,i+level).map((name,j)=>planning(name,i+j)));
      if(settled.some((r)=>r.status==='rejected'))report.stopReasons.push('JOB_FAILED');
      if(report.stopReasons.length)break;
    }
  }else{
    const jobs=[];
    for(let i=0;i<botCount;i++)jobs.push(planning(i%2===0?'food':'reasonable-wait',i,aiRequestPriorities.planning,`mixed-bot-${i}`));
    for(let i=0;i<3;i++)jobs.push(chat(i));
    jobs.push(planning('active-conflict',botCount,aiRequestPriorities.background,'team-strategy-observer'));
    const settled=await Promise.allSettled(jobs); if(settled.some((r)=>r.status==='rejected'))report.stopReasons.push('JOB_FAILED');
  }
}catch(error){report.stopReasons.push(error.message?.startsWith('NEGATIVE')?error.message:'HARNESS_FAILED');}
finally{
  clearInterval(timer); while(polling)await new Promise((r)=>setTimeout(r,20));
  scheduler.close('evaluation complete');
  await metrics().catch(()=>report.stopReasons.push('FINAL_METRICS_FAILED'));
  report.events=events; report.durationMs=Date.now()-began;report.stopReasons=[...new Set(report.stopReasons)];
  const latencies=report.samples.map((s)=>s.accounting.clientLatencyMs).filter(Number.isFinite).sort((a,b)=>a-b);
  const p=(fraction)=>latencies[Math.max(0,Math.ceil(latencies.length*fraction)-1)]??null;
  report.summary={samples:report.samples.length,parsed:report.samples.filter((s)=>s.score?.parsed).length,
    accepted:report.samples.filter((s)=>s.score?.accepted).length,behaviorMatched:report.samples.filter((s)=>s.score?.behaviorMatch).length,
    incorrectWait:report.samples.filter((s)=>s.score?.incorrectWait).length,wrongAcceptedAction:report.samples.filter((s)=>s.score?.wrongAcceptedAction).length,
    p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99),attemptSettlementsPerMinute:report.samples.length*60000/report.durationMs,
    throughputRequestsPerMinute:report.samples.filter((s)=>['valid-proposal','parse-failed','complete'].includes(s.accounting.outcome)).length*60000/report.durationMs,
    promptTokens:report.samples.reduce((n,s)=>n+(s.accounting.usage?.promptTokens??0),0),completionTokens:report.samples.reduce((n,s)=>n+(s.accounting.usage?.completionTokens??0),0)};
  save();console.log(JSON.stringify({dir,summary:report.summary,stopReasons:report.stopReasons}));
}
if(report.stopReasons.length)process.exitCode=2;
