import { describe, expect, it } from "vitest";

import {
  InMemoryMetricRegistry,
  createStructuredLogger,
  type StructuredLogRecord,
} from "../src/index.js";

describe("structured observability", () => {
  it("always emits correlation fields and redacts sensitive values", () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({
      service: "test-service",
      instanceId: "test-instance",
      now: () => new Date("2026-07-20T09:00:00.000Z"),
      sink: (record) => records.push(record),
    });
    logger.warn("test_event", {
      traceId: "trace-01",
      botId: "worker-01",
      authorization: "Bearer should-not-appear",
      note: "line one\nBearer abcdefghijklmnopqrstuvwxyz012345",
      serverHost: "private.example",
      position: { x: 1, y: 64, z: 2 },
      nested: { password: "secret-value", safe: "visible" },
    });

    expect(records).toEqual([
      expect.objectContaining({
        timestamp: "2026-07-20T09:00:00.000Z",
        level: "warn",
        service: "test-service",
        instanceId: "test-instance",
        event: "test_event",
        traceId: "trace-01",
        taskId: null,
        botId: "worker-01",
        skillId: null,
        modelName: null,
        authorization: "[REDACTED]",
        note: "line one [REDACTED]",
        serverHost: "[REDACTED]",
        position: "[REDACTED]",
        nested: { password: "[REDACTED]", safe: "visible" },
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("should-not-appear");
    expect(JSON.stringify(records)).not.toContain("secret-value");
    expect(JSON.stringify(records)).not.toContain("private.example");
  });

  it("keeps bounded lifecycle counters with non-sensitive labels", () => {
    const metrics = new InMemoryMetricRegistry();
    metrics.increment("bot_connection_attempts_total", { bot_id: "worker-01" });
    metrics.increment("bot_connection_attempts_total", { bot_id: "worker-01" });
    metrics.increment("bot_disconnects_total", {
      bot_id: "worker-01",
      reason: "socket_closed",
    });
    expect(metrics.snapshot()).toEqual([
      {
        name: "bot_connection_attempts_total",
        value: 2,
        labels: { bot_id: "worker-01" },
      },
      {
        name: "bot_disconnects_total",
        value: 1,
        labels: { bot_id: "worker-01", reason: "socket_closed" },
      },
    ]);
    expect(() =>
      metrics.increment("bot_heartbeats_total", { access_token: "secret" }),
    ).toThrowError(/sensitive/u);
  });
});
