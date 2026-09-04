import type { BotRegistryRecord } from "../src/bot-registry.js";
import { AutonomousDirector } from "../src/autonomous-director.js";
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
    await flushDirector();

    expect(planAndDispatch).toHaveBeenCalledTimes(2);
    expect(
      new Set(planAndDispatch.mock.calls.map(([request]) => request.botId)),
    ).toEqual(new Set(["studio-bot-01", "studio-bot-02"]));
    // Empty inventory with a full bar: the tool ladder outranks food topping-up.
    expect(planAndDispatch.mock.calls[0]?.[0]).toMatchObject({
      operatorGoal: "获取 wooden_pickaxe",
      timeoutMs: 60_000,
    });
    expect(director.getCurrentTask("studio-bot-01")).toMatchObject({
      status: "failed",
      title: expect.stringContaining("wooden_pickaxe"),
    });
    expect(director.getCurrentTask("studio-bot-01")).not.toHaveProperty("goal");
    expect(director.getCurrentTask("studio-bot-01")).not.toHaveProperty("needKey");

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
    await flushDirector();
    await director.stop();

    expect(planAndDispatch).not.toHaveBeenCalled();
  });

  it("prioritises food over tools when the hunger bar is running low", async () => {
    const record = readyRecord("studio-bot-01");
    record.currentStatus!.food.level = 12;
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn(() => () => undefined),
    };
    const planAndDispatch = vi.fn(async () => noopPlanResult());
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
    await flushDirector();
    await director.stop();

    // Empty food reserve at food<=16 is the emergency branch (92) and must
    // outrank the wooden pickaxe (75).
    expect(planAndDispatch.mock.calls[0]?.[0].operatorGoal).toBe(
      "获取安全食物到总量 12 份",
    );
  });

  it("advances the tool ladder from real inventory state", async () => {
    const record = readyRecord("studio-bot-01");
    record.currentStatus!.inventory = [
      { itemName: "oak_log", count: 4 },
      { itemName: "crafting_table", count: 1 },
      { itemName: "wooden_pickaxe", count: 1 },
    ];
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn(() => () => undefined),
    };
    const planAndDispatch = vi.fn(async () => noopPlanResult());
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
    await flushDirector();
    await director.stop();

    expect(planAndDispatch).toHaveBeenCalledTimes(1);
    expect(planAndDispatch.mock.calls[0]?.[0].operatorGoal).toBe(
      "获取 stone_pickaxe",
    );
    expect(director.getCurrentTask(record.botId)).toMatchObject({
      title: expect.stringContaining("stone_pickaxe"),
    });
  });

  it("re-bootstraps after a death wipe by re-deriving basic needs", async () => {
    const record = readyRecord("studio-bot-01");
    record.currentStatus!.inventory = [];
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn(() => () => undefined),
    };
    const planAndDispatch = vi.fn(async () => noopPlanResult());
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
    await flushDirector();
    await director.stop();

    // Empty inventory selects the same first goal as a fresh spawn; death
    // recovery is the needs ladder itself, not a special case.
    expect(planAndDispatch.mock.calls[0]?.[0].operatorGoal).toBe(
      "获取 wooden_pickaxe",
    );
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
    await flushDirector();
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
    const planAndDispatch = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<{
          action: "noop";
          reasonCode: "NO_SAFE_SKILL";
          ai: never;
        }>((resolve) => {
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
      if (request.operatorGoal === "获取 wooden_pickaxe") {
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
          matches: [{ x: 10, y: 70, z: 0, distance: 10 }],
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
    await flushDirector();

    expect(plannerCalls.filter(({ botId }) => botId === "studio-bot-01").map(({ operatorGoal }) => operatorGoal)).toEqual([
      "获取 wooden_pickaxe",
      expect.stringContaining("oak_log 方块分布"),
      expect.stringContaining("x=10 y=70 z=0"),
      "获取 wooden_pickaxe",
    ]);
    expect(plannerCalls.filter(({ botId }) => botId === "studio-bot-02")).toHaveLength(1);
    expect(director.getCurrentTask("studio-bot-01")).toMatchObject({
      status: "completed",
      title: expect.stringContaining("wooden_pickaxe"),
    });
    await director.stop();
  });

  it("explores outward and retains the same need when a resource is not visible", async () => {
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
      if (request.operatorGoal === "获取 wooden_pickaxe") {
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
    await flushDirector();

    expect(planAndDispatch).toHaveBeenCalledTimes(3);
    const explorationGoal = planAndDispatch.mock.calls[2]?.[0].operatorGoal ?? "";
    expect(explorationGoal).toMatch(/^移动到坐标 x=-?\d+ y=64 z=-?\d+ 附近，继续观察 oak_log 方块$/);
    // The first exploration ring is 48 blocks from the real position (0, 64, 0).
    const coords = /x=(-?\d+) y=(-?\d+) z=(-?\d+)/.exec(explorationGoal)!;
    const distance = Math.hypot(Number(coords[1]), Number(coords[3]));
    expect(distance).toBeGreaterThanOrEqual(40);
    expect(director.getCurrentTask("studio-bot-01")).toMatchObject({
      status: "failed",
      title: expect.stringContaining("wooden_pickaxe"),
    });

    // A later liveness event retries the same need after the cooldown; the
    // director must not silently abandon the tool ladder.
    nowMs += 11_000;
    registryListeners.forEach((listener) => listener(record));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(planAndDispatch.mock.calls[3]?.[0].operatorGoal).toBe(
      "获取 wooden_pickaxe",
    );
    await director.stop();
  });

  it("continues directed mining without dispatching a surface movement", async () => {
    const record = readyRecord("studio-bot-01");
    record.currentStatus!.inventory = [
      { itemName: "cooked_beef", count: 12 },
      { itemName: "oak_log", count: 16 },
      { itemName: "crafting_table", count: 1 },
      { itemName: "cobblestone", count: 8 },
      { itemName: "stone_pickaxe", count: 1 },
      { itemName: "stone_sword", count: 1 },
      { itemName: "furnace", count: 1 },
    ];
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
    const planAndDispatch = vi.fn(async () =>
      failedPlanResult("COLLECT_TARGET_UNREACHABLE"),
    );
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
    await flushDirector();

    // With stone tools done, the ladder demands the iron pickaxe whose source
    // is iron ore; an unreachable ore target keeps mining in place.
    expect(planAndDispatch).toHaveBeenCalledTimes(1);
    expect(planAndDispatch.mock.calls[0]?.[0].operatorGoal).toBe(
      "获取 iron_pickaxe",
    );
    expect(
      planAndDispatch.mock.calls.some(([request]) =>
        request.operatorGoal.startsWith("移动到坐标"),
      ),
    ).toBe(false);
    expect(director.getCurrentTask(record.botId)).toMatchObject({
      status: "failed",
      title: "自主恢复: 继续定向开掘 iron_ore",
    });

    nowMs += 11_000;
    registryListeners.forEach((listener) => listener(record));
    await flushDirector();

    expect(planAndDispatch).toHaveBeenCalledTimes(2);
    expect(planAndDispatch.mock.calls[1]?.[0].operatorGoal).toBe(
      "获取 iron_pickaxe",
    );
    await director.stop();
  });

  it("seals a shelter with carried cobblestone when everything else is satisfied", async () => {
    const record = readyRecord("studio-bot-01");
    record.currentStatus!.armorPoints = 20;
    record.currentStatus!.inventory = satisfiedInventory().concat([
      { itemName: "cobblestone", count: 16 },
    ]);
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn(() => () => undefined),
    };
    const planAndDispatch = vi.fn(async () =>
      failedPlanResult("SHELTER_STEP_BLOCKED"),
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
    await flushDirector();

    expect(planAndDispatch).toHaveBeenCalledTimes(1);
    expect(planAndDispatch.mock.calls[0]?.[0].operatorGoal).toBe(
      "在当前维度向 north 挖一个 2 格深的安全避难所，并用 cobblestone 封口",
    );
    expect(director.getCurrentTask(record.botId)).toMatchObject({
      title: expect.stringContaining("避难所"),
    });
    await director.stop();
  });

  it("interrupt-class failures resume immediately without cooldown or counting (战斗/L0 抢占恢复语义)", async () => {
    const record = readyRecord("studio-bot-01");
    let nowMs = NOW.getTime();
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn(() => () => undefined),
    };
    // SKILL_CANCELLED = 战斗反应/L0 抢占了运动——任务被打断而非失败。
    const planAndDispatch = vi.fn(async () =>
      failedPlanResult("SKILL_CANCELLED"),
    );
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 30_000,
      terminalRetentionMs: 10_000,
      now: () => new Date(nowMs),
      randomId: uuidSequence(),
    });

    director.start();
    await flushDirector();
    // 中断零冷却：+1s 就应重派（正常失败要等 30s failureCooldown）
    nowMs += 1_000;
    registrySubscribeKick(registry, record);
    await flushDirector();
    nowMs += 1_000;
    registrySubscribeKick(registry, record);
    await flushDirector();

    expect(planAndDispatch).toHaveBeenCalledTimes(3);
    // 中断不计数：连续 5 次中断也不触发 3 次失败抑制（第 4 次调用仍在派同一需求）
    for (let i = 0; i < 3; i += 1) {
      nowMs += 1_000;
      registrySubscribeKick(registry, record);
      await flushDirector();
    }
    const goals = planAndDispatch.mock.calls.map(([r]) => r.operatorGoal);
    expect(goals.every((g) => g === goals[0])).toBe(true);
    await director.stop();
  });

  it("chains to the next goal within 1s after completion (任务链衔接)", async () => {
    const record = readyRecord("studio-bot-01");
    let nowMs = NOW.getTime();
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn(() => () => undefined),
    };
    // 第一发完成（拿到木镐假设），第二发应立即衔接
    let call = 0;
    const planAndDispatch = vi.fn(async () => {
      call += 1;
      return call === 1 ? completedPlanResult("collect.block", {}) : noopPlanResult();
    });
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 30_000,
      terminalRetentionMs: 10_000,
      now: () => new Date(nowMs),
      randomId: uuidSequence(),
    });
    director.start();
    await flushDirector();
    expect(planAndDispatch).toHaveBeenCalledTimes(1);
    // +1.1s：链式衔接（旧实现要等 interval 60s）
    nowMs += 1_100;
    registrySubscribeKick(registry, record);
    await flushDirector();
    expect(planAndDispatch).toHaveBeenCalledTimes(2);
    await director.stop();
  });

  it("rotates shelter direction, then suppresses the need after repeated failure", async () => {
    const record = readyRecord("studio-bot-01");
    record.currentStatus!.armorPoints = 20;
    record.currentStatus!.inventory = satisfiedInventory().concat([
      { itemName: "dirt", count: 16 },
    ]);
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
    const planAndDispatch = vi.fn(async () =>
      failedPlanResult("SHELTER_STEP_BLOCKED"),
    );
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
    await flushDirector();
    for (let attempt = 1; attempt < 4; attempt += 1) {
      nowMs += 11_000;
      registryListeners.forEach((listener) => listener(record));
      await flushDirector();
    }

    expect(
      planAndDispatch.mock.calls.map(([request]) => request.operatorGoal),
    ).toEqual([
      "在当前维度向 north 挖一个 2 格深的安全避难所，并用 dirt 封口",
      "在当前维度向 east 挖一个 2 格深的安全避难所，并用 dirt 封口",
      "在当前维度向 south 挖一个 2 格深的安全避难所，并用 dirt 封口",
      expect.stringMatching(/^移动到坐标/),
    ]);
    // The third failure suppresses SHELTER for the cooldown window; a later
    // kick may dispatch other needs (e.g. exploration) but never a fourth
    // identical shelter attempt.
    const shelterAttempts = planAndDispatch.mock.calls.filter(
      ([request]) => request.operatorGoal.includes("安全避难所"),
    ).length;
    expect(shelterAttempts).toBe(3);
    await director.stop();
  });

  it("consults the replan oracle on suppression and applies its substitute", async () => {
    const record = readyRecord("studio-bot-01");
    record.currentStatus!.inventory = [
      { itemName: "stone_pickaxe", count: 1 },
      { itemName: "oak_log", count: 16 },
      { itemName: "cooked_beef", count: 12 },
      { itemName: "stone_sword", count: 1 },
    ];
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
    // 需求 3 连败后：COAL 目标一直不可达；神谕建议改采木炭。
    const generate = vi.fn(async () => ({
      requestId: "replan-1",
      botId: "studio-bot-01",
      priority: 5,
      value: {
        content: JSON.stringify({
          strategy: "substitute-resource",
          substituteItem: "charcoal",
          magnitude: null,
        }),
        usage: { promptTokens: 10, completionTokens: 10 },
      },
      attempts: 1,
      enqueuedAt: "",
      startedAt: "",
      completedAt: "",
      queueTimeMs: 0,
      executionTimeMs: 1,
      totalTimeMs: 1,
    }));
    const planAndDispatch = vi.fn(async (request: { operatorGoal: string }) => {
      if (request.operatorGoal.startsWith("获取 coal")) {
        return failedPlanResult("COLLECT_TARGET_UNREACHABLE");
      }
      return noopPlanResult();
    });
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      replanAI: { generate },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 1_000,
      terminalRetentionMs: 10_000,
      now: () => new Date(nowMs),
      randomId: uuidSequence(),
    });

    director.start();
    await flushDirector();
    // 三次失败触发抑制：1 次起始 + 2 次重试。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      nowMs += 11_000;
      registryListeners.forEach((listener) => listener(record));
      await flushDirector();
    }
    // 神谕已被咨询（抑制触发时恰好一次），且提示词只包含安全的需要摘要。
    expect(generate).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse(generate.mock.calls[0]![0].prompt);
    expect(prompt.need).toBe("TOOL_PROGRESSION");
    expect(prompt.needReason).toBe("pickaxe tier stone_pickaxe < next iron_pickaxe");
    // 抑制不影响自主性：窗口过后继续派发确定性目标。
    nowMs += 130_000;
    registryListeners.forEach((listener) => listener(record));
    await flushDirector();
    const after = planAndDispatch.mock.calls.length;
    expect(after).toBeGreaterThan(3);
    await director.stop();
  });

  it("explores new sectors once every survival need is satisfied", async () => {
    const record = readyRecord("studio-bot-01");
    record.currentStatus!.armorPoints = 20;
    record.currentStatus!.inventory = satisfiedInventory().concat([
      { itemName: "dirt", count: 16 },
    ]);
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
    // First the bot finishes its one-time shelter, then nothing is left but
    // exploration toward the next tier's ore.
    const planAndDispatch = vi.fn(async (request: { operatorGoal: string }) =>
      request.operatorGoal.includes("安全避难所")
        ? completedPlanResult("shelter.dig", {})
        : noopPlanResult(),
    );
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
    await flushDirector();
    // A completed goal cools down for intervalMs before the next dispatch.
    nowMs += 61_000;
    registryListeners.forEach((listener) => listener(record));
    await flushDirector();
    await director.stop();

    expect(planAndDispatch.mock.calls[0]?.[0].operatorGoal).toContain(
      "安全避难所",
    );
    // Fully-equipped, sheltered bot keeps working: exploration toward the
    // next tier's ore instead of looping on wood or re-digging shelters.
    expect(planAndDispatch.mock.calls[1]?.[0].operatorGoal).toMatch(
      /^移动到坐标 x=-?\d+ y=64 z=-?\d+ 附近，继续观察 diamond_ore 方块$/,
    );
  });
});

async function flushDirector(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

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

/** Every survival need satisfied except SHELTER (memory-gated, starts false). */
function satisfiedInventory(): ReadonlyArray<{ itemName: string; count: number }> {
  return [
    { itemName: "cooked_beef", count: 12 },
    { itemName: "oak_log", count: 16 },
    { itemName: "diamond_pickaxe", count: 1 },
    { itemName: "diamond_axe", count: 1 },
    { itemName: "diamond_shovel", count: 1 },
    { itemName: "diamond_hoe", count: 1 },
    { itemName: "diamond_sword", count: 1 },
    { itemName: "diamond_helmet", count: 1 },
    { itemName: "diamond_chestplate", count: 1 },
    { itemName: "diamond_leggings", count: 1 },
    { itemName: "diamond_boots", count: 1 },
    { itemName: "diamond", count: 3 },
    { itemName: "iron_ingot", count: 6 },
    { itemName: "shield", count: 1 },
    { itemName: "chest", count: 1 },
    { itemName: "coal", count: 8 },
    { itemName: "torch", count: 16 },
  ];
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

function registrySubscribeKick(
  registry: { subscribe: { mock: { calls: Array<[listener: (record: BotRegistryRecord) => void]> } } },
  record: BotRegistryRecord,
): void {
  for (const [listener] of registry.subscribe.mock.calls) listener(record);
}
