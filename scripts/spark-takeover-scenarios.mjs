import { parseTeamFactsInput, factVersion } from '../apps/coordinator/dist/spark-strategy-v1/facts.js';
import { validateProposal } from '../apps/coordinator/dist/spark-strategy-v1/validator.js';

export const scenarioNames = ['food', 'materials', 'repeated-failure', 'reasonable-wait', 'active-conflict', 'unknown-task', 'stale-facts', 'resource-conflict'];
export function scenario(name, now, suffix = '') {
  const facts = parseTeamFactsInput({
    scope: { serverProfileId: 'eval-isolated', dimension: 'minecraft:overworld', observedAtMs: now - 1000 }, capturedAtMs: now,
    bots: ['B01', 'B02'].map((botId) => ({ botId: botId + suffix, online: true, currentTask: null,
      survival: { health: 20, food: 20, armorPoints: 8 }, inventory: [
        { itemName: 'bread', count: 16 }, { itemName: 'stone_pickaxe', count: 1 }, { itemName: 'oak_log', count: 8 },
        { itemName: 'cobblestone', count: 24 }, { itemName: 'wheat_seeds', count: 16 }, { itemName: 'torch', count: 12 },
      ], deaths: 'unknown' })),
    team: { sharedInventory: 'unknown', facilities: [{ facilityId: 'station-alpha', kind: 'furnace', status: 'available' }],
      shortages: [], reservedResources: [] },
    events: [{ kind: 'completion', source: 'test-receipt', atMs: now - 2000, botId: 'B01' + suffix,
      detail: 'Earlier deterministic material collection completed. No task is currently authorized by this history.' }],
    constraints: { capabilities: ['food.secure', 'world.scan', 'collect.block', 'craft.item', 'container.transfer', 'movement.goto'].map((skillId) => ({skillId, supported:true})),
      phaseGates: ['BASE_SITE_RESERVED', 'STARTER_BASE_ACTIVE', 'VILLAGE_SOURCE_VERIFIED'].map((gate) => ({gate, satisfied: 'unknown'})),
      nonPreemptibleBots: [], allowedChangeScope: 'Read-only team suggestions. Preserve active tasks, reservations, seed stock and equipment. No coordinates. Never infer production from a discovered block. L0 safety and combat remain deterministic. Review observed shortages, otherwise preserve stable operation; do not invent work to consume resources.' },
  });
  const bot = facts.bots[0];
  if (name === 'food') { bot.survival.food = 8; bot.inventory = [{itemName:'bread',count:1}]; facts.team.shortages = [`${bot.botId}: portable food inventory below 8 items; obtain portable food`]; }
  if (name === 'materials') { facts.team.shortages = [`${bot.botId}: upcoming structure lacks 32 cobblestone; collect stone for cobblestone drops with maxCount=32,maxDistance=32; no construction permission`]; bot.inventory = [{itemName:'stone_pickaxe',count:1},{itemName:'bread',count:16}]; }
  if (name === 'repeated-failure') {
    facts.team.shortages = ['stone collection repeatedly failed; inspect or wait for fresh route evidence, do not repeat same collection'];
    for (let i = 0; i < 3; i++) facts.events.push({kind:'failure', source:'test-receipt', botId:bot.botId, atMs:now-10000+i*1000, detail:'collect.block stone failed: no reachable target; retry budget exhausted'});
  }
  if (name === 'active-conflict') { bot.currentTask = {goalText:'existing-harvest',phase:'running'}; facts.constraints.nonPreemptibleBots = [bot.botId]; facts.team.shortages = ['preserve current harvest until receipt']; }
  if (name === 'unknown-task') { bot.currentTask = 'unknown'; facts.team.shortages = ['task ownership is unknown; wait for status reconciliation']; }
  if (name === 'stale-facts') { facts.scope.observedAtMs -= 86400000; facts.capturedAtMs -= 86400000; facts.events = []; }
  if (name === 'resource-conflict') {
    facts.team.facilities[0].status = 'busy'; facts.team.facilities[0].heldByBotId = 'outside-owner';
    facts.team.reservedResources = [{resource:'station-alpha',heldByBotId:'outside-owner'}];
    facts.team.shortages = ['Both Bots need the single busy furnace for later production; preserve its existing outside-owner lease and wait'];
  }
  const context = {targets:new Map([['station-alpha',{serverProfileId:facts.scope.serverProfileId,dimension:facts.scope.dimension,x:0,y:64,z:0}]])};
  return {name, facts, context};
}
export function scoreScenario(sample, proposal, now) {
  const validation = proposal ? validateProposal(proposal, sample.facts, {...sample.context, nowMs:now}) : null;
  const first = proposal?.assignments.find((a) => a.botId === sample.facts.bots[0].botId);
  const action = first?.action;
  const passive = action?.kind === 'wait' || action?.kind === 'noop';
  const actions = proposal?.assignments.map((a) => a.action) ?? [];
  const allPassive = actions.length > 0 && actions.every((a) => a.kind === 'wait' || a.kind === 'noop');
  let expected = false;
  switch(sample.name) {
    case 'food': expected = action?.kind === 'skill' && action.skillId === 'food.secure'; break;
    case 'materials': expected = action?.kind === 'skill' && action.skillId === 'collect.block' && action.params.blockName === 'stone' && action.params.maxCount === 32; break;
    case 'repeated-failure': expected = passive || (action?.kind === 'skill' && action.skillId === 'world.scan'); break;
    case 'stale-facts': expected = allPassive && validation?.verdict !== 'acceptable'; break;
    case 'active-conflict': case 'unknown-task': expected = passive; break;
    default: expected = allPassive;
  }
  const accepted = validation?.verdict === 'acceptable';
  const actualBehaviorMatch = expected && (sample.name === 'stale-facts' || accepted);
  return { verdict: validation?.verdict ?? 'unavailable', reasonCodes: validation?.reasons.map((r) => r.code) ?? [],
    parsed: proposal !== null, accepted, behaviorMatch: actualBehaviorMatch,
    wrongAcceptedAction: accepted && !expected && actions.some((a) => a.kind !== 'wait' && a.kind !== 'noop'),
    incorrectWait: passive && ['food','materials'].includes(sample.name),
    conflictPreserved: ['active-conflict','resource-conflict'].includes(sample.name) ? expected : null };
}
export function negativeControls(now) {
  return ['active-conflict', 'unknown-task', 'stale-facts', 'resource-conflict'].map((name) => {
    const sample = scenario(name, now);
    const proposal = {proposalId:'control', factVersion:factVersion(sample.facts),scope:sample.facts.scope,
      validUntilMs:now+30000,generatedBy:'offline-control',objective:'intentionally unsafe counterexample',assignments:[{
        assignmentId:'a',botId:'B01',role:'forager', action:{kind:'skill',skillId:'food.secure',params:{targetCount:16}},
        resources:name==='resource-conflict'?['station-alpha']:[],successSignals:['food reaches 16'],maxAttempts:1,
      }]};
    const result = validateProposal(proposal,sample.facts,{...sample.context,nowMs:now});
    return {name,verdict:result.verdict,reasonCodes:result.reasons.map((r)=>r.code),wrongAccepted:result.verdict==='acceptable'};
  });
}
