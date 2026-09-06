import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BaseRegistry, FacilityRegistry, InMemoryWorkstationRegistry } from "@minecraft-studio/skills";
import { BotRegistry } from "../../src/bot-registry.js";
import { BotAssignmentService } from "../../src/bot-assignment.js";
import { RegistryFactReader } from "../../src/spark-strategy-v1/registry-facts.js";
import { TeamProposalObserver, teamObserverEnabled } from "../../src/spark-strategy-v1/observer.js";
import { factVersion } from "../../src/spark-strategy-v1/facts.js";
import { buildSituationSummary } from "../../src/spark-strategy-v1/summary.js";
import type { ModelClient } from "../../src/spark-strategy-v1/model-client.js";

const NOW = 1_788_680_000_000;
function fixture() {
  let now = NOW;
  let sequence = 0;
  const registry = new BotRegistry({ staleAfterMs: 15_000, now: () => new Date(now) });
  const assignmentEvents = vi.fn();
  const assignment = new BotAssignmentService({ registry, now: () => new Date(now), onEvent: assignmentEvents });
  const bases = new BaseRegistry({ now: () => now });
  const facilities = new FacilityRegistry({ now: () => now });
  const workstations = new InMemoryWorkstationRegistry();
  const reader = new RegistryFactReader({ registry, assignment, bases, facilities, workstations });
  const send = (options: { bot?: string; runtime?: string; server?: string; dimension?: string; task?: boolean; food?: number; observed?: number } = {}) => {
    const observedAt = new Date(options.observed ?? now).toISOString();
    const runtime = options.runtime ?? "private-runtime";
    registry.ingest({ schemaVersion: "1.0", messageId: randomUUID(), traceId: "test-observer", timestamp: observedAt,
      source: { service: "bot-runtime", instanceId: runtime }, botId: options.bot ?? "private-bot",
      type: "bot.status.v1", payload: { runtimeInstanceId: runtime, serverProfileId: options.server ?? "private-server", sequence: ++sequence,
        observedAt, connectionState: "online", health: { current: 20, maximum: 20 }, food: { level: options.food ?? 10, saturation: 1 },
        armorPoints: null, inventory: [{ itemName: "bread", count: 2 }], position: { x: 198765, y: 74, z: -234567, dimension: options.dimension ?? "minecraft:overworld" },
        latencyMs: 15, currentTask: options.task ? { taskId: "private-task", title: "secret 198765 -234567", status: "running", startedAt: observedAt } : null,
        safety: { mode: "monitoring", activeRisks: [], normalTasksPaused: false, lastDecisionId: null, lastAction: null },
        lastDeath: { x: 198765, y: 74, z: -234567, dimension: options.dimension ?? "minecraft:overworld", diedAt: observedAt },
      } });
  };
  send();
  return { registry, assignment, assignmentEvents, bases, facilities, workstations, reader, send, now: () => now,
    catalog: () => registry.ingest({ schemaVersion: "1.0", messageId: randomUUID(), traceId: "test-observer", timestamp: new Date(now).toISOString(),
      source: { service: "bot-runtime", instanceId: "private-runtime" }, botId: "private-bot", type: "bot.skill-catalog.v1",
      payload: { runtimeInstanceId: "private-runtime", serverProfileId: "private-server", sequence: ++sequence, observedAt: new Date(now).toISOString(),
        minecraftVersion: "1.21.11", protocolVersion: 774, skills: [{ skillId: "food.secure", skillVersion: "1.0.0", availability: "available",
          verification: "unverified", inputSchema: { type: "object", additionalProperties: false }, timeoutMs: 30000,
          idempotent: true, selectedVariantId: "portable", unavailableReasons: [] }] } }),
    advance: (ms: number) => { now += ms; } };
}
const waitClient = (f: ReturnType<typeof fixture>): ModelClient => ({ complete: async () => {
  const facts = f.reader.read(f.now())[0]!.facts;
  return { finishReason: "stop", clientLatencyMs: 20, usage: { promptTokens: 2000, completionTokens: 200 }, text: JSON.stringify({
    proposalId: "p", factVersion: factVersion(facts), scope: facts.scope, validUntilMs: f.now() + 90_000, generatedBy: "test",
    objective: "private text must not enter logs", assignments: [{ assignmentId: "a", botId: facts.bots[0]!.botId,
      role: "private-role", action: { kind: "wait", reason: "private reason 198765" } }],
  }) };
} });

describe("read-only registry facts", () => {
  it("uses opaque identities and does not promote block discovery or invent death totals", () => {
    const f = fixture();
    f.send({ task: true });
    const base = f.bases.create({ name: "private-base", serverProfileId: "private-server", dimension: "minecraft:overworld",
      anchor: { x: 198765, y: 74, z: -234567 }, blueprintId: "starter-base-v1", createdByBotId: "private-bot" });
    f.bases.recordPhaseEvidence(base.id, "BASE_SITE_RESERVED", "AVAILABLE", "private-evidence", "trusted-validator");
    f.facilities.create({ facilityType: "crop_farm", serverProfileId: "private-server", dimension: "minecraft:overworld", anchor: base.anchor,
      orientation: "north", layoutVersion: "v1", patternSlots: [], baseId: base.id });
    const facts = f.reader.read(f.now())[0]!.facts;
    const text = JSON.stringify(facts) + buildSituationSummary(facts).text;
    for (const forbidden of ["private-", "198765", "-234567", base.id]) expect(text).not.toContain(forbidden);
    expect(facts.bots[0]?.deaths).toBe("unknown");
    expect(facts.team.sharedInventory).toBe("unknown");
    expect(facts.team.facilities).toEqual([expect.objectContaining({ kind: "crop_farm", status: "unknown" })]);
    expect(facts.constraints.nonPreemptibleBots).toEqual([facts.bots[0]?.botId]);
    expect(facts.constraints.phaseGates[0]?.satisfied).toBe(true);
    expect(facts.constraints.phaseGates[1]?.satisfied).toBe("unknown");
  });
  it("inspection does not emit staleness or release expired assignments", () => {
    const f = fixture();
    f.catalog();
    const lease = f.assignment.acquire({ taskId: "reserved-task", serverProfileId: "private-server", dimension: "minecraft:overworld", requiredSkills: [], leaseTtlMs: 1000 });
    f.assignmentEvents.mockClear();
    const event = vi.fn();
    f.registry.subscribe(event);
    f.advance(20_000);
    expect(f.registry.inspect()[0]?.connectionState).toBe("stale");
    expect(event).not.toHaveBeenCalled();
    expect(f.assignment.inspect()).toEqual([lease]);
    expect(f.assignmentEvents).not.toHaveBeenCalled();
    expect(f.registry.sweepStale()).toBe(1);
    expect(event).toHaveBeenCalledTimes(1);
    expect(f.assignment.reconcile().expiredLeaseIds).toEqual([lease.leaseId]);
  });
  it("dedup ignores status timestamps and sequences but retains runtime changes", () => {
    const f = fixture();
    const before = f.reader.read(f.now())[0]!;
    f.advance(1000);
    // The actual death event remains the same; refreshing it would describe a new event.
    f.send({ observed: NOW });
    const after = f.reader.read(f.now())[0]!;
    expect(after.contentKey).toBe(before.contentKey);
    expect(factVersion(after.facts)).not.toBe(factVersion(before.facts));
    f.send({ runtime: "new-runtime" });
    expect(f.reader.read(f.now())[0]?.contentKey).not.toBe(before.contentKey);
  });
  it("separates servers and dimensions and does not refresh old status with observation time", () => {
    const f = fixture();
    f.send({ bot: "other-bot", server: "other-server" });
    f.send({ bot: "nether-bot", dimension: "minecraft:the_nether" });
    expect(f.reader.read(f.now())).toHaveLength(3);
    f.advance(61_000);
    for (const observation of f.reader.read(f.now())) {
      expect(observation.facts.scope.observedAtMs).toBe(NOW);
      expect(observation.facts.bots[0]?.currentTask).toBe("unknown");
      expect(observation.facts.bots[0]?.inventory).toBe("unknown");
    }
  });
  it("workstation leases are observed without claiming or extending freshness", () => {
    const f = fixture();
    const station = f.workstations.register("private-server", "minecraft:overworld", "furnace", { x: 198765, y: 74, z: -234567 });
    station.lastSeenAt = NOW - 1000;
    station.lease = { leaseId: "lease", generation: 1, ownerBotId: "outside-bot", ownerRuntimeId: "outside-runtime", ownerTaskId: "task",
      ownerAttemptId: "attempt", expiresAtMs: NOW + 30_000 };
    const before = structuredClone(station);
    const observed = f.reader.read(f.now())[0]!;
    expect(observed.facts.team.facilities).toEqual([expect.objectContaining({ status: "busy" })]);
    expect(observed.facts.team.reservedResources).toHaveLength(1);
    expect(observed.facts.scope.observedAtMs).toBe(NOW - 1000);
    expect(station).toEqual(before);
    expect(JSON.stringify(observed.facts)).not.toContain("198765");
  });
});

describe("proposal observation lifecycle", () => {
  it("default OFF produces no reads or model requests", async () => {
    expect(teamObserverEnabled({})).toBe(false);
    expect(teamObserverEnabled({ STUDIO_TEAM_STRATEGY_PROPOSAL: "1" })).toBe(true);
    expect(() => teamObserverEnabled({ STUDIO_TEAM_STRATEGY_PROPOSAL: "yes" })).toThrow();
    const read = vi.fn(); const complete = vi.fn();
    const observer = new TeamProposalObserver({ enabled: false, read, client: { complete }, log: vi.fn() });
    observer.start(); await observer.sample(); await observer.stop();
    expect(read).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });
  it("logs only structured suggestions and accounting, and deduplicates unchanged observations", async () => {
    const f = fixture(); const log = vi.fn(); const client = waitClient(f); const complete = vi.spyOn(client, "complete");
    const observer = new TeamProposalObserver({ enabled: true, read: (now) => f.reader.read(now), client, log, now: f.now, cooldownMs: 1000 });
    await observer.sample(); await observer.sample(); f.advance(1001); await observer.sample();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ automaticDispatch: false, verdict: "acceptable", suggestions: [expect.objectContaining({ kind: "wait" })] });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    expect(JSON.stringify(log.mock.calls)).not.toContain("198765");
    await observer.stop();
  });
  it("one global in-flight request and content changes invalidate returned suggestions", async () => {
    const f = fixture(); const log = vi.fn(); let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const base = waitClient(f);
    const complete = vi.fn(async (request) => { const response = await base.complete(request); await barrier; return response; });
    const observer = new TeamProposalObserver({ enabled: true, read: (now) => f.reader.read(now), client: { complete }, log, now: f.now });
    const pending = observer.sample(); await observer.sample();
    expect(complete).toHaveBeenCalledTimes(1);
    f.send({ food: 19 }); release(); await pending;
    expect(log.mock.calls[0]?.[0].reasonCodes).toContain("CONTENT_CHANGED_OR_SCOPE_RETIRED");
    expect(log.mock.calls[0]?.[0].verdict).toBe("needs-reobservation");
    await observer.stop();
  });
  it("shutdown cancels its request without touching registries or leases", async () => {
    const f = fixture(); const log = vi.fn();
    const complete: ModelClient["complete"] = (request) => new Promise((_resolve, reject) => {
      request.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const observer = new TeamProposalObserver({ enabled: true, read: (now) => f.reader.read(now), client: { complete }, log, now: f.now });
    const pending = observer.sample(); await observer.stop(); await pending;
    expect(log.mock.calls[0]?.[0].accounting.outcome).toBe("cancelled");
    expect(f.assignmentEvents).not.toHaveBeenCalled();
  });
});
