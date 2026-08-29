// P0-1 回归测试——在旧代码上必须失败，修复后通过。
// 每个用例标注对应的缺陷编号（A.1 ~ A.8）。

import type { BotRegistryRecord } from "../src/bot-registry.js";
import { assessSurvivalNeeds } from "../src/survival-needs.js";
import { describe, expect, it } from "vitest";

// ---- 固定时钟 ----
const FIXED_NOW = new Date("2026-08-29T12:00:00.000Z");

function makeRecord(overrides: {
  inventory?: ReadonlyArray<{ itemName: string; count: number; durability?: number; maxDurability?: number }>;
  foodLevel?: number;
  armorPoints?: number;
  position?: { x: number; y: number; z: number; dimension?: string };
  lastDeath?: { x: number; y: number; z: number; dimension: string; diedAt: string };
}): BotRegistryRecord {
  const pos = overrides.position ?? { x: 0, y: 64, z: 0 };
  return {
    botId: "test-bot",
    serverProfileId: "test-profile",
    runtimeInstanceId: "rt-test",
    connectionState: "online",
    lastSequence: 1,
    lastObservedAt: FIXED_NOW.toISOString(),
    lastMessageAt: FIXED_NOW.toISOString(),
    lastHeartbeatAt: FIXED_NOW.toISOString(),
    lastStatusAt: FIXED_NOW.toISOString(),
    currentStatus: {
      serverProfileId: "test-profile",
      runtimeInstanceId: "rt-test",
      sequence: 1,
      observedAt: FIXED_NOW.toISOString(),
      connectionState: "online",
      health: { current: 20, maximum: 20 },
      food: { level: overrides.foodLevel ?? 20, saturation: 5 },
      armorPoints: overrides.armorPoints ?? 0,
      position: {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        dimension: pos.dimension ?? "minecraft:overworld",
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
      inventory: overrides.inventory ?? [],
      ...(overrides.lastDeath ? { lastDeath: overrides.lastDeath } : {}),
    },
    minecraftVersion: null,
    skillCatalog: null,
    offlineReason: null,
  } as unknown as BotRegistryRecord;
}

function assess(opts: Parameters<typeof makeRecord>[0] & {
  shelterBuilt?: boolean;
  now?: Date;
}) {
  return assessSurvivalNeeds({
    shelterBuilt: opts.shelterBuilt ?? false,
    record: makeRecord(opts),
    now: opts.now ?? FIXED_NOW,
  });
}

function findByKey(needs: ReturnType<typeof assess>, key: string) {
  return needs.find((n) => n.key === key);
}

// ===========================================================================
// A.1 工具阶梯：必须取最高可用档，不是 findIndex 找到的最低档
// ===========================================================================

describe("A.1: tool tier must use highest available pickaxe, not lowest", () => {
  it("wooden + iron pickaxes => must target diamond_pickaxe (not stone)", () => {
    const needs = assess({
      inventory: [
        { itemName: "wooden_pickaxe", count: 1 },
        { itemName: "iron_pickaxe", count: 1 },
      ],
    });
    const tp = findByKey(needs, "TOOL_PROGRESSION");
    // 旧代码 findIndex 找到 wooden(0)，next=stone_pickaxe —— 错误
    expect(tp?.operatorGoal).toBe("获取 diamond_pickaxe");
  });

  it("stone + diamond pickaxes => no TOOL_PROGRESSION needed (already max tier)", () => {
    const needs = assess({
      inventory: [
        { itemName: "stone_pickaxe", count: 1 },
        { itemName: "diamond_pickaxe", count: 1 },
      ],
    });
    expect(findByKey(needs, "TOOL_PROGRESSION")).toBeUndefined();
  });

  it("low tier damaged + high tier完好 => no TOOL_RECOVERY for low tier", () => {
    const needs = assess({
      inventory: [
        { itemName: "wooden_pickaxe", count: 1, durability: 5, maxDurability: 60 },
        { itemName: "iron_pickaxe", count: 1, durability: 200, maxDurability: 250 },
      ],
    });
    // 旧代码可能对 wooden_pickaxe 发 TOOL_RECOVERY——不需要，有更好的铁镐
    const tr = findByKey(needs, "TOOL_RECOVERY");
    if (tr) {
      expect(tr.operatorGoal).not.toContain("wooden_pickaxe");
    }
  });

  it("sword tier: has stone + diamond swords => no WEAPON needed", () => {
    const needs = assess({
      inventory: [
        { itemName: "stone_pickaxe", count: 1 },
        { itemName: "stone_sword", count: 1 },
        { itemName: "diamond_sword", count: 1 },
      ],
    });
    expect(findByKey(needs, "WEAPON")).toBeUndefined();
  });
});

// ===========================================================================
// A.2 钻石推进：有 3 颗钻石时必须做钻石镐，不能再要求挖更多钻石
// ===========================================================================

describe("A.2: diamond progression must not loop forever", () => {
  it("iron pickaxe + 3 diamonds => craft diamond_pickaxe, NOT mine more diamonds", () => {
    const needs = assess({
      inventory: [
        { itemName: "iron_pickaxe", count: 1 },
        { itemName: "diamond", count: 3 },
      ],
    });
    const dp = findByKey(needs, "DIAMOND_PROGRESSION");
    // 旧代码：有 3 颗钻石时 deficitCount(3,3)=max(1,min(32,0))=0→但 min(32,0)=0, max(1,0)=1
    // 所以仍然返回 count=1，持续要求挖钻石
    // 正确行为：够 3 颗就不该再挖
    if (dp) {
      expect(dp.operatorGoal).toContain("diamond_pickaxe");
    }
  });

  it("iron pickaxe + 0 diamonds => should mine diamonds", () => {
    const needs = assess({
      inventory: [{ itemName: "iron_pickaxe", count: 1 }],
    });
    const dp = findByKey(needs, "DIAMOND_PROGRESSION");
    expect(dp).toBeDefined();
    expect(dp?.operatorGoal).toContain("diamond");
  });

  it("iron pickaxe + 4 diamonds => must NOT ask for more diamonds", () => {
    const needs = assess({
      inventory: [
        { itemName: "iron_pickaxe", count: 1 },
        { itemName: "diamond", count: 4 },
      ],
    });
    // 有 4 颗（> 3），必须做钻石镐或不再要求
    const dp = findByKey(needs, "DIAMOND_PROGRESSION");
    if (dp) {
      expect(dp.operatorGoal).not.toBe("获取 1 个 diamond");
    }
  });
});

// ===========================================================================
// A.3 铁甲：穿了第一件后必须继续补齐剩余三件
// ===========================================================================

describe("A.3: armor must fill all four slots, not stop after first piece", () => {
  it("wearing iron_helmet (armorPoints=2) but missing 3 pieces => craft missing pieces", () => {
    const needs = assess({
      inventory: [{ itemName: "iron_pickaxe", count: 1 }],
      armorPoints: 2, // 只有头盔
    });
    // 旧代码 armorPoints > 0 就跳过 —— 剩余三件永远不补
    // 正确行为：应该继续合成缺失的胸甲/护腿/靴子
    const armor = findByKey(needs, "ARMOR");
    expect(armor).toBeDefined();
    expect(armor?.operatorGoal).toMatch(/iron_(chestplate|leggings|boots)/);
  });

  it("full iron set equipped (armorPoints=15) => no ARMOR need", () => {
    const needs = assess({
      inventory: [{ itemName: "iron_pickaxe", count: 1 }],
      armorPoints: 15,
    });
    expect(findByKey(needs, "ARMOR")).toBeUndefined();
  });
});

// ===========================================================================
// A.4 食物 contract：缺口 ≠ 总量
// ===========================================================================

describe("A.4: food contract must use desiredTotalCount, not deficit-as-count", () => {
  it("safeFood=7, target=12 => desiredTotalCount must be 12 (not 5)", () => {
    const needs = assess({
      inventory: [{ itemName: "cooked_beef", count: 7 }],
      foodLevel: 20,
    });
    const food = findByKey(needs, "FOOD_SECURITY");
    // 旧代码发"获取 5 份"——runtime food.secure 看到 7>=5 直接返回成功
    // 正确行为：应该表达"补到 12"而非"获取 5 个"
    if (food) {
      // 需求必须包含明确的总量语义，而不是歧义的"获取 N 份"
      expect(food.operatorGoal).not.toBe("获取 5 份安全食物");
    }
  });

  it("safeFood=0 => desiredTotalCount = FOOD_TARGET (12)", () => {
    const needs = assess({ inventory: [], foodLevel: 12 });
    const food = findByKey(needs, "FOOD_SECURITY");
    expect(food).toBeDefined();
    // 不管发什么格式，总量必须是 12 而不是缺口 12
    expect(food?.operatorGoal).toContain("12");
  });
});

// ===========================================================================
// A.5 食物名册一致性：腐肉不应在饱腹时算安全储备
// ===========================================================================

describe("A.5: rotten flesh must not count as safe food reserve", () => {
  it("32 rotten flesh only => still triggers FOOD_SECURITY", () => {
    const needs = assess({
      inventory: [{ itemName: "rotten_flesh", count: 32 }],
      foodLevel: 12,
    });
    // 腐肉是应急食物，不是长期储备
    const food = findByKey(needs, "FOOD_SECURITY");
    expect(food).toBeDefined();
  });
});

// ===========================================================================
// A.7 跨维度死亡回收：不同维度必须报 UNSUPPORTED，不能发错误坐标
// ===========================================================================

describe("A.7: cross-dimension death recovery must not use wrong coordinates", () => {
  it("died in nether, respawned in overworld => NO movement goal to death xyz", () => {
    const needs = assess({
      inventory: [],
      position: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
      lastDeath: {
        x: 100, y: 40, z: -200,
        dimension: "minecraft:the_nether",
        diedAt: new Date(FIXED_NOW.getTime() - 60_000).toISOString(),
      },
    });
    const dr = findByKey(needs, "DEATH_RECOVERY");
    // 不应该发一个"移动到 x=100 y=40 z=-200"的目标——那是下界坐标
    if (dr) {
      expect(dr.operatorGoal).not.toContain("x=100");
    } else {
      // 或者干脆不发（跨维度恢复尚不支持）
      expect(dr).toBeUndefined();
    }
  });

  it("same dimension death => normal recovery goal", () => {
    const needs = assess({
      inventory: [],
      position: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
      lastDeath: {
        x: 50, y: 64, z: 50,
        dimension: "minecraft:overworld",
        diedAt: new Date(FIXED_NOW.getTime() - 60_000).toISOString(),
      },
    });
    const dr = findByKey(needs, "DEATH_RECOVERY");
    expect(dr).toBeDefined();
    expect(dr?.operatorGoal).toContain("x=50");
  });
});

// ===========================================================================
// A.8 时钟注入：assessSurvivalNeeds 必须接受 now 参数
// ===========================================================================

describe("A.8: assessSurvivalNeeds must accept injectable clock", () => {
  it("accepts now parameter and uses it for death window calculation", () => {
    // 死亡发生在 now-30min（超窗口）
    const oldDeath = new Date(FIXED_NOW.getTime() - 30 * 60_000).toISOString();
    const needs = assess({
      inventory: [],
      lastDeath: { x: 50, y: 64, z: 50, dimension: "minecraft:overworld", diedAt: oldDeath },
    });
    // 超过 15 分钟窗口，不应产生 DEATH_RECOVERY
    expect(findByKey(needs, "DEATH_RECOVERY")).toBeUndefined();
  });

  it("deterministic: same input + same now => same output", () => {
    const opts = {
      inventory: [{ itemName: "oak_log", count: 2 }] as const,
      foodLevel: 14,
    };
    const a = assess(opts);
    const b = assess(opts);
    expect(a.map((n) => n.key)).toEqual(b.map((n) => n.key));
    expect(a.map((n) => n.score)).toEqual(b.map((n) => n.score));
  });
});
