import type { BotRegistryRecord } from "../src/bot-registry.js";
import {
  AUTONOMOUS_GOAL_SEQUENCE,
  AutonomousDirector,
} from "../src/autonomous-director.js";
import { describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-08-28T00:00:00.000Z");

describe("AutonomousDirector", () => {
  it("starts one independent safe goal per idle Bot and exposes only public task fields", async () => {
    const records = [readyRecord("studio-bot-01"), readyRecord("studio-bot-02")];
    const listeners = new Set<(record: BotRegistryRecord) => void>();
    const registry = {
      list: vi.fn(() => records),
      get: vi.fn((botId: string) => records.find((record) => record.botId === botId) ?? null),
      subscribe: vi.fn((listener: (record: BotRegistryRecord) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const planAndDispatch = vi.fn(async () => ({
      action: "noop" as const,
      reasonCode: "NO_SAFE_SKILL",
      ai: {} as never,
    }));
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 5_000,
      terminalRetentionMs: 10_000,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    director.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(planAndDispatch).toHaveBeenCalledTimes(2);
    expect(
      new Set(planAndDispatch.mock.calls.map(([request]) => request.botId)),
    ).toEqual(new Set(["studio-bot-01", "studio-bot-02"]));
    expect(planAndDispatch.mock.calls[0]?.[0]).toMatchObject({
      operatorGoal: AUTONOMOUS_GOAL_SEQUENCE[0].operatorGoal,
      timeoutMs: 60_000,
    });
    expect(director.getCurrentTask("studio-bot-01")).toMatchObject({
      status: "failed",
      title: "自主任务: 收集基础木材",
    });
    expect(director.getCurrentTask("studio-bot-01")).not.toHaveProperty("goal");
    expect(director.getCurrentTask("studio-bot-01")).not.toHaveProperty("goalKey");

    director.start();
    expect(planAndDispatch).toHaveBeenCalledTimes(2);
    await director.stop();
    expect(registry.subscribe).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("does not schedule a Bot while L0 reports a normal-task pause", async () => {
    const record = readyRecord("studio-bot-01");
    record.currentStatus!.safety = {
      ...record.currentStatus!.safety!,
      mode: "paused",
      normalTasksPaused: true,
      activeRisks: ["HUNGER"],
    };
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn(() => () => undefined),
    };
    const planAndDispatch = vi.fn();
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 5_000,
      terminalRetentionMs: 10_000,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    director.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await director.stop();

    expect(planAndDispatch).not.toHaveBeenCalled();
  });

  it("schedules a healthy Bot when max health is unknown in live telemetry", async () => {
    const record = readyRecord("studio-bot-01", null);
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn(() => () => undefined),
    };
    const planAndDispatch = vi.fn(async () => ({
      action: "noop" as const,
      reasonCode: "NO_SAFE_SKILL",
      ai: {} as never,
    }));
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 5_000,
      terminalRetentionMs: 10_000,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    director.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await director.stop();

    expect(planAndDispatch).toHaveBeenCalledTimes(1);
  });

  it("releases an active autonomous goal for a manual goal on the same Bot", async () => {
    const record = readyRecord("studio-bot-01");
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn(() => () => undefined),
    };
    let resolvePlan: ((value: {
      action: "noop";
      reasonCode: "NO_SAFE_SKILL";
      ai: never;
    }) => void) | undefined;
    const planAndDispatch = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<{
          action: "noop";
          reasonCode: "NO_SAFE_SKILL";
          ai: never;
        }>((resolve) => {
          resolvePlan = resolve;
          signal?.addEventListener("abort", () => {
            resolve({ action: "noop", reasonCode: "NO_SAFE_SKILL", ai: undefined as never });
          }, { once: true });
        }),
    );
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 5_000,
      terminalRetentionMs: 10_000,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    director.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(director.getCurrentTask("studio-bot-01")).toMatchObject({
      status: "running",
    });

    await expect(director.requestManualControl("studio-bot-01")).resolves.toBe(true);
    expect(director.getCurrentTask("studio-bot-01")).toMatchObject({
      status: "cancelled",
    });
    expect(planAndDispatch.mock.calls[0]?.[0].signal?.aborted).toBe(true);

    resolvePlan?.({ action: "noop", reasonCode: "NO_SAFE_SKILL", ai: undefined as never });
    await director.stop();
  });

  it("scans, approaches, and retries a resource goal after an unreachable target", async () => {
    const records = [readyRecord("studio-bot-01"), readyRecord("studio-bot-02")];
    const plannerCalls: Array<{ botId: string; operatorGoal: string }> = [];
    const registry = {
      list: vi.fn(() => records),
      get: vi.fn((botId: string) => records.find((record) => record.botId === botId) ?? null),
      subscribe: vi.fn(() => () => undefined),
    };
    const planAndDispatch = vi.fn(async (request: { botId: string; operatorGoal: string }) => {
      plannerCalls.push({ botId: request.botId, operatorGoal: request.operatorGoal });
      if (request.botId === "studio-bot-02") return noopPlanResult();
      if (request.operatorGoal === AUTONOMOUS_GOAL_SEQUENCE[0].operatorGoal) {
        const attempts = plannerCalls.filter(({ botId, operatorGoal }) =>
          botId === request.botId && operatorGoal === request.operatorGoal,
        ).length;
        return attempts === 1
          ? failedPlanResult("COLLECT_PATH_SEARCH_EXHAUSTED")
          : completedPlanResult("collect.block", {
              blockName: "oak_log",
              targetsFound: 1,
              itemsCollected: 1,
            });
      }
      if (request.operatorGoal.includes("方块分布")) {
        return completedPlanResult("world.scan", {
          blockName: "oak_log",
          dimension: "minecraft:overworld",
          matches: [{ x: 10, y: 64, z: 0, distance: 10 }],
          targetsFound: 1,
          complete: true,
        });
      }
      return completedPlanResult("movement.goto", {
        reached: true,
        finalPosition: {
          x: 10,
          y: 64,
          z: 0,
          dimension: "minecraft:overworld",
          serverProfileId: "local-isolated-test",
        },
        distanceToTarget: 0,
      });
    });
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 5_000,
      terminalRetentionMs: 10_000,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    director.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(plannerCalls.filter(({ botId }) => botId === "studio-bot-01").map(({ operatorGoal }) => operatorGoal)).toEqual([
      AUTONOMOUS_GOAL_SEQUENCE[0].operatorGoal,
      expect.stringContaining("oak_log 方块分布"),
      expect.stringContaining("x=10 y=64 z=0"),
      AUTONOMOUS_GOAL_SEQUENCE[0].operatorGoal,
    ]);
    expect(plannerCalls.filter(({ botId }) => botId === "studio-bot-02")).toHaveLength(1);
    expect(director.getCurrentTask("studio-bot-01")).toMatchObject({
      status: "completed",
      title: "自主任务: 收集基础木材",
    });
    await director.stop();
  });

  it("explores and retains the same milestone when a resource is not visible", async () => {
    const record = readyRecord("studio-bot-01");
    let nowMs = NOW.getTime();
    const registryListeners = new Set<(record: BotRegistryRecord) => void>();
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn((listener: (record: BotRegistryRecord) => void) => {
        registryListeners.add(listener);
        return () => registryListeners.delete(listener);
      }),
    };
    const planAndDispatch = vi.fn(async (request: { operatorGoal: string }) => {
      if (request.operatorGoal === AUTONOMOUS_GOAL_SEQUENCE[0].operatorGoal) {
        return failedPlanResult("COLLECT_TARGET_UNREACHABLE");
      }
      if (request.operatorGoal.includes("方块分布")) {
        return completedPlanResult("world.scan", {
          blockName: "oak_log",
          dimension: "minecraft:overworld",
          matches: [],
          targetsFound: 0,
          complete: true,
        });
      }
      return completedPlanResult("movement.goto", {
        reached: true,
        finalPosition: {
          x: 32,
          y: 64,
          z: 0,
          dimension: "minecraft:overworld",
          serverProfileId: "local-isolated-test",
        },
        distanceToTarget: 0,
      });
    });
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 5_000,
      terminalRetentionMs: 10_000,
      now: () => new Date(nowMs),
      randomId: uuidSequence(),
    });

    director.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(planAndDispatch).toHaveBeenCalledTimes(3);
    expect(planAndDispatch.mock.calls[2]?.[0].operatorGoal).toContain(
      "x=32 y=64 z=0",
    );
    expect(director.getCurrentTask("studio-bot-01")).toMatchObject({
      status: "failed",
      title: "自主任务: 收集基础木材",
    });

    // A later liveness event starts the same milestone after the cooldown;
    // the director must not skip straight to crafting-table work.
    nowMs += 11_000;
    registryListeners.forEach((listener) => listener(record));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(planAndDispatch.mock.calls[3]?.[0].operatorGoal).toBe(
      AUTONOMOUS_GOAL_SEQUENCE[0].operatorGoal,
    );
    await director.stop();
  });
});

function noopPlanResult(): never {
  return {
    action: "noop",
    reasonCode: "NO_SAFE_SKILL",
    ai: {},
  } as never;
}

function failedPlanResult(errorCode: string): never {
  return {
    action: "skill_result",
    reasonCode: "ADVANCE_TASK",
    invocation: { payload: { skillId: "collect.block" } },
    result: { payload: { outcome: "failed", errorCode } },
    ai: {},
  } as never;
}

function completedPlanResult(skillId: string, output: unknown): never {
  return {
    action: "skill_result",
    reasonCode: "ADVANCE_TASK",
    invocation: { payload: { skillId } },
    result: { payload: { outcome: "completed", output } },
    ai: {},
  } as never;
}

function readyRecord(botId: string, maximumHealth: number | null = 20): BotRegistryRecord {
  return {
    botId,
    serverProfileId: "local-isolated-test",
    runtimeInstanceId: `runtime-${botId}`,
    connectionState: "online",
    lastSequence: 1,
    lastObservedAt: NOW.toISOString(),
    lastMessageAt: NOW.toISOString(),
    lastHeartbeatAt: NOW.toISOString(),
    lastStatusAt: NOW.toISOString(),
    currentStatus: {
      serverProfileId: "local-isolated-test",
      runtimeInstanceId: `runtime-${botId}`,
      sequence: 1,
      observedAt: NOW.toISOString(),
      connectionState: "online",
      health: { current: 20, maximum: maximumHealth },
      food: { level: 20, saturation: 5 },
      armorPoints: 0,
      position: {
        x: 0,
        y: 64,
        z: 0,
        dimension: "minecraft:overworld",
      },
      latencyMs: 10,
      currentTask: null,
      safety: {
        mode: "monitoring",
        activeRisks: [],
        normalTasksPaused: false,
        lastDecisionId: null,
        lastAction: null,
      },
    },
    minecraftVersion: null,
    skillCatalog: {
      serverProfileId: "local-isolated-test",
      runtimeInstanceId: `runtime-${botId}`,
      sequence: 1,
      observedAt: NOW.toISOString(),
      minecraftVersion: "1.21.8",
      protocolVersion: 772,
      skills: [{ availability: "available" }],
    } as never,
    offlineReason: null,
  };
}

function uuidSequence(): () => string {
  let value = 0;
  return () => `00000000-0000-4000-8000-${(++value).toString().padStart(12, "0")}`;
}
