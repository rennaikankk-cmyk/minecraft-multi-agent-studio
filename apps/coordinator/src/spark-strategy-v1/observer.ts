import { randomUUID } from "node:crypto";
import { z } from "zod";
import { aiRequestPriorities } from "@minecraft-studio/ai-router";
import { builtinSkills } from "@minecraft-studio/skills";
import { buildSituationSummary } from "./summary.js";
import { askTeamProposal, type ModelClient } from "./model-client.js";
import { teamProposalSchema } from "./proposal.js";
import { validateProposal } from "./validator.js";
import { reviewedSkills, type Observation } from "./registry-facts.js";

const trustedFields = new Set(["serverProfileId", "dimension", "target", "container", "craftingTable", "anchor"]);
const skillContracts = builtinSkills.filter((skill) => reviewedSkills.includes(skill.id)).map((skill) => {
  const schema = z.toJSONSchema(skill.inputSchema) as { properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
  schema.properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => !trustedFields.has(key)));
  schema.required = schema.required?.filter((key) => !trustedFields.has(key)) ?? [];
  delete schema.$schema;
  return { skillId: skill.id, paramsSchema: schema,
    targetRefRequired: ["container.transfer", "movement.goto"].includes(skill.id) };
});

export const TEAM_OBSERVER_SYSTEM = [
  "You are a read-only Minecraft team planning reviewer. Return exactly one JSON object, no reasoning or Markdown.",
  "Use only the supplied opaque Bot/scope/resource references, available capabilities and truthful facts. Never invent coordinates, inventory, gates, facility production, or deaths.",
  "Preserve active tasks and reservations. An idle Bot with a food shortage may use food.secure(targetCount=16); reasonable waiting preserves active work. Unknown facts require observation or wait; do not propose construction from unknown gates.",
  "container.transfer only deposits/withdraws at a known container targetRef; it cannot transfer items directly between Bots. Inventory item names/counts are not resource references. resources must only contain listed facility references. Do not invent parameter names; use SKILL_CONTRACTS exactly. Scope and positions are supplied by trusted code, never in params.",
  "Use skill actions only from the reviewed capabilities or wait/noop. maxAttempts must be bounded, successSignals observable, and onFailure wait/escalate. Alternative actions undergo the same validation. No combat reflex or safety changes.",
  "Copy factVersion and scope exactly. validUntilMs must equal the supplied PROPOSAL_EXPIRY. Do not treat suggestions as execution permission.",
  `OUTPUT_SCHEMA=${JSON.stringify(z.toJSONSchema(teamProposalSchema))}`,
  `SKILL_CONTRACTS=${JSON.stringify(skillContracts)}`,
].join("\n");

export function teamObserverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.STUDIO_TEAM_STRATEGY_PROPOSAL?.trim();
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error("STUDIO_TEAM_STRATEGY_PROPOSAL must be 0 or 1");
}

export class TeamProposalObserver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private lastRequestMs = -Infinity;
  private readonly seen = new Map<string, { key: string; at: number }>();
  constructor(private readonly options: {
    enabled: boolean;
    client: ModelClient;
    read: (nowMs: number) => Observation[];
    log: (entry: Record<string, unknown>) => void;
    now?: () => number;
    intervalMs?: number;
    cooldownMs?: number;
  }) {
    if ((options.intervalMs ?? 60_000) < 1_000 || (options.cooldownMs ?? 180_000) < 1_000) throw new Error("OBSERVER_INTERVAL_INVALID");
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  start(): void {
    if (!this.options.enabled || this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.sample(); }, this.options.intervalMs ?? 60_000);
    this.timer.unref?.();
  }
  sample(): Promise<void> {
    if (!this.options.enabled || this.stopped || this.inFlight) return Promise.resolve();
    if (this.now() - this.lastRequestMs < (this.options.cooldownMs ?? 180_000)) return Promise.resolve();
    this.inFlight = this.run().catch(() => this.emit({ outcome: "observation-failed", code: "OBSERVER_FAILED" }))
      .finally(() => { this.inFlight = null; this.controller = null; });
    return this.inFlight;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.inFlight;
  }
  private emit(entry: Record<string, unknown>): void {
    try { this.options.log({ mode: "read-only", automaticDispatch: false, ...entry }); } catch { /* Logging cannot control execution. */ }
  }
  private async run(): Promise<void> {
    const now = this.now();
    const observations = this.options.read(now);
    if (observations.length > 32) throw new Error("OBSERVER_SCOPE_CAPACITY");
    for (const [scope, seen] of this.seen) if (now - seen.at > 30 * 60_000) this.seen.delete(scope);
    const selected = observations.filter((o) => this.seen.get(o.scopeKey)?.key !== o.contentKey)
      .sort((a, b) => (this.seen.get(a.scopeKey)?.at ?? -1) - (this.seen.get(b.scopeKey)?.at ?? -1))[0];
    if (!selected) return;
    if (this.seen.size >= 32 && !this.seen.has(selected.scopeKey)) throw new Error("OBSERVER_CACHE_CAPACITY");
    this.seen.set(selected.scopeKey, { key: selected.contentKey, at: now });
    const summary = buildSituationSummary(selected.facts, { nowMs: now });
    if (!selected.facts.bots.some((bot) => bot.online) || now - selected.facts.scope.observedAtMs > 180_000) {
      this.emit({ outcome: "observation-unavailable", factVersion: summary.factVersion, code: "NO_FRESH_ONLINE_FACTS" });
      return;
    }
    this.lastRequestMs = now;
    this.controller = new AbortController();
    const requestId = `team-observer-${randomUUID()}`;
    const result = await askTeamProposal({ client: this.options.client, request: {
      requestId, botId: "team-strategy-observer", priority: aiRequestPriorities.background,
      system: TEAM_OBSERVER_SYSTEM, prompt: `${summary.text}\nPROPOSAL_EXPIRY=${selected.facts.capturedAtMs + 180_000}`,
      timeoutMs: 120_000, maxTokens: 3000, temperature: 0, signal: this.controller.signal,
    } });
    const validated = result.proposal ? validateProposal(result.proposal, selected.facts, { ...selected.context, nowMs: this.now() }) : null;
    let current: Observation | undefined;
    try { if (!this.stopped) current = this.options.read(this.now()).find((o) => o.scopeKey === selected.scopeKey); } catch { /* Keep request accounting when reobservation fails. */ }
    const unchanged = current?.contentKey === selected.contentKey;
    // Only closed-schema metadata enters centralized logs. Model prose is untrusted and may echo private data.
    this.emit({ factVersion: summary.factVersion, scopeRef: selected.scopeKey, requestId,
      accounting: { ...result.accounting, detail: undefined },
      verdict: this.stopped ? "cancelled" : !unchanged ? "needs-reobservation" : validated?.verdict ?? "unavailable",
      reasonCodes: [...(validated?.reasons.map((r) => r.code) ?? []), ...(!unchanged ? ["CONTENT_CHANGED_OR_SCOPE_RETIRED"] : [])],
      validUntilMs: result.proposal?.validUntilMs ?? null,
      suggestions: result.proposal?.assignments.map((assignment) => ({
        botRef: selected.facts.bots.some((b) => b.botId === assignment.botId) ? assignment.botId : "unknown-bot",
        kind: assignment.action.kind,
        skillId: assignment.action.kind === "skill" && selected.facts.constraints.capabilities.map((c) => c.skillId).includes(assignment.action.skillId)
          ? assignment.action.skillId : undefined,
        params: assignment.action.kind === "skill" ? Object.fromEntries(Object.entries(assignment.action.params).filter(([key, value]) =>
          (["targetCount", "maxCount", "maxDistance", "count", "radius"].includes(key) && typeof value === "number") ||
          (["itemName", "blockName", "direction"].includes(key) && typeof value === "string" && /^[a-z0-9_]{1,80}$/.test(value)))) : undefined,
        targetRef: "targetRef" in assignment.action && assignment.action.targetRef && selected.context.targets?.has(assignment.action.targetRef)
          ? assignment.action.targetRef : undefined,
        resources: assignment.resources.filter((ref) => selected.context.targets?.has(ref)),
        maxAttempts: assignment.maxAttempts,
        onFailure: assignment.onFailure?.strategy,
      })) ?? [],
      summaryChars: summary.text.length, tokenEstimate: summary.tokenEstimate,
      ttftMs: "unavailable", firstStructuredDecisionMs: "unavailable",
    });
  }
}
