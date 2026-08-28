import { describe, expect, it } from "vitest";

import {
  BotRegistry,
  CoordinatorTelemetryError,
} from "../src/index.js";

const BASE_TIME = "2026-07-20T02:00:00.000Z";

function messageId(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function heartbeat(
  runtimeInstanceId: string,
  sequence: number,
  observedAt = BASE_TIME,
  id = sequence,
) {
  return {
    schemaVersion: "1.0" as const,
    messageId: messageId(id),
    traceId: "trace-registry",
    timestamp: observedAt,
    source: { service: "bot-runtime" as const, instanceId: runtimeInstanceId },
    botId: "worker-01",
    type: "bot.heartbeat.v1" as const,
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId,
      sequence,
      observedAt,
      connectionState: "online" as const,
      uptimeMs: sequence * 1_000,
      lastStatusSequence: null,
      currentTaskId: null,
    },
  };
}

function status(
  runtimeInstanceId: string,
  sequence: number,
  observedAt = BASE_TIME,
  id = sequence,
) {
  return {
    schemaVersion: "1.0" as const,
    messageId: messageId(id),
    traceId: "trace-registry",
    timestamp: observedAt,
    source: { service: "bot-runtime" as const, instanceId: runtimeInstanceId },
    botId: "worker-01",
    type: "bot.status.v1" as const,
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId,
      sequence,
      observedAt,
      connectionState: "online" as const,
      health: { current: 20, maximum: 20 },
      food: { level: 20, saturation: 5 },
      armorPoints: 0,
      position: { x: 1, y: 64, z: 2, dimension: "minecraft:overworld" },
      latencyMs: 20,
      currentTask: null,
    },
  };
}

function disconnected(runtimeInstanceId: string, sequence: number, id = sequence) {
  return {
    schemaVersion: "1.0" as const,
    messageId: messageId(id),
    traceId: "trace-registry",
    timestamp: BASE_TIME,
    source: { service: "bot-runtime" as const, instanceId: runtimeInstanceId },
    botId: "worker-01",
    type: "bot.disconnected.v1" as const,
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId,
      sequence,
      observedAt: BASE_TIME,
      reason: "network_error" as const,
      expected: false,
      lastStatusSequence: null,
    },
  };
}

function worldState(
  runtimeInstanceId: string,
  sequence: number,
  worldStateVersion: number,
  observedAt = BASE_TIME,
  id = sequence,
) {
  return {
    schemaVersion: "1.0" as const,
    messageId: messageId(id),
    traceId: "trace-registry",
    timestamp: observedAt,
    source: { service: "bot-runtime" as const, instanceId: runtimeInstanceId },
    botId: "worker-01",
    type: "bot.world-state.v1" as const,
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId,
      sequence,
      observedAt,
      worldStateVersion,
      inventory: [
        { name: "oak_planks", count: worldStateVersion, durability: null },
      ],
      nearbyUtilityBlocks: [
        {
          name: "crafting_table" as const,
          dimension: "minecraft:overworld",
          position: { x: 3, y: 64, z: 0 },
          reachable: true,
          source: "observation" as const,
          confidence: 1,
        },
      ],
      navigation: {
        owner: "skill:movement.goto:invocation-1",
        target: {
          x: 10,
          y: 64,
          z: 0,
          dimension: "minecraft:overworld",
        },
        version: worldStateVersion,
      },
    },
  };
}

describe("BotRegistry", () => {
  it("accepts status and heartbeat while preserving real status data", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    const receivedAt = new Date(BASE_TIME);

    expect(registry.ingest(status("runtime-a", 1), receivedAt).accepted).toBe(true);
    const heartbeatAt = new Date(receivedAt.getTime() + 1_000);
    const result = registry.ingest(
      heartbeat("runtime-a", 2, heartbeatAt.toISOString(), 2),
      heartbeatAt,
    );

    expect(result.record).toMatchObject({
      connectionState: "online",
      runtimeInstanceId: "runtime-a",
      lastSequence: 2,
      lastHeartbeatAt: heartbeatAt.toISOString(),
    });
    expect(result.record.currentStatus?.position).toEqual({
      x: 1,
      y: 64,
      z: 2,
      dimension: "minecraft:overworld",
    });
  });

  it("ignores duplicate and out-of-order messages", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    const now = new Date(BASE_TIME);
    const first = heartbeat("runtime-a", 3, BASE_TIME, 3);

    registry.ingest(first, now);
    expect(registry.ingest(first, now).reason).toBe("duplicate_message");
    expect(registry.ingest(heartbeat("runtime-a", 3, BASE_TIME, 30), now).reason).toBe(
      "duplicate_sequence",
    );
    expect(registry.ingest(heartbeat("runtime-a", 2, BASE_TIME, 20), now).reason).toBe(
      "out_of_order",
    );
    expect(registry.get("worker-01", now)?.lastSequence).toBe(3);
  });

  it("retires an older runtime so delayed heartbeats cannot revive it", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    const start = new Date(BASE_TIME);
    registry.ingest(heartbeat("runtime-old", 8, BASE_TIME, 8), start);

    const restartedAt = new Date(start.getTime() + 1_000);
    registry.ingest(
      heartbeat("runtime-new", 1, restartedAt.toISOString(), 101),
      restartedAt,
    );
    const delayedAt = new Date(start.getTime() + 2_000);
    const delayed = registry.ingest(
      heartbeat("runtime-old", 9, delayedAt.toISOString(), 109),
      delayedAt,
    );

    expect(delayed).toMatchObject({
      accepted: false,
      reason: "retired_runtime",
      record: { runtimeInstanceId: "runtime-new", lastSequence: 1 },
    });
  });

  it("marks expired liveness stale and restores only with a newer message", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    const start = new Date(BASE_TIME);
    registry.ingest(heartbeat("runtime-a", 1, BASE_TIME, 1), start);

    const staleAt = new Date(start.getTime() + 5_001);
    expect(registry.sweepStale(staleAt)).toBe(1);
    expect(registry.get("worker-01", staleAt)?.connectionState).toBe("stale");

    const restoredAt = new Date(start.getTime() + 6_000);
    registry.ingest(
      heartbeat("runtime-a", 2, restoredAt.toISOString(), 2),
      restoredAt,
    );
    expect(registry.get("worker-01", restoredAt)?.connectionState).toBe("online");
  });

  it("marks a structured disconnect offline", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    const now = new Date(BASE_TIME);
    registry.ingest(heartbeat("runtime-a", 1, BASE_TIME, 1), now);
    const result = registry.ingest(disconnected("runtime-a", 2, 2), now);

    expect(result.record).toMatchObject({
      connectionState: "offline",
      offlineReason: "network_error",
    });
    expect(registry.sweepStale(new Date(now.getTime() + 60_000))).toBe(0);
  });

  it("stores a version report without changing the connection state", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    const now = new Date(BASE_TIME);
    registry.ingest(heartbeat("runtime-a", 1, BASE_TIME, 1), now);
    const result = registry.ingest(
      {
        ...heartbeat("runtime-a", 2, BASE_TIME, 202),
        type: "bot.version.v1",
        payload: {
          serverProfileId: "isolated-test",
          runtimeInstanceId: "runtime-a",
          sequence: 2,
          observedAt: BASE_TIME,
          compatibility: {
            selection: "auto",
            requestedVersion: null,
            resolvedVersion: "1.21.8",
            protocolVersion: 772,
            majorVersion: "1.21",
            supportLevel: "tested",
            supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
          },
        },
      },
      now,
    );

    expect(result.record).toMatchObject({
      connectionState: "online",
      minecraftVersion: {
        selection: "auto",
        resolvedVersion: "1.21.8",
        supportLevel: "tested",
      },
    });
  });

  it("stores a version-bound skill catalog without changing liveness", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    const now = new Date(BASE_TIME);
    registry.ingest(heartbeat("runtime-a", 1, BASE_TIME, 1), now);
    registry.ingest(
      {
        ...heartbeat("runtime-a", 2, BASE_TIME, 202),
        type: "bot.version.v1",
        payload: {
          serverProfileId: "isolated-test",
          runtimeInstanceId: "runtime-a",
          sequence: 2,
          observedAt: BASE_TIME,
          compatibility: {
            selection: "auto",
            requestedVersion: null,
            resolvedVersion: "1.21.11",
            protocolVersion: 774,
            majorVersion: "1.21",
            supportLevel: "tested",
            supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
          },
        },
      },
      now,
    );
    const result = registry.ingest(
      {
        ...heartbeat("runtime-a", 3, BASE_TIME, 203),
        type: "bot.skill-catalog.v1",
        payload: {
          serverProfileId: "isolated-test",
          runtimeInstanceId: "runtime-a",
          sequence: 3,
          observedAt: BASE_TIME,
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
      },
      now,
    );

    expect(result.record).toMatchObject({
      connectionState: "online",
      skillCatalog: {
        minecraftVersion: "1.21.11",
        protocolVersion: 774,
        skills: [
          expect.objectContaining({
            skillId: "movement.goto",
            availability: "available",
          }),
        ],
      },
    });
  });

  it("stores only the latest world-state snapshot without changing liveness", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    const start = new Date(BASE_TIME);
    registry.ingest(heartbeat("runtime-a", 1, BASE_TIME, 1), start);

    const firstAt = new Date(start.getTime() + 100);
    registry.ingest(
      worldState("runtime-a", 2, 7, firstAt.toISOString(), 702),
      firstAt,
    );
    const latestAt = new Date(start.getTime() + 200);
    const result = registry.ingest(
      worldState("runtime-a", 3, 8, latestAt.toISOString(), 803),
      latestAt,
    );

    expect(result.record).toMatchObject({
      connectionState: "online",
      lastWorldStateAt: latestAt.toISOString(),
      worldState: {
        sequence: 3,
        version: 8,
        worldStateVersion: 8,
        inventory: [{ name: "oak_planks", count: 8, durability: null }],
      },
    });
  });

  it("clears world state when a newer runtime instance takes ownership", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    const start = new Date(BASE_TIME);
    registry.ingest(heartbeat("runtime-old", 1, BASE_TIME, 1), start);
    const stateAt = new Date(start.getTime() + 100);
    registry.ingest(
      worldState("runtime-old", 2, 4, stateAt.toISOString(), 402),
      stateAt,
    );

    const restartedAt = new Date(start.getTime() + 1_000);
    const restarted = registry.ingest(
      heartbeat("runtime-new", 1, restartedAt.toISOString(), 1_001),
      restartedAt,
    );

    expect(restarted.record).toMatchObject({
      runtimeInstanceId: "runtime-new",
      worldState: null,
      lastWorldStateAt: null,
    });
  });

  it("rejects conflicting version or catalog facts without advancing registry state", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000 });
    const now = new Date(BASE_TIME);
    registry.ingest(heartbeat("runtime-a", 1, BASE_TIME, 1), now);
    registry.ingest(
      {
        ...heartbeat("runtime-a", 2, BASE_TIME, 202),
        type: "bot.version.v1",
        payload: {
          serverProfileId: "isolated-test",
          runtimeInstanceId: "runtime-a",
          sequence: 2,
          observedAt: BASE_TIME,
          compatibility: {
            selection: "auto",
            requestedVersion: null,
            resolvedVersion: "1.21.11",
            protocolVersion: 774,
            majorVersion: "1.21",
            supportLevel: "tested",
            supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
          },
        },
      },
      now,
    );

    expect(() =>
      registry.ingest(
        {
          ...heartbeat("runtime-a", 3, BASE_TIME, 203),
          type: "bot.skill-catalog.v1",
          payload: {
            serverProfileId: "isolated-test",
            runtimeInstanceId: "runtime-a",
            sequence: 3,
            observedAt: BASE_TIME,
            minecraftVersion: "1.20.6",
            protocolVersion: 766,
            skills: [],
          },
        },
        now,
      ),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
    expect(registry.get("worker-01", now)).toMatchObject({
      lastSequence: 2,
      skillCatalog: null,
      minecraftVersion: { resolvedVersion: "1.21.11", protocolVersion: 774 },
    });

    const conflictingStatus = status("runtime-a", 3, BASE_TIME, 204);
    expect(() =>
      registry.ingest(
        {
          ...conflictingStatus,
          payload: {
            ...conflictingStatus.payload,
            minecraftVersion: {
              selection: "auto",
              requestedVersion: null,
              resolvedVersion: "1.20.6",
              protocolVersion: 766,
              majorVersion: "1.20",
              supportLevel: "compatible-untested",
              supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
            },
          },
        },
        now,
      ),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
    expect(registry.get("worker-01", now)).toMatchObject({
      lastSequence: 2,
      currentStatus: null,
      minecraftVersion: { resolvedVersion: "1.21.11", protocolVersion: 774 },
    });
  });

  it("rejects untrusted sources, mismatched instances, and future messages", () => {
    const registry = new BotRegistry({ staleAfterMs: 5_000, maxClockSkewMs: 500 });
    const now = new Date(BASE_TIME);
    const wrongSource = heartbeat("runtime-a", 1);
    wrongSource.source.service = "coordinator" as "bot-runtime";
    expect(() => registry.ingest(wrongSource, now)).toThrowError(
      expect.objectContaining<Partial<CoordinatorTelemetryError>>({
        code: "SOURCE_NOT_ALLOWED",
      }),
    );

    const mismatch = heartbeat("runtime-a", 1, BASE_TIME, 11);
    mismatch.source.instanceId = "runtime-other";
    expect(() => registry.ingest(mismatch, now)).toThrowError(
      expect.objectContaining({ code: "SOURCE_INSTANCE_MISMATCH" }),
    );

    const future = new Date(now.getTime() + 501).toISOString();
    expect(() =>
      registry.ingest(heartbeat("runtime-a", 1, future, 12), now),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_FROM_FUTURE" }));
  });
});
