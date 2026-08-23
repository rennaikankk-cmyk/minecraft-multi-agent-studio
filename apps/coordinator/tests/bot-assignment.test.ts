import { describe, expect, it } from "vitest";

import {
  BotAssignmentError,
  BotAssignmentService,
  BotRegistry,
} from "../src/index.js";

const BASE_TIME = new Date("2026-08-22T12:00:00.000Z");
let messageCounter = 0;

function uuid(): string {
  messageCounter += 1;
  return `00000000-0000-4000-8000-${messageCounter.toString(16).padStart(12, "0")}`;
}

function registerBot(
  registry: BotRegistry,
  botId: string,
  runtimeInstanceId: string,
  options: Readonly<{
    serverProfileId?: string;
    health?: number;
    food?: number;
    armorPoints?: number;
    latencyMs?: number;
    paused?: boolean;
  }> = {},
): void {
  const serverProfileId = options.serverProfileId ?? "isolated-test";
  const timestamp = BASE_TIME.toISOString();
  registry.ingest({
    schemaVersion: "1.0",
    messageId: uuid(),
    traceId: "assignment-test",
    timestamp,
    source: { service: "bot-runtime", instanceId: runtimeInstanceId },
    botId,
    type: "bot.status.v1",
    payload: {
      serverProfileId,
      runtimeInstanceId,
      sequence: 1,
      observedAt: timestamp,
      connectionState: "online",
      health: { current: options.health ?? 20, maximum: 20 },
      food: { level: options.food ?? 20, saturation: 5 },
      armorPoints: options.armorPoints ?? 20,
      position: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
      latencyMs: options.latencyMs ?? 20,
      currentTask: null,
      safety: {
        mode: options.paused ? "paused" : "monitoring",
        activeRisks: options.paused ? ["LOW_HEALTH"] : [],
        normalTasksPaused: options.paused ?? false,
        lastDecisionId: null,
        lastAction: null,
      },
    },
  }, BASE_TIME);
  registry.ingest({
    schemaVersion: "1.0",
    messageId: uuid(),
    traceId: "assignment-test",
    timestamp,
    source: { service: "bot-runtime", instanceId: runtimeInstanceId },
    botId,
    type: "bot.skill-catalog.v1",
    payload: {
      serverProfileId,
      runtimeInstanceId,
      sequence: 2,
      observedAt: timestamp,
      minecraftVersion: "1.21.11",
      protocolVersion: 774,
      skills: [
        {
          skillId: "movement.goto",
          skillVersion: "1.0.0",
          availability: "available",
          verification: "unverified",
          inputSchema: { type: "object", additionalProperties: false },
          timeoutMs: 30_000,
          idempotent: true,
          selectedVariantId: "portable",
          unavailableReasons: [],
        },
      ],
    },
  }, BASE_TIME);
}

function disconnect(
  registry: BotRegistry,
  botId: string,
  runtimeInstanceId: string,
  sequence = 3,
): void {
  registry.ingest({
    schemaVersion: "1.0",
    messageId: uuid(),
    traceId: "assignment-test",
    timestamp: BASE_TIME.toISOString(),
    source: { service: "bot-runtime", instanceId: runtimeInstanceId },
    botId,
    type: "bot.disconnected.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId,
      sequence,
      observedAt: BASE_TIME.toISOString(),
      reason: "network_error",
      expected: false,
      lastStatusSequence: 1,
    },
  }, BASE_TIME);
}

function request(taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    taskId,
    serverProfileId: "isolated-test",
    requiredSkills: [
      { skillId: "movement.goto", skillVersion: "1.0.0" },
    ],
    leaseTtlMs: 10_000,
    ...overrides,
  };
}

describe("BotAssignmentService", () => {
  it("filters by ServerProfile, safety and capability, then ranks deterministically", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    registerBot(registry, "worker-slow", "runtime-slow", {
      health: 10,
      latencyMs: 100,
    });
    registerBot(registry, "worker-fast", "runtime-fast", {
      health: 20,
      latencyMs: 20,
    });
    registerBot(registry, "worker-other-server", "runtime-other", {
      serverProfileId: "private-anarchy",
    });
    registerBot(registry, "worker-paused", "runtime-paused", { paused: true });

    const service = new BotAssignmentService({ registry, now: () => BASE_TIME });
    const candidates = service.rank(request("task-01"), BASE_TIME);

    expect(candidates.map(({ botId }) => botId)).toEqual([
      "worker-fast",
      "worker-slow",
    ]);
    expect(candidates[0]).toMatchObject({
      score: 980,
      scoreBreakdown: { health: 400, food: 250, armor: 200, latency: 130 },
    });
    expect(
      service.rank(
        request("task-nether", { dimension: "minecraft:the_nether" }),
        BASE_TIME,
      ),
    ).toHaveLength(0);
  });

  it("claims one Bot per task, is idempotent, and releases for the next task", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    registerBot(registry, "worker-a", "runtime-a", { latencyMs: 20 });
    registerBot(registry, "worker-b", "runtime-b", { latencyMs: 50 });
    const service = new BotAssignmentService({ registry, now: () => BASE_TIME });

    const first = service.acquire(request("task-01"), BASE_TIME);
    expect(service.acquire(request("task-01"), BASE_TIME)).toEqual(first);
    expect(() =>
      service.acquire(request("task-01", { serverProfileId: "private-anarchy" }), BASE_TIME),
    ).toThrowError(expect.objectContaining({ code: "ASSIGNMENT_TASK_CONFLICT" }));

    const second = service.acquire(request("task-02"), BASE_TIME);
    expect(second.botId).toBe("worker-b");
    expect(service.release(first.leaseId)).toBe(true);
    const third = service.acquire(request("task-03"), BASE_TIME);
    expect(third.botId).toBe("worker-a");
  });

  it("drops a disconnected lease so the same constraints can fail over", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    registerBot(registry, "worker-a", "runtime-a", { latencyMs: 20 });
    registerBot(registry, "worker-b", "runtime-b", { latencyMs: 50 });
    const service = new BotAssignmentService({ registry, now: () => BASE_TIME });
    const first = service.acquire(request("task-01"), BASE_TIME);

    disconnect(registry, "worker-a", "runtime-a");
    expect(service.reconcile(BASE_TIME)).toEqual({
      expiredLeaseIds: [],
      releasedLeaseIds: [first.leaseId],
    });
    expect(service.acquire(request("task-01"), BASE_TIME).botId).toBe("worker-b");
  });

  it("fails closed for a busy or explicitly unavailable preferred Bot", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    registerBot(registry, "worker-a", "runtime-a");
    registerBot(registry, "worker-b", "runtime-b");
    const service = new BotAssignmentService({ registry, now: () => BASE_TIME });
    service.acquire(request("task-01", { preferredBotId: "worker-a" }), BASE_TIME);

    expect(() =>
      service.acquire(request("task-02", { preferredBotId: "worker-a" }), BASE_TIME),
    ).toThrowError(expect.objectContaining<Partial<BotAssignmentError>>({
      code: "ASSIGNMENT_PREFERRED_BOT_BUSY",
    }));
    expect(() =>
      service.acquire(request("task-03", { preferredBotId: "missing" }), BASE_TIME),
    ).toThrowError(expect.objectContaining({ code: "ASSIGNMENT_PREFERRED_BOT_UNAVAILABLE" }));
  });

  it("expires leases and never renews an unsafe Bot", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    registerBot(registry, "worker-a", "runtime-a");
    let now = BASE_TIME;
    const service = new BotAssignmentService({ registry, now: () => now });
    const lease = service.acquire(request("task-01", { leaseTtlMs: 2_000 }), now);
    now = new Date(BASE_TIME.getTime() + 2_001);
    expect(service.get(lease.leaseId, now)).toBeNull();
    expect(() => service.renew(lease.leaseId, 2_000, now)).toThrowError(
      expect.objectContaining({ code: "ASSIGNMENT_LEASE_NOT_FOUND" }),
    );
  });
});
