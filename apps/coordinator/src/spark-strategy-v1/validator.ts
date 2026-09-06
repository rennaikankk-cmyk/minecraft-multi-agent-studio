import { factVersion, type TeamFactsInput } from "./facts.js";
import { actionContract, type ActionContext } from "./action-contract.js";
import { teamProposalSchema, type TeamProposal } from "./proposal.js";

export type ValidatorReasonCode =
  | "SCOPE_MISMATCH" | "STALE_FACTS" | "FACTS_TOO_OLD" | "FACT_CLOCK_INVALID"
  | "EXPIRED_PROPOSAL" | "PROPOSAL_TTL_EXCEEDED" | "UNKNOWN_BOT" | "BOT_OFFLINE"
  | "UNSUPPORTED_CAPABILITY" | "UNSUPPORTED_GOAL_TEMPLATE" | "INVALID_ACTION"
  | "ACTION_RULE_UNKNOWN" | "ACTION_TARGET_UNAVAILABLE" | "INVALID_PROPOSAL"
  | "DUPLICATE_BOT_ASSIGNMENT" | "RESOURCE_DOUBLE_CLAIM" | "RESOURCE_CONFLICTS_RESERVATION"
  | "DEPENDENCY_CYCLE" | "DEPENDENCY_UNKNOWN_ID" | "PHASE_GATE_NOT_SATISFIED" | "PHASE_GATE_UNKNOWN"
  | "CONFLICTS_ACTIVE_TASK" | "TASK_STATE_UNKNOWN" | "CONTRADICTORY_FACTS"
  | "UNKNOWN_RESOURCE_REFERENCE" | "FACILITY_STATE_UNKNOWN" | "FACILITY_BUSY"
  | "NO_OBSERVABLE_SUCCESS_SIGNAL" | "UNBOUNDED_RETRY";
export type ValidatorReason = { code: ValidatorReasonCode; message: string; evidence?: string };
export type ValidationResult = {
  verdict: "acceptable" | "needs-reobservation" | "rejected";
  reasons: ValidatorReason[];
  checks: Record<string, boolean>;
};
// A 120s request deadline plus 60s queue/transport headroom. These are observation
// limits; dispatch must still obtain and atomically claim fresh execution facts.
export const DEFAULT_FACT_MAX_AGE_MS = 180_000;
export const DEFAULT_PROPOSAL_MAX_TTL_MS = 180_000;
export const DEFAULT_CLOCK_SKEW_MS = 2_000;
export type ValidatorOptions = ActionContext & {
  nowMs?: number;
  maxFactAgeMs?: number;
  maxProposalTtlMs?: number;
  allowedClockSkewMs?: number;
  supportedGoalTemplates?: ReadonlySet<string>;
};
const REOBSERVE = new Set<ValidatorReasonCode>(["FACTS_TOO_OLD", "BOT_OFFLINE", "TASK_STATE_UNKNOWN",
  "PHASE_GATE_UNKNOWN", "UNKNOWN_RESOURCE_REFERENCE", "FACILITY_STATE_UNKNOWN", "ACTION_TARGET_UNAVAILABLE"]);

export function validateProposal(proposal: TeamProposal, facts: TeamFactsInput, options: ValidatorOptions = {}): ValidationResult {
  const now = options.nowMs ?? Date.now();
  const age = options.maxFactAgeMs ?? DEFAULT_FACT_MAX_AGE_MS;
  const ttl = options.maxProposalTtlMs ?? DEFAULT_PROPOSAL_MAX_TTL_MS;
  const skew = options.allowedClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (![now, age, ttl, skew].every(Number.isSafeInteger) || now < 0 || age < 1 || ttl < 1 || skew < 0) throw new RangeError("invalid trusted validation clock/config");
  const reasons: ValidatorReason[] = [];
  const add = (code: ValidatorReasonCode, evidence: string, message = code as string) => reasons.push({ code, evidence, message });
  const parsed = teamProposalSchema.safeParse(proposal);
  if (!parsed.success) return { verdict: "rejected", reasons: [{ code: "INVALID_PROPOSAL", message: "proposal schema invalid" }], checks: { schema: false } };
  proposal = parsed.data;
  if (proposal.scope.serverProfileId !== facts.scope.serverProfileId || proposal.scope.dimension !== facts.scope.dimension) add("SCOPE_MISMATCH", "scope");
  if (proposal.factVersion !== factVersion(facts)) add("STALE_FACTS", "factVersion");
  const observed = facts.scope.observedAtMs;
  const captured = facts.capturedAtMs;
  if (observed > now + skew || captured > now + skew || observed > captured + skew || facts.events.some((e) => e.atMs > captured + skew)) add("FACT_CLOCK_INVALID", "scope.observedAtMs/capturedAtMs/events");
  if (now - observed > age || now - captured > age) add("FACTS_TOO_OLD", "scope.observedAtMs/capturedAtMs");
  if (proposal.validUntilMs <= now) add("EXPIRED_PROPOSAL", "validUntilMs");
  if (proposal.validUntilMs > captured + ttl || proposal.validUntilMs < captured - skew) add("PROPOSAL_TTL_EXCEEDED", "validUntilMs");

  const botById = new Map(facts.bots.map((b) => [b.botId, b]));
  const supported = new Set(facts.constraints.capabilities.filter((c) => c.supported).map((c) => c.skillId));
  const facilities = facts.team.facilities === "unknown" ? undefined : new Map(facts.team.facilities.map((f) => [f.facilityId, f]));
  if (botById.size !== facts.bots.length || (facts.team.facilities !== "unknown" && facilities?.size !== facts.team.facilities.length)) add("CONTRADICTORY_FACTS", "duplicate fact identities");
  const ids = new Set<string>();
  const assignedBots = new Set<string>();
  const resourceOwners = new Map<string, string>();
  for (const assignment of proposal.assignments) {
    const evidence = assignment.assignmentId;
    if (ids.has(evidence)) add("DUPLICATE_BOT_ASSIGNMENT", evidence);
    ids.add(evidence);
    const actions = [assignment.action, ...(assignment.onFailure?.alternative ? [assignment.onFailure.alternative] : [])];
    const contracts = actions.map((a) => actionContract(a, facts.scope, options));
    const actionable = actions.some((a) => a.kind !== "wait" && a.kind !== "noop");
    const bot = botById.get(assignment.botId);
    if (!bot) { add("UNKNOWN_BOT", evidence); continue; }
    if (!bot.online) add("BOT_OFFLINE", evidence);
    if (actionable) {
      if (assignedBots.has(bot.botId)) add("DUPLICATE_BOT_ASSIGNMENT", evidence);
      assignedBots.add(bot.botId);
      if (assignment.successSignals.length === 0) add("NO_OBSERVABLE_SUCCESS_SIGNAL", evidence);
      if (assignment.maxAttempts === undefined) add("UNBOUNDED_RETRY", evidence);
      const nonPreemptible = facts.constraints.nonPreemptibleBots.includes(bot.botId);
      if (nonPreemptible && (bot.currentTask === null || bot.currentTask === "unknown")) add("CONTRADICTORY_FACTS", evidence);
      if (bot.currentTask === "unknown") add("TASK_STATE_UNKNOWN", evidence);
      if (bot.currentTask !== null && bot.currentTask !== "unknown" && nonPreemptible) add("CONFLICTS_ACTIVE_TASK", evidence);
    }
    const gates = new Set(assignment.requiredGates);
    const resources = new Set(actionable ? assignment.resources : []);
    for (let i = 0; i < contracts.length; i++) {
      const contract = contracts[i]!;
      const action = actions[i]!;
      const actionEvidence = `${evidence}:${i === 0 ? "action" : "alternative"}`;
      if (contract.issue) add(contract.issue, actionEvidence);
      if (action.kind === "deterministicGoal" && options.supportedGoalTemplates && !options.supportedGoalTemplates.has(action.template)) add("UNSUPPORTED_GOAL_TEMPLATE", actionEvidence);
      for (const skill of contract.skillIds) if (!supported.has(skill)) add("UNSUPPORTED_CAPABILITY", `${actionEvidence}:${skill}`);
      for (const gate of contract.gates) gates.add(gate);
      for (const resource of contract.resources) resources.add(resource);
    }
    for (const name of gates) {
      const relevant = facts.constraints.phaseGates.filter((g) => g.gate === name && (g.botId === undefined || g.botId === bot.botId));
      if (new Set(relevant.map((g) => g.satisfied)).size > 1) add("CONTRADICTORY_FACTS", `${evidence}:${name}`);
      if (relevant.length === 0) add(assignment.requiredGates.includes(name) ? "PHASE_GATE_NOT_SATISFIED" : "PHASE_GATE_UNKNOWN", `${evidence}:${name}`);
      else if (relevant.some((g) => g.satisfied === false)) add("PHASE_GATE_NOT_SATISFIED", `${evidence}:${name}`);
      else if (relevant.some((g) => g.satisfied === "unknown")) add("PHASE_GATE_UNKNOWN", `${evidence}:${name}`);
    }
    for (const resource of resources) {
      const owner = resourceOwners.get(resource);
      if (owner && owner !== evidence) add("RESOURCE_DOUBLE_CLAIM", resource);
      resourceOwners.set(resource, evidence);
      const reservations = facts.team.reservedResources.filter((r) => r.resource === resource);
      if (new Set(reservations.map((r) => r.heldByBotId)).size > 1) add("CONTRADICTORY_FACTS", resource);
      if (reservations.some((r) => r.heldByBotId !== bot.botId)) add("RESOURCE_CONFLICTS_RESERVATION", resource);
      const facility = facilities?.get(resource);
      if (!facility) { add("UNKNOWN_RESOURCE_REFERENCE", resource); continue; }
      if (facility.status === "unknown") add("FACILITY_STATE_UNKNOWN", resource);
      if (facility.status === "available" && facility.heldByBotId) add("CONTRADICTORY_FACTS", resource);
      if (facility.status === "busy") {
        const holders = new Set([...(facility.heldByBotId ? [facility.heldByBotId] : []), ...reservations.map((r) => r.heldByBotId)]);
        if (holders.size === 0) add("FACILITY_STATE_UNKNOWN", resource);
        else if (holders.size > 1) add("CONTRADICTORY_FACTS", resource);
        else if (!holders.has(bot.botId)) add("FACILITY_BUSY", resource);
      }
    }
  }
  // Kahn's algorithm bounds traversal without recursive stack growth.
  const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
  const incoming = new Map([...ids].map((id) => [id, 0]));
  for (const edge of proposal.dependencies) {
    if (!ids.has(edge.afterId) || !ids.has(edge.beforeId)) { add("DEPENDENCY_UNKNOWN_ID", "dependencies"); continue; }
    outgoing.get(edge.beforeId)!.push(edge.afterId);
    incoming.set(edge.afterId, incoming.get(edge.afterId)! + 1);
  }
  const queue = [...ids].filter((id) => incoming.get(id) === 0);
  for (let i = 0; i < queue.length; i++) for (const next of outgoing.get(queue[i]!)!) {
    incoming.set(next, incoming.get(next)! - 1);
    if (incoming.get(next) === 0) queue.push(next);
  }
  if (queue.length !== ids.size) add("DEPENDENCY_CYCLE", "dependencies");
  const absent = (...codes: ValidatorReasonCode[]) => !reasons.some((r) => codes.includes(r.code));
  return {
    verdict: reasons.some((r) => !REOBSERVE.has(r.code)) ? "rejected" : reasons.length ? "needs-reobservation" : "acceptable",
    reasons,
    checks: {
      schema: true, scopeMatch: absent("SCOPE_MISMATCH"), factVersionMatch: absent("STALE_FACTS"),
      factsFresh: absent("FACTS_TOO_OLD", "FACT_CLOCK_INVALID"), notExpired: absent("EXPIRED_PROPOSAL", "PROPOSAL_TTL_EXCEEDED"),
      botsKnown: absent("UNKNOWN_BOT", "BOT_OFFLINE"), observableSignals: absent("NO_OBSERVABLE_SUCCESS_SIGNAL"), boundedRetry: absent("UNBOUNDED_RETRY"),
      mutualExclusion: absent("DUPLICATE_BOT_ASSIGNMENT"), noResourceDoubleClaim: absent("RESOURCE_DOUBLE_CLAIM"), noReservationConflict: absent("RESOURCE_CONFLICTS_RESERVATION", "FACILITY_BUSY"),
      dependenciesKnown: absent("DEPENDENCY_UNKNOWN_ID"), noDependencyCycle: absent("DEPENDENCY_CYCLE"),
      noUnsupportedCapability: absent("UNSUPPORTED_CAPABILITY", "INVALID_ACTION", "ACTION_RULE_UNKNOWN", "UNSUPPORTED_GOAL_TEMPLATE"),
      noPhaseGateIssue: absent("PHASE_GATE_NOT_SATISFIED", "PHASE_GATE_UNKNOWN"), noActiveTaskConflict: absent("CONFLICTS_ACTIVE_TASK", "TASK_STATE_UNKNOWN", "CONTRADICTORY_FACTS"),
      noUnknownFactReference: absent("UNKNOWN_RESOURCE_REFERENCE", "FACILITY_STATE_UNKNOWN", "ACTION_TARGET_UNAVAILABLE"),
    },
  };
}
