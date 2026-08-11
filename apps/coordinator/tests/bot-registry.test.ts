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
