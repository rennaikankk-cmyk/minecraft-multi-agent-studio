// Round 6.6 注册屏障测试：goal_execution_ready 单一定义、就绪翻沿回调、
// 停车准入/唤醒/幂等语义（经 production 的 onReadinessChange 驱动）。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BotRegistry, botGoalExecutionReady } from "../src/bot-registry.js";

const BASE_TIME = "2026-09-03T00:00:00.000Z";

function messageId(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function statusMessage(sequence: number, observedAt = BASE_TIME, id = sequence) {
  return {
    schemaVersion: "1.0" as const,
    messageId: messageId(id),
    traceId: "trace-waiting",
    timestamp: observedAt,
    source: { service: "bot-runtime" as const, instanceId: "runtime-a" },
    botId: "studio-bot-01",
    type: "bot.status.v1" as const,
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: "runtime-a",
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

function catalogMessage(sequence: number, observedAt = BASE_TIME, id = 9_000 + sequence) {
  return {
    schemaVersion: "1.0" as const,
    messageId: messageId(id),
    traceId: "trace-waiting",
    timestamp: observedAt,
    source: { service: "bot-runtime" as const, instanceId: "runtime-a" },
    botId: "studio-bot-01",
    type: "bot.skill-catalog.v1" as const,
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: "runtime-a",
      sequence,
      observedAt,
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
  };
}

describe("botGoalExecutionReady（单一定义）", () => {
  it("三条件全满足才 ready", () => {
    expect(botGoalExecutionReady({ connectionState: "online", currentStatus: null, skillCatalog: null })).toBe(false);
    expect(botGoalExecutionReady({ connectionState: "online", currentStatus: {} as never, skillCatalog: null })).toBe(false);
    expect(botGoalExecutionReady({ connectionState: "stale", currentStatus: {} as never, skillCatalog: {} as never })).toBe(false);
    expect(botGoalExecutionReady({ connectionState: "online", currentStatus: {} as never, skillCatalog: {} as never })).toBe(true);
  });
});

describe("BotRegistry.onReadinessChange（翻沿回调）", () => {
  let registry: BotRegistry;
  let now: Date;

  beforeEach(() => {
    now = new Date(BASE_TIME);
    registry = new BotRegistry({ staleAfterMs: 30_000, now: () => now });
  });

  it("goal 先提交、bot 后注册：首见即 ready 触发 true", () => {
    const events: Array<[string, boolean]> = [];
    registry.onReadinessChange((botId, ready) => events.push([botId, ready]));
    registry.ingest(statusMessage(1), now);
    expect(events).toEqual([]);
    registry.ingest(catalogMessage(2), now);
    expect(events).toEqual([["studio-bot-01", true]]);
    expect(registry.goalExecutionReady("studio-bot-01")).toBe(true);
  });

  it("重复消息不重复触发（幂等）", () => {
    const events: Array<[string, boolean]> = [];
    registry.onReadinessChange((botId, ready) => events.push([botId, ready]));
    registry.ingest(statusMessage(1), now);
    registry.ingest(catalogMessage(2), now);
    registry.ingest(statusMessage(3), now);
    registry.ingest(catalogMessage(4), now);
    expect(events).toEqual([["studio-bot-01", true]]);
  });

  it("stale 翻沿触发 false；恢复后触发 true（真翻沿）", () => {
    const events: Array<[string, boolean]> = [];
    registry.onReadinessChange((botId, ready) => events.push([botId, ready]));
    registry.ingest(statusMessage(1), now);
    registry.ingest(catalogMessage(2), now);
    now = new Date(BASE_TIME.replace("00:00:00", "00:01:00"));
    registry.get("studio-bot-01", now); // 60s 后 → stale
    expect(events).toContainEqual(["studio-bot-01", false]);
    // 心跳恢复 online（catalog 仍在记录上）
    registry.ingest(
      {
        schemaVersion: "1.0" as const,
        messageId: messageId(5),
        traceId: "trace-waiting",
        timestamp: now.toISOString(),
        source: { service: "bot-runtime" as const, instanceId: "runtime-a" },
        botId: "studio-bot-01",
        type: "bot.heartbeat.v1" as const,
        payload: {
          serverProfileId: "isolated-test",
          runtimeInstanceId: "runtime-a",
          sequence: 5,
          observedAt: now.toISOString(),
          connectionState: "online" as const,
          uptimeMs: 60_000,
          lastStatusSequence: 1,
          currentTaskId: null,
        },
      },
      now,
    );
    expect(events.filter(([, ready]) => ready)).toHaveLength(2);
  });

  it("订阅者抛错不影响 registry", () => {
    registry.onReadinessChange(() => {
      throw new Error("subscriber bug");
    });
    expect(() => {
      registry.ingest(statusMessage(1), now);
      registry.ingest(catalogMessage(2), now);
    }).not.toThrow();
    expect(registry.goalExecutionReady("studio-bot-01")).toBe(true);
  });
});

describe("停车准入与唤醒语义（production onReadinessChange 驱动的 FIFO 复刻）", () => {
  let registry: BotRegistry;
  let now: Date;
  let parked: string[];
  let resumeCount: Record<string, number>;

  beforeEach(() => {
    now = new Date(BASE_TIME);
    registry = new BotRegistry({ staleAfterMs: 30_000, now: () => now });
    parked = [];
    resumeCount = {};
    registry.onReadinessChange((botId, ready) => {
      if (!ready) return;
      while (parked.length > 0 && registry.goalExecutionReady(botId)) {
        const id = parked.shift()!;
        resumeCount[id] = (resumeCount[id] ?? 0) + 1;
      }
    });
  });

  it("注册窗内提交的 goal 停车，ready 后恰好唤醒一次", () => {
    parked.push("goal-1");
    expect(resumeCount["goal-1"]).toBeUndefined();
    registry.ingest(statusMessage(1), now);
    registry.ingest(catalogMessage(2), now);
    expect(resumeCount["goal-1"]).toBe(1);
    registry.ingest(statusMessage(3), now);
    expect(resumeCount["goal-1"]).toBe(1);
  });

  it("多个 goal FIFO 全部被服务", () => {
    parked.push("a", "b", "c");
    registry.ingest(statusMessage(1), now);
    registry.ingest(catalogMessage(2), now);
    expect(resumeCount).toEqual({ a: 1, b: 1, c: 1 });
  });

  it("stale 后停车的新 goal 不被唤醒（状态不可用）", () => {
    registry.ingest(statusMessage(1), now);
    registry.ingest(catalogMessage(2), now);
    now = new Date(BASE_TIME.replace("00:00:00", "00:01:00"));
    registry.get("studio-bot-01", now);
    parked.push("late");
    expect(resumeCount["late"]).toBeUndefined();
    expect(registry.goalExecutionReady("studio-bot-01")).toBe(false);
  });
});

describe("配置 SSOT：STUDIO_AUTONOMY_ENABLED 词形", () => {
  it("true/false 与 1/0 等价，garbage fail-closed", async () => {
    const { loadAutonomousConfig } = await import("../src/autonomous-config.js");
    expect(loadAutonomousConfig({ STUDIO_AUTONOMY_ENABLED: "true" }).enabled).toBe(true);
    expect(loadAutonomousConfig({ STUDIO_AUTONOMY_ENABLED: "FALSE" }).enabled).toBe(false);
    expect(loadAutonomousConfig({ STUDIO_AUTONOMY_ENABLED: "0" }).enabled).toBe(false);
    expect(loadAutonomousConfig({ STUDIO_AUTONOMY_ENABLED: "1" }).enabled).toBe(true);
    expect(loadAutonomousConfig({}).enabled).toBe(true);
    expect(() => loadAutonomousConfig({ STUDIO_AUTONOMY_ENABLED: "nope" })).toThrow();
  });
});
