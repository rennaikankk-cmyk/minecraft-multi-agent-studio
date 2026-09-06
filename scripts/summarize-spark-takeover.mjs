import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.argv[2]??'runtime-data/spark-takeover');
const reports=readdirSync(root,{withFileTypes:true}).filter((entry)=>entry.isDirectory()).flatMap((entry)=>{
  try{return[{id:entry.name,...JSON.parse(readFileSync(path.join(root,entry.name,'report.json'),'utf8'))}];}catch{return[];}
});
const rows=reports.filter((r)=>r.samples?.length).map((r)=>{
  const completed=r.samples.filter((s)=>['valid-proposal','parse-failed','complete'].includes(s.accounting.outcome));
  const successfulLatency=completed.map((s)=>s.accounting.clientLatencyMs).sort((a,b)=>a-b);
  const p=(f)=>successfulLatency[Math.max(0,Math.ceil(successfulLatency.length*f)-1)]??null;
  const errors={};for(const s of r.samples)if(s.accounting.errorCode)errors[s.accounting.errorCode]=(errors[s.accounting.errorCode]??0)+1;
  return {id:r.id,mode:r.mode,level:r.level,botCount:r.botCount,attempts:r.samples.length,completedResponses:completed.length,
    parsed:r.samples.filter((s)=>s.score?.parsed).length,accepted:r.samples.filter((s)=>s.score?.accepted).length,
    behaviorMatched:r.samples.filter((s)=>s.score?.behaviorMatch).length,wrongAccepted:r.samples.filter((s)=>s.score?.wrongAcceptedAction).length,
    incorrectWait:r.samples.filter((s)=>s.score?.incorrectWait).length,parseFailed:r.samples.filter((s)=>s.accounting.outcome==='parse-failed').length,
    lengthFinish:r.samples.filter((s)=>s.accounting.finishReason==='length').length,errors,
    p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99),durationMs:r.durationMs,completedPerMinute:completed.length*60000/r.durationMs,
    promptTokens:completed.reduce((n,s)=>n+(s.accounting.usage?.promptTokens??0),0),completionTokens:completed.reduce((n,s)=>n+(s.accounting.usage?.completionTokens??0),0),
    maxQueueMs:Math.max(0,...completed.map((s)=>s.accounting.schedulerTimings?.queueTimeMs??0)),
    maxServerRunning:Math.max(...r.metrics.map((m)=>m.num_requests_running??0)),maxServerWaiting:Math.max(...r.metrics.map((m)=>m.num_requests_waiting??0)),
    maxKvFraction:Math.max(...r.metrics.map((m)=>m.kv_cache_usage_perc??0)),
    preemptionDelta:(r.metrics.at(-1)?.num_preemptions_total??0)-(r.metrics[0]?.num_preemptions_total??0),
    servicePromptDelta:(r.metrics.at(-1)?.prompt_tokens_total??0)-(r.metrics[0]?.prompt_tokens_total??0),
    serviceCompletionDelta:(r.metrics.at(-1)?.generation_tokens_total??0)-(r.metrics[0]?.generation_tokens_total??0),
    negativeControls:r.negativeControls,stopReasons:r.stopReasons};
});
const isolated=reports.filter((r)=>r.mode==='LOCAL_TEST/E2E').map((r)=>({id:r.id,success:r.observationSucceeded,cleanup:r.cleanup,
  defaultOff:r.defaultOff,telemetryCounts:r.telemetryCounts,assignmentEvents:r.assignmentEvents,retainedLeases:r.retainedLeases,
  taskAfter:r.taskAfter,inventoryAfter:r.inventoryAfter,skillEvents:r.skillEvents,logs:r.logs}));
const totals={submitted:rows.reduce((n,r)=>n+r.attempts,0)+isolated.reduce((n,r)=>n+r.logs.length,0),
  fullResponses:rows.reduce((n,r)=>n+r.completedResponses,0)+isolated.reduce((n,r)=>n+r.logs.filter((l)=>l.accounting?.outcome==='valid-proposal').length,0),
  promptTokensReported:rows.reduce((n,r)=>n+r.promptTokens,0)+isolated.reduce((n,r)=>n+r.logs.reduce((m,l)=>m+(l.accounting?.usage?.promptTokens??0),0),0),
  completionTokensReported:rows.reduce((n,r)=>n+r.completionTokens,0)+isolated.reduce((n,r)=>n+r.logs.reduce((m,l)=>m+(l.accounting?.usage?.completionTokens??0),0),0)};
const fairnessDir=path.join(root,'offline-fairness-20260906');
const offlineFairness=readdirSync(fairnessDir).filter((file)=>file.endsWith('.json')).map((file)=>JSON.parse(readFileSync(path.join(fairnessDir,file),'utf8')));
const summary={generatedAt:new Date().toISOString(),rows,isolated,totals,offlineFairness,
  limitations:['Aborted live requests do not expose per-request usage. Service counters include all callers and asynchronous metric updates.',
    'Throughput counts complete responses, not cancellation settlements. Failed mixed-run historical summary counted settlements; this corrected aggregation preserves that original artifact.',
    'Behavior match scores primary action/wait decisions, not free-text preconditions or proof that a Minecraft action succeeded.',
    'Capacity inputs are synthetic; only the isolated observation uses a real Minecraft Bot. TTFT and first structured decision time unavailable.']};
writeFileSync(path.join(root,'final-summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
