// Phase 1（Implementation Prompt V1）测试：基地阶段门 + 批间链。
//
// 三个层次：
//   A. BasePhaseTracker：needKey 完成→门置位、外部真值并集、空快照。
//   B. survival-needs：basePhase 七门顺序放行 BASE_* 需求；未传入=静默。
//   C. director 集成：多批蓝图批间链（锚点钉死+startIndex 续派）与
//      阶段门的完成语义（单批 skill 成功 ≠ 建成）。

import { describe, expect, it, vi } from "vitest";
import type { BotRegistryRecord } from "../src/bot-registry.js";
import { AutonomousDirector } from "../src/autonomous-director.js";
import {
  BASE_PHASE_KEYS,
  BasePhaseTracker,
  emptyBasePhaseSnapshot,
} from "../src/base-phase-state.js";
import { assessSurvivalNeeds } from "../src/survival-needs.js";

const NOW = new Date("2026-08-28T00:00:00.000Z");

// ---------------------------------------------------------------------------
// A. BasePhaseTracker
// ---------------------------------------------------------------------------

describe("BasePhaseTracker", () => {
  it("maps needKey completions to phase gates and leaves others null", () => {
    const tracker = new BasePhaseTracker();
    expect(tracker.recordNeedCompletion("bot-1", "WOOD_RESERVE")).toBeNull();
    expect(tracker.snapshotFor("bot-1")).toEqual(emptyBasePhaseSnapshot());

    expect(tracker.recordNeedCompletion("bot-1", "SHELTER")).toBe("SHELTER_MINIMAL_READY");
    expect(tracker.recordNeedCompletion("bot-1", "BASE_SITE_SELECTION")).toBe("BASE_SITE_RESERVED");
    expect(tracker.recordNeedCompletion("bot-1", "BASE_MAIN_CONSTRUCTION")).toBe("STARTER_BASE_ACTIVE");
    expect(tracker.recordNeedCompletion("bot-1", "BASE_FACILITY_COBBLE")).toBe("COBBLE_FACILITY_ACTIVE");
    expect(tracker.recordNeedCompletion("bot-1", "BASE_FACILITY_FARM")).toBe("FOOD_FACILITY_ACTIVE");
    // 未接线阶段（村庄/交易大厅）无 needKey 映射——只能由外部真值置位。
    expect(tracker.recordNeedCompletion("bot-1", "EXPLORATION")).toBeNull();

    const snapshot = tracker.snapshotFor("bot-1");
    expect(snapshot.SHELTER_MINIMAL_READY).toBe(true);
    expect(snapshot.BASE_SITE_RESERVED).toBe(true);
    expect(snapshot.STARTER_BASE_ACTIVE).toBe(true);
    expect(snapshot.COBBLE_FACILITY_ACTIVE).toBe(false);
    expect(snapshot.FOOD_FACILITY_ACTIVE).toBe(false);
    expect(snapshot.VILLAGE_SOURCE_VERIFIED).toBe(false);
    expect(snapshot.TRADING_HALL_ACTIVE).toBe(false);
    // per-bot 隔离
    expect(tracker.snapshotFor("bot-2").SHELTER_MINIMAL_READY).toBe(false);
  });

  it("requires external domain evidence when a registry source is configured", () => {
    const tracker = new BasePhaseTracker(() => ({
      FOOD_FACILITY_ACTIVE: true,
      VILLAGE_SOURCE_VERIFIED: true,
    }));
    tracker.recordNeedCompletion("bot-1", "SHELTER");
    const snapshot = tracker.snapshotFor("bot-1");
    expect(snapshot.SHELTER_MINIMAL_READY).toBe(false);
    expect(snapshot.FOOD_FACILITY_ACTIVE).toBe(true);
    expect(snapshot.VILLAGE_SOURCE_VERIFIED).toBe(true);
    expect(snapshot.BASE_SITE_RESERVED).toBe(false);
  });

  it("exposes all seven phase keys in the empty snapshot", () => {
    const snapshot = emptyBasePhaseSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual([...BASE_PHASE_KEYS].sort());
    for (const value of Object.values(snapshot)) expect(value).toBe(false);
  });

  it("revokes availability on explicit false and on negative world evidence", () => {
    const tracker = new BasePhaseTracker();
    tracker.forcePhase("bot-1", "STARTER_BASE_ACTIVE");
    tracker.forcePhase("bot-1", "STARTER_BASE_ACTIVE", false);
    expect(tracker.snapshotFor("bot-1").STARTER_BASE_ACTIVE).toBe(false);
    let available = true;
    const sourced = new BasePhaseTracker(() => ({ STARTER_BASE_ACTIVE: available }));
    sourced.forcePhase("bot-1", "STARTER_BASE_ACTIVE");
    expect(sourced.snapshotFor("bot-1").STARTER_BASE_ACTIVE).toBe(true);
    available = false;
    expect(sourced.snapshotFor("bot-1").STARTER_BASE_ACTIVE).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. survival-needs 阶段门
// ---------------------------------------------------------------------------

describe("survival-needs base phase gating", () => {
  it("stays silent when basePhase is not supplied (capability unwired)", () => {
    const needs = assess({ basePhase: undefined });
    expect(needs.find((n) => n.key.startsWith("BASE_"))).toBeUndefined();
    expect(needs.map((n) => n.key)).toEqual(["EXPLORATION"]);
  });

  it("emits BASE_SITE_SELECTION once diamond set is complete and shelter gate is ready", () => {
    const needs = assess({ basePhase: phase({ SHELTER_MINIMAL_READY: true }) });
    expect(needs.map((n) => n.key)).toEqual(["BASE_SITE_SELECTION", "EXPLORATION"]);
    expect(needs[0]).toMatchObject({ score: 47, operatorGoal: "向外探索新区域" });
  });

  it("requires the full diamond set before site selection", () => {
    const noSword = satisfied().filter((i) => i.itemName !== "diamond_sword");
    const needs = assess({ inventory: noSword, basePhase: phase({ SHELTER_MINIMAL_READY: true }) });
    expect(needs.find((n) => n.key === "BASE_SITE_SELECTION")).toBeUndefined();
  });

  it("replaces site selection with main construction once the site is reserved", () => {
    const needs = assess({
      basePhase: phase({ SHELTER_MINIMAL_READY: true, BASE_SITE_RESERVED: true }),
    });
    expect(needs.map((n) => n.key)).toEqual(["BASE_MAIN_CONSTRUCTION", "EXPLORATION"]);
    expect(needs[0]).toMatchObject({
      score: 46,
      operatorGoal: "使用蓝图文件 starter-base-v1 施工",
    });
  });

  it("emits cobble then farm once the starter base is active, in ladder order", () => {
    const needs = assess({
      basePhase: phase({ SHELTER_MINIMAL_READY: true, BASE_SITE_RESERVED: true, STARTER_BASE_ACTIVE: true }),
    });
    const baseKeys = needs.filter((n) => n.key.startsWith("BASE_")).map((n) => n.key);
    expect(baseKeys).toEqual(["BASE_FACILITY_COBBLE", "BASE_FACILITY_FARM"]);
    expect(needs[0]).toMatchObject({ score: 45, operatorGoal: "使用蓝图文件 cobble-generator 施工" });
    expect(needs[1]).toMatchObject({ score: 44, operatorGoal: "使用蓝图文件 carrot-farm-9x9 施工" });
  });

  it("retires each facility need as its gate flips", () => {
    const cobbleDone = assess({
      basePhase: phase({
        SHELTER_MINIMAL_READY: true, BASE_SITE_RESERVED: true, STARTER_BASE_ACTIVE: true,
        COBBLE_FACILITY_ACTIVE: true,
      }),
    });
    expect(cobbleDone.filter((n) => n.key.startsWith("BASE_")).map((n) => n.key))
      .toEqual(["BASE_FACILITY_FARM"]);

    const allDone = assess({
      basePhase: phase({
        SHELTER_MINIMAL_READY: true, BASE_SITE_RESERVED: true, STARTER_BASE_ACTIVE: true,
        COBBLE_FACILITY_ACTIVE: true, FOOD_FACILITY_ACTIVE: true,
      }),
    });
    expect(allDone.find((n) => n.key.startsWith("BASE_"))).toBeUndefined();
  });

  it("keeps the base pipeline hard-blocked while the shelter gate is unready", () => {
    // 阶段门已接线（basePhase 传入）但避难所未就绪 → 整条基地流水线静默：
    // 硬门禁的真语义——钻套齐全也不能在没有庇护时开始建基地。
    const needs = assess({ basePhase: phase({}) });
    expect(needs.find((n) => n.key.startsWith("BASE_"))).toBeUndefined();
  });

  it("emits BED once the shelter is ready and no bed is held", () => {
    const noBed = satisfied().filter((i) => i.itemName !== "bed");
    const needs = assess({ inventory: noBed, shelterBuilt: true, basePhase: undefined });
    expect(needs.find((n) => n.key === "BED")).toMatchObject({
      score: 50,
      operatorGoal: expect.stringContaining("bed"),
    });
    // 有床 → 静默（acquire 一次性）。
    expect(assess({ inventory: satisfied() }).find((n) => n.key === "BED")).toBeUndefined();
  });

  it("scores SHELTER at 51 (above the whole diamond ladder) when uninjured", () => {
    // 石镐在场才触发非受伤分支的 SHELTER（pickaxeTier>=1）。
    const needs = assess({
      shelterBuilt: false,
      inventory: [{ itemName: "stone_pickaxe", count: 1 }],
    });
    const shelter = needs.find((n) => n.key === "SHELTER");
    expect(shelter).toMatchObject({ score: 51 });
  });
});

// ---------------------------------------------------------------------------
// C. director 批间链集成
// ---------------------------------------------------------------------------

describe("AutonomousDirector blueprint batch chaining", () => {
  it("pins the anchor, walks all batches, and flips the phase gate only on full completion", async () => {
    const record = readyRecord("studio-bot-01");
    let nowMs = NOW.getTime();
    const dispatchGoals: string[] = [];
    let buildDispatch = 0;
    const listeners = new Set<(record: BotRegistryRecord) => void>();
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn((listener: (record: BotRegistryRecord) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const BATCH = 18;
    const TOTAL = 85;
    const planAndDispatch = vi.fn(async (request: { operatorGoal: string }) => {
      dispatchGoals.push(request.operatorGoal);
      if (/挖一个.*避难所/.test(request.operatorGoal)) {
        return completedPlanResult("survival.shelter", {});
      }
      if (/^移动到坐标 x=-?\d+ y=\d+ z=-?\d+ 附近，继续观察 [a-z_]+ 方块$/.test(request.operatorGoal)) {
        return completedPlanResult("movement.goto", {});
      }
      if (/starter-base-v1/.test(request.operatorGoal)) {
        buildDispatch += 1;
        const final = buildDispatch * BATCH >= TOTAL;
        return blueprintPlanResult(
          {
            completed: final,
            nextIndex: Math.min(buildDispatch * BATCH, TOTAL),
            totalCells: TOTAL,
          },
          { x: 100, y: 64, z: -200 },
        );
      }
      return completedPlanResult("build.blueprint", {});
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
    // tick 1: SHELTER（51 分，唯一压过钻套齐全状态的非静默需求）
    expect(dispatchGoals[0]).toContain("避难所");

    const advance = async () => {
      nowMs += 2_000;
      for (const listener of listeners) listener(record);
      await flushDirector();
    };

    await advance(); // BASE_SITE_SELECTION
    expect(dispatchGoals[1]).toMatch(
      /^移动到坐标 x=-?\d+ y=\d+ z=-?\d+ 附近，继续观察 [a-z_]+ 方块$/,
    );

    await advance(); // 批 1：无锚点（auto-anchor 由 planner 解析）
    expect(dispatchGoals[2]).toBe("使用蓝图文件 starter-base-v1 施工");
    // 单批成功后任务完成，但阶段门不能翻：下一派仍是主体施工的续批。
    await advance();
    expect(dispatchGoals[3]).toBe(
      "使用蓝图文件 starter-base-v1 施工：锚点 x=100 y=64 z=-200，从第 18 格开始",
    );
    await advance();
    expect(dispatchGoals[4]).toContain("从第 36 格开始");
    await advance();
    expect(dispatchGoals[5]).toContain("从第 54 格开始");
    await advance();
    expect(dispatchGoals[6]).toContain("从第 72 格开始");
    // 末批 completed=true → 阶段门翻 → 下一需求是刷石机（新蓝图，无续派后缀）。
    await advance();
    expect(dispatchGoals[7]).toBe("使用蓝图文件 cobble-generator 施工");
    expect(dispatchGoals.filter((g) => g.includes("starter-base-v1")).length).toBe(5);

    await director.stop();
  });

  it("keeps the phase gate unflipped when a mid-build batch fails and resumes from stored progress", async () => {
    const record = readyRecord("studio-bot-01");
    let nowMs = NOW.getTime();
    const dispatchGoals: string[] = [];
    let buildDispatch = 0;
    const listeners = new Set<(record: BotRegistryRecord) => void>();
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn((listener: (record: BotRegistryRecord) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const planAndDispatch = vi.fn(async (request: { operatorGoal: string }) => {
      dispatchGoals.push(request.operatorGoal);
      if (/挖一个.*避难所/.test(request.operatorGoal)) {
        return completedPlanResult("survival.shelter", {});
      }
      if (/^移动到坐标 x=-?\d+ y=\d+ z=-?\d+ 附近，继续观察 [a-z_]+ 方块$/.test(request.operatorGoal)) {
        return completedPlanResult("movement.goto", {});
      }
      if (/starter-base-v1/.test(request.operatorGoal)) {
        buildDispatch += 1;
        if (buildDispatch === 2) {
          return failedPlanResult("MOVEMENT_LEASE_BUSY");
        }
        const final = buildDispatch * 18 >= 85;
        return blueprintPlanResult(
          { completed: final, nextIndex: Math.min(buildDispatch * 18, 85), totalCells: 85 },
          { x: 100, y: 64, z: -200 },
        );
      }
      return completedPlanResult("build.blueprint", {});
    });
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 1,
      terminalRetentionMs: 10_000,
      now: () => new Date(nowMs),
      randomId: uuidSequence(),
    });

    director.start();
    await flushDirector();
    const advance = async () => {
      nowMs += 2_000;
      for (const listener of listeners) listener(record);
      await flushDirector();
    };
    await advance(); // site selection
    await advance(); // build batch 1 (18/85)
    await advance(); // build batch 2 → fails
    // 失败批不推进进度；门未翻 → 重选仍是主体施工，从已存的第 18 格续派。
    await advance();
    expect(dispatchGoals[dispatchGoals.length - 1]).toContain("从第 18 格开始");
    // 阶段门始终未翻（没有刷石机需求出现过）。
    expect(dispatchGoals.some((g) => g.includes("cobble-generator"))).toBe(false);

    await director.stop();
  });

  it("preempts a mid-chain build with a survival need and resumes from stored progress", async () => {
    const record = readyRecord("studio-bot-01");
    let nowMs = NOW.getTime();
    const dispatchGoals: string[] = [];
    let buildDispatch = 0;
    const listeners = new Set<(record: BotRegistryRecord) => void>();
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn((listener: (record: BotRegistryRecord) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const planAndDispatch = vi.fn(async (request: { operatorGoal: string }) => {
      dispatchGoals.push(request.operatorGoal);
      if (/挖一个.*避难所/.test(request.operatorGoal)) {
        return completedPlanResult("survival.shelter", {});
      }
      if (/^移动到坐标 x=-?\d+ y=\d+ z=-?\d+ 附近，继续观察 [a-z_]+ 方块$/.test(request.operatorGoal)) {
        return completedPlanResult("movement.goto", {});
      }
      if (/安全食物/.test(request.operatorGoal)) {
        return completedPlanResult("food.secure", {});
      }
      if (/starter-base-v1/.test(request.operatorGoal)) {
        buildDispatch += 1;
        const final = buildDispatch * 18 >= 85;
        return blueprintPlanResult(
          { completed: final, nextIndex: Math.min(buildDispatch * 18, 85), totalCells: 85 },
          { x: 100, y: 64, z: -200 },
        );
      }
      return completedPlanResult("build.blueprint", {});
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
    const advance = async () => {
      nowMs += 2_000;
      for (const listener of listeners) listener(record);
      await flushDirector();
    };
    await advance(); // 选址
    await advance(); // 施工批 1（18/85）

    // 生存抢占：食物见底（level 12 + 储备清空）→ FOOD_SECURITY(92) 压过
    // 续批(46)。下一个派发必须是食物，不是施工第二批。
    record.currentStatus!.food.level = 12;
    (record.currentStatus!.inventory as Array<{ itemName: string; count: number }>) =
      satisfied().filter((i) => i.itemName !== "cooked_beef");
    await advance();
    expect(dispatchGoals[dispatchGoals.length - 1]).toMatch(/^获取安全食物/);

    // 恢复：食物补回 → 施工从已存进度续派（锚点不变、startIndex 不回退）。
    record.currentStatus!.food.level = 20;
    (record.currentStatus!.inventory as Array<{ itemName: string; count: number }>) = satisfied();
    await advance();
    expect(dispatchGoals[dispatchGoals.length - 1]).toBe(
      "使用蓝图文件 starter-base-v1 施工：锚点 x=100 y=64 z=-200，从第 18 格开始",
    );

    await director.stop();
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function phase(overrides: Partial<ReturnType<typeof emptyBasePhaseSnapshot>>) {
  return { ...emptyBasePhaseSnapshot(), ...overrides };
}

function assess(options: {
  inventory?: ReadonlyArray<{ itemName: string; count: number }>;
  shelterBuilt?: boolean;
  basePhase?: ReturnType<typeof emptyBasePhaseSnapshot> | null;
}): ReturnType<typeof assessSurvivalNeeds> {
  return assessSurvivalNeeds({
    shelterBuilt: options.shelterBuilt ?? true,
    ...(options.basePhase !== undefined ? { basePhase: options.basePhase } : {}),
    record: recordWith(options.inventory ?? satisfied()),
  });
}

function recordWith(
  inventory: ReadonlyArray<{ itemName: string; count: number }>,
): BotRegistryRecord {
  return {
    botId: "studio-bot-01",
    serverProfileId: "local-isolated-test",
    runtimeInstanceId: "runtime-studio-bot-01",
    connectionState: "online",
    lastSequence: 1,
    lastObservedAt: NOW.toISOString(),
    lastMessageAt: NOW.toISOString(),
    lastHeartbeatAt: NOW.toISOString(),
    lastStatusAt: NOW.toISOString(),
    currentStatus: {
      serverProfileId: "local-isolated-test",
      runtimeInstanceId: "runtime-studio-bot-01",
      sequence: 1,
      observedAt: NOW.toISOString(),
      connectionState: "online",
      health: { current: 20, maximum: 20 },
      food: { level: 20, saturation: 5 },
      armorPoints: 20,
      position: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
      latencyMs: 10,
      currentTask: null,
      safety: {
        mode: "monitoring",
        activeRisks: [],
        normalTasksPaused: false,
        lastDecisionId: null,
        lastAction: null,
      },
      inventory,
    },
    minecraftVersion: null,
    skillCatalog: {
      serverProfileId: "local-isolated-test",
      runtimeInstanceId: "runtime-studio-bot-01",
      sequence: 1,
      observedAt: NOW.toISOString(),
      minecraftVersion: "1.21.8",
      protocolVersion: 772,
      skills: [{ availability: "available" }],
    } as never,
    offlineReason: null,
  } as unknown as BotRegistryRecord;
}

function satisfied(): ReadonlyArray<{ itemName: string; count: number }> {
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
    { itemName: "bed", count: 1 },
    { itemName: "diamond", count: 3 },
    { itemName: "iron_ingot", count: 6 },
    { itemName: "shield", count: 1 },
    { itemName: "chest", count: 1 },
    { itemName: "coal", count: 8 },
    { itemName: "torch", count: 16 },
  ];
}

function readyRecord(botId: string): BotRegistryRecord {
  return recordWith(satisfied()) as BotRegistryRecord & { botId: string };
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

function failedPlanResult(errorCode: string): never {
  return {
    action: "skill_result",
    reasonCode: "ADVANCE_TASK",
    invocation: { payload: { skillId: "collect.block" } },
    result: { payload: { outcome: "failed", errorCode } },
    ai: {},
  } as never;
}

function blueprintPlanResult(
  output: { completed: boolean; nextIndex: number; totalCells: number },
  anchor: { x: number; y: number; z: number },
): never {
  return {
    action: "skill_result",
    reasonCode: "DETERMINISTIC_BLUEPRINT_FILE",
    invocation: {
      payload: {
        skillId: "build.blueprint",
        input: {
          blueprint: { anchor, dimension: "minecraft:overworld", cells: [] },
          maxPlacements: 18,
        },
      },
    },
    result: { payload: { outcome: "completed", output } },
    ai: null,
  } as never;
}

async function flushDirector(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function uuidSequence(): () => string {
  let value = 0;
  return () => `00000000-0000-4000-8000-${(++value).toString().padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------
// D. 选址 Spark 评审（site-verdict 接线）
// ---------------------------------------------------------------------------

describe("AutonomousDirector site verdict consult", () => {
  it("reject re-explores the next sector, accept opens construction (facts flow into the prompt)", async () => {
    const record = readyRecord("studio-bot-01");
    let nowMs = NOW.getTime();
    const dispatchGoals: string[] = [];
    const prompts: string[] = [];
    const verdicts: Array<"reject" | "accept"> = ["reject", "accept"];
    let verdictCall = 0;
    const listeners = new Set<(record: BotRegistryRecord) => void>();
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn((listener: (record: BotRegistryRecord) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const planAndDispatch = vi.fn(async (request: { operatorGoal: string }) => {
      dispatchGoals.push(request.operatorGoal);
      if (/挖一个.*避难所/.test(request.operatorGoal)) {
        return completedPlanResult("survival.shelter", {});
      }
      const scanMatch = /读取当前区域的\s+([a-z0-9_]+)\s+方块分布/.exec(request.operatorGoal);
      if (scanMatch !== null) {
        // 岩浆贴脸（3 格）——评审应看到硬伤事实
        const matches = scanMatch[1] === "lava"
          ? [{ x: 3, y: 64, z: 3, distance: 3 }]
          : scanMatch[1] === "hay_block"
            ? [{ x: -20, y: 64, z: -8, distance: 22 }]
            : [];
        return scanPlanResult(scanMatch[1]!, matches);
      }
      if (/^移动到坐标 x=-?\d+ y=\d+ z=-?\d+ 附近，继续观察 [a-z_]+ 方块$/.test(request.operatorGoal)) {
        return completedPlanResult("movement.goto", {});
      }
      return completedPlanResult("build.blueprint", {});
    });
    const siteAI = {
      generate: vi.fn(async (request: { prompt: string }) => {
        prompts.push(request.prompt);
        const verdict = verdicts[Math.min(verdictCall, verdicts.length - 1)]!;
        verdictCall += 1;
        return { value: { content: JSON.stringify({ verdict, confidence: 0.8, reasons: [verdict === "reject" ? "岩浆太近" : "村庄近且无硬伤"] }) } };
      }),
    };
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 5_000,
      terminalRetentionMs: 10_000,
      now: () => new Date(nowMs),
      randomId: uuidSequence(),
      siteAI: siteAI as never,
    });

    director.start();
    await flushDirector();
    const advance = async () => {
      nowMs += 2_000;
      for (const listener of listeners) listener(record);
      await flushDirector();
    };

    await advance(); // 选址移动 #1 完成 → 评审 #1（reject）
    await director.waitForSiteVerdicts();
    // 门未翻：reject 后仍是选址移动（新扇区），且评审 #2 已在飞——此时
    // 主体施工从未派发过。
    await advance();
    expect(dispatchGoals.some((g) => g.includes("starter-base-v1"))).toBe(false);
    // 事实采集真的发生了（4 项只读扫描），事实进了 prompt（岩浆 3 格）
    expect(dispatchGoals.filter((g) => g.includes("读取当前区域")).length).toBeGreaterThanOrEqual(4);
    expect(prompts[0]).toContain("最近 3 格");
    expect(prompts[0]).not.toMatch(/x\s*[:=]\s*-?\d+/);

    await director.waitForSiteVerdicts(); // 评审 #2（accept）
    await advance(); // 主体施工开工
    expect(dispatchGoals[dispatchGoals.length - 1]).toBe("使用蓝图文件 starter-base-v1 施工");
    // 选址移动恰好 2 次（reject 重探一次，accept 后不再走）
    expect(dispatchGoals.filter((g) => /^移动到坐标/.test(g))).toHaveLength(2);
    expect(siteAI.generate).toHaveBeenCalledTimes(2);

    await director.stop();
  });

  it("fails open when the model is unavailable (site reserved, pipeline continues)", async () => {
    const record = readyRecord("studio-bot-01");
    let nowMs = NOW.getTime();
    const dispatchGoals: string[] = [];
    const listeners = new Set<(record: BotRegistryRecord) => void>();
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn((listener: (record: BotRegistryRecord) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const planAndDispatch = vi.fn(async (request: { operatorGoal: string }) => {
      dispatchGoals.push(request.operatorGoal);
      if (/挖一个.*避难所/.test(request.operatorGoal)) {
        return completedPlanResult("survival.shelter", {});
      }
      if (/读取当前区域/.test(request.operatorGoal)) {
        return scanPlanResult("air", []);
      }
      return completedPlanResult("movement.goto", {});
    });
    const siteAI = {
      generate: vi.fn(async () => {
        throw new Error("spark hub down");
      }),
    };
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 5_000,
      terminalRetentionMs: 10_000,
      now: () => new Date(nowMs),
      randomId: uuidSequence(),
      siteAI: siteAI as never,
    });

    director.start();
    await flushDirector();
    const advance = async () => {
      nowMs += 2_000;
      for (const listener of listeners) listener(record);
      await flushDirector();
    };
    await advance(); // 选址移动完成 → 评审（模型挂）
    await director.waitForSiteVerdicts();
    await advance(); // fail-open：门已翻 → 主体施工
    expect(dispatchGoals[dispatchGoals.length - 1]).toBe("使用蓝图文件 starter-base-v1 施工");

    await director.stop();
  });

  it("force-accepts after the reject limit instead of consulting forever", async () => {
    const record = readyRecord("studio-bot-01");
    let nowMs = NOW.getTime();
    const listeners = new Set<(record: BotRegistryRecord) => void>();
    const registry = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      subscribe: vi.fn((listener: (record: BotRegistryRecord) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const planAndDispatch = vi.fn(async (request: { operatorGoal: string }) => {
      if (/挖一个.*避难所/.test(request.operatorGoal)) {
        return completedPlanResult("survival.shelter", {});
      }
      if (/读取当前区域/.test(request.operatorGoal)) {
        return scanPlanResult("air", []);
      }
      return completedPlanResult("movement.goto", {});
    });
    const siteAI = {
      generate: vi.fn(async () => ({
        value: { content: JSON.stringify({ verdict: "reject", confidence: 0.9, reasons: ["永远看不上"] }) },
      })),
    };
    const director = new AutonomousDirector({
      registry,
      planner: { planAndDispatch },
      intervalMs: 60_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 5_000,
      terminalRetentionMs: 10_000,
      now: () => new Date(nowMs),
      randomId: uuidSequence(),
      siteAI: siteAI as never,
    });

    director.start();
    await flushDirector();
    const advance = async () => {
      nowMs += 2_000;
      for (const listener of listeners) listener(record);
      await flushDirector();
    };
    for (let round = 0; round < 3; round += 1) {
      await advance(); // 选址移动 → 评审 reject ×3
      await director.waitForSiteVerdicts();
    }
    expect(siteAI.generate).toHaveBeenCalledTimes(3);
    await advance(); // 第 4 次完成：不再评审，直接翻门
    expect(siteAI.generate).toHaveBeenCalledTimes(3);
    await advance(); // 主体施工
    const goals = planAndDispatch.mock.calls.map(([request]: [{ operatorGoal: string }]) => request.operatorGoal);
    expect(goals[goals.length - 1]).toBe("使用蓝图文件 starter-base-v1 施工");

    await director.stop();
  });
});

function scanPlanResult(
  blockName: string,
  matches: ReadonlyArray<{ x: number; y: number; z: number; distance: number }>,
): never {
  return {
    action: "skill_result",
    reasonCode: "DETERMINISTIC_SCAN",
    invocation: { payload: { skillId: "world.scan" } },
    result: {
      payload: {
        outcome: "completed",
        output: {
          blockName,
          dimension: "minecraft:overworld",
          matches,
          targetsFound: matches.length,
          complete: true,
        },
      },
    },
    ai: null,
  } as never;
}
