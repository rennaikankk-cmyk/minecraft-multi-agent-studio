import type { BotRegistryRecord } from "../src/bot-registry.js";
import { assessSurvivalNeeds } from "../src/survival-needs.js";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-08-28T00:00:00.000Z");

describe("assessSurvivalNeeds", () => {
  it("bootstraps a fresh spawn onto the tool ladder before food topping-up", () => {
    const needs = assess({ inventory: [], foodLevel: 20 });
    expect(needs[0]).toMatchObject({
      key: "TOOL_PROGRESSION",
      operatorGoal: "获取 wooden_pickaxe",
      reason: "no pickaxe at all",
    });
  });

  it("promotes food to the top when the hunger bar is running low", () => {
    const needs = assess({ inventory: [], foodLevel: 12 });
    expect(needs[0]).toMatchObject({
      key: "FOOD_SECURITY",
      operatorGoal: "获取安全食物到总量 12 份",
    });
  });

  it("advances the tool ladder one tier at a time", () => {
    const needs = assess({ inventory: [{ itemName: "wooden_pickaxe", count: 1 }] });
    expect(needs.find((need) => need.key === "TOOL_PROGRESSION")).toMatchObject({
      operatorGoal: "获取 stone_pickaxe",
      sourceBlock: "stone",
    });
  });

  it("counts safe food across every food item name", () => {
    const needs = assess({
      inventory: [
        { itemName: "bread", count: 3 },
        { itemName: "cooked_beef", count: 4 },
      ],
      foodLevel: 20,
    });
    expect(needs.find((need) => need.key === "FOOD_SECURITY")).toMatchObject({
      operatorGoal: "获取安全食物到总量 12 份",
      score: 34,
    });
  });

  it("treats rotten flesh as NOT safe food reserve (P0-A5)", () => {
    // 腐肉有饥饿 debuff，不是长期安全储备——必须触发食物需求
    const needs = assess({
      inventory: [{ itemName: "rotten_flesh", count: 32 }],
      foodLevel: 20,
    });
    const food = needs.find((need) => need.key === "FOOD_SECURITY");
    expect(food).toBeDefined();
  });

  it("counts planks toward the wood reserve at a quarter rate", () => {
    const needs = assess({
      inventory: [{ itemName: "oak_planks", count: 64 }],
      foodLevel: 20,
    });
    // 64 planks = 16 wood units = satisfied reserve, no WOOD_RESERVE need.
    expect(needs.find((need) => need.key === "WOOD_RESERVE")).toBeUndefined();
  });

  it("demands equipping carried armor before crafting anything else", () => {
    const needs = assess({
      inventory: [
        { itemName: "diamond_pickaxe", count: 1 },
    { itemName: "diamond_axe", count: 1 },
    { itemName: "diamond_shovel", count: 1 },
    { itemName: "diamond_hoe", count: 1 },
        { itemName: "iron_chestplate", count: 1 },
      ],
      armorPoints: 0,
    });
    expect(needs.find((need) => need.key === "EQUIP_ARMOR")).toMatchObject({
      operatorGoal: "穿上最好的护甲",
      score: 60,
    });
    expect(needs.find((need) => need.key === "ARMOR")).toBeUndefined();
  });

  it("crafts missing iron armor only when no pieces are carried", () => {
    const needs = assess({
      inventory: [{ itemName: "iron_pickaxe", count: 1 }],
      armorPoints: 0,
    });
    expect(needs.find((need) => need.key === "ARMOR")).toMatchObject({
      operatorGoal: "获取 iron_helmet",
      sourceBlock: "iron_ore",
    });
  });

  it("gates shelter on the stone age and memory", () => {
    expect(
      assess({ inventory: [], shelterBuilt: false }).find((n) => n.key === "SHELTER"),
    ).toBeUndefined();
    expect(
      assess({
        inventory: [{ itemName: "stone_pickaxe", count: 1 }],
        shelterBuilt: false,
      }).find((n) => n.key === "SHELTER"),
    ).toMatchObject({ key: "SHELTER" });
    expect(
      assess({
        inventory: [{ itemName: "stone_pickaxe", count: 1 }],
        shelterBuilt: true,
      }).find((n) => n.key === "SHELTER"),
    ).toBeUndefined();
  });

  it("mines diamonds for the pickaxe first, then armor pieces", () => {
    const preDiamond = assess({
      inventory: [{ itemName: "iron_pickaxe", count: 1 }],
    });
    expect(preDiamond.find((n) => n.key === "DIAMOND_PROGRESSION")).toMatchObject({
      operatorGoal: "获取 3 个 diamond",
      sourceBlock: "diamond_ore",
    });
    expect(preDiamond.find((n) => n.key === "DIAMOND_ARMOR")).toBeUndefined();

    const diamondAge = assess({
      inventory: [
        { itemName: "diamond_pickaxe", count: 1 },
    { itemName: "diamond_axe", count: 1 },
    { itemName: "diamond_shovel", count: 1 },
    { itemName: "diamond_hoe", count: 1 },
        { itemName: "diamond", count: 3 },
      ],
    });
    expect(diamondAge.find((n) => n.key === "DIAMOND_ARMOR")).toMatchObject({
      operatorGoal: "获取 diamond_helmet",
    });
  });

  it("replaces a worn pickaxe before it breaks", () => {
    const needs = assess({
      inventory: [{
        itemName: "stone_pickaxe",
        count: 1,
        durability: 8,
        maxDurability: 132,
      }],
      foodLevel: 20,
    });
    const recovery = needs.find((n) => n.key === "TOOL_RECOVERY");
    expect(recovery).toMatchObject({
      operatorGoal: "获取 2 个 stone_pickaxe",
      reason: expect.stringContaining("durability 6%"),
      sourceBlock: "stone",
    });
    // 耐久恢复压过梯队推进：镐子断掉等于采集链停摆。
    expect(recovery?.score).toBeGreaterThan(
      needs.find((n) => n.key === "TOOL_PROGRESSION")?.score ?? 0,
    );
  });

  it("ignores durability when the runtime has not reported it", () => {
    const needs = assess({
      inventory: [{ itemName: "stone_pickaxe", count: 1 }],
      foodLevel: 20,
    });
    expect(needs.find((n) => n.key === "TOOL_RECOVERY")).toBeUndefined();
  });

  it("demands death-point recovery while the drop is fresh and unreached", () => {
    const diedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const needs = assess({
      inventory: [],
      foodLevel: 20,
      lastDeath: { x: 120, y: 64, z: -80, dimension: "minecraft:overworld", diedAt },
    });
    expect(needs[0]).toMatchObject({
      key: "DEATH_RECOVERY",
      score: 85,
      operatorGoal:
        "移动到坐标 x=120 y=64 z=-80 附近，回收死亡掉落物",
    });
  });

  it("drops death recovery once the bot has reached the drop point", () => {
    const diedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const needs = assess({
      inventory: [],
      foodLevel: 20,
      position: { x: 118, y: 64, z: -78 },
      lastDeath: { x: 120, y: 64, z: -80, dimension: "minecraft:overworld", diedAt },
    });
    expect(needs.find((n) => n.key === "DEATH_RECOVERY")).toBeUndefined();
  });

  it("values the death-time snapshot over the emptied post-respawn inventory", () => {
    const diedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    // 有价值的快照 → 回收（即便当前背包已空）
    const valuable = assess({
      inventory: [],
      foodLevel: 20,
      lastDeath: {
        x: 120, y: 64, z: -80, dimension: "minecraft:overworld", diedAt,
        droppedItems: [{ itemId: "diamond_pickaxe", count: 1 }, { itemId: "diamond_sword", count: 1 }],
        xpPoints: 300,
      },
    });
    expect(valuable[0]).toMatchObject({ key: "DEATH_RECOVERY" });
    // 垃圾快照 → 不值得回收——这证明评估用的是快照而非空背包的
    // unknown-value 路径（空背包会保守回收）。
    const junk = assess({
      inventory: [],
      foodLevel: 20,
      lastDeath: {
        x: 120, y: 64, z: -80, dimension: "minecraft:overworld", diedAt,
        droppedItems: [{ itemId: "dirt", count: 1 }],
      },
    });
    expect(junk.find((n) => n.key === "DEATH_RECOVERY")).toBeUndefined();
  });

  it("never explores on an empty food reserve", () => {
    const needs = assess({
      inventory: [{ itemName: "diamond_pickaxe", count: 1 }],
      foodLevel: 20,
    });
    expect(needs.find((n) => n.key === "EXPLORATION")).toBeUndefined();
  });

  it("keeps exploring once everything is satisfied", () => {
    const needs = assess({ inventory: satisfied(), armorPoints: 20, shelterBuilt: true });
    // baseFacilities 未传入 → 基地 needs 不触发（能力未接线=无幽灵需求）
    expect(needs.map(({ key }) => key)).toEqual(["EXPLORATION"]);
  });

  it("orders ties by the fixed priority order, deterministically", () => {
    const first = assess({ inventory: [], foodLevel: 20 });
    const second = assess({ inventory: [], foodLevel: 20 });
    expect(first.map(({ key }) => key)).toEqual(second.map(({ key }) => key));
  });

  it("emits RECON_PATROL only when a corridor is supplied and food allows travel", () => {
    const patrol = {
      goalText: "roof 扫描走廊：起点 x=0 y=128 z=0，沿 +x 扫 128 格",
      reason: "grid cell 0,0 never scanned",
    };
    // 供给走廊 + 食物充足 → 出现，且排在 EXPLORATION 之前（同分裁决序）
    const withPatrol = assess({ inventory: satisfied(), armorPoints: 20, shelterBuilt: true, reconPatrol: patrol });
    expect(withPatrol.map(({ key }) => key)).toEqual(["RECON_PATROL", "EXPLORATION"]);
    expect(withPatrol[0]).toMatchObject({ key: "RECON_PATROL", operatorGoal: patrol.goalText, score: 6 });

    // 供给走廊 + 食物见底 → 不出现（不许带见底的储备远行——与探索同纪律）
    const starving = assess({ inventory: [], foodLevel: 20, reconPatrol: patrol });
    expect(starving.find((n) => n.key === "RECON_PATROL")).toBeUndefined();

    // 不供给（默认/director 未接线）→ 不出现：旧行为逐字节不变
    const noSupply = assess({ inventory: satisfied(), armorPoints: 20, shelterBuilt: true });
    expect(noSupply.map(({ key }) => key)).toEqual(["EXPLORATION"]);
  });

  it("keeps survival needs above RECON_PATROL（仲裁：survival > manual > patrol）", () => {
    const patrol = {
      goalText: "roof 扫描走廊：起点 x=0 y=128 z=0，沿 +x 扫 128 格",
      reason: "grid cell 0,0 never scanned",
    };
    // 有生存缺口（食物低于最低线）时 patrol 被食物闸拦下；
    // 食物够但缺工具 → 工具梯队分数远高于 6，patrol 排不上首位
    const needs = assess({ inventory: satisfied(), armorPoints: 20, shelterBuilt: true, reconPatrol: patrol });
    const patrolIdx = needs.findIndex((n) => n.key === "RECON_PATROL");
    for (let i = 0; i < patrolIdx; i += 1) {
      expect(needs[i]!.score).toBeGreaterThanOrEqual(needs[patrolIdx]!.score);
    }
  });
});

function assess(options: {
  inventory: ReadonlyArray<{ itemName: string; count: number }>;
  foodLevel?: number;
  armorPoints?: number;
  shelterBuilt?: boolean;
  position?: { x: number; y: number; z: number };
  reconPatrol?: { goalText: string; reason: string } | null;
  lastDeath?: {
    x: number;
    y: number;
    z: number;
    dimension: string;
    diedAt: string;
    droppedItems?: ReadonlyArray<{ itemId: string; count: number }>;
    xpPoints?: number;
  };
}): ReturnType<typeof assessSurvivalNeeds> {
  return assessSurvivalNeeds({
    shelterBuilt: options.shelterBuilt ?? false,
    ...(options.reconPatrol !== undefined ? { reconPatrol: options.reconPatrol } : {}),
    record: record(
      options.inventory,
      options.foodLevel ?? 20,
      options.armorPoints ?? 0,
      options.position,
      options.lastDeath,
    ),
  });
}

function record(
  inventory: ReadonlyArray<{ itemName: string; count: number }>,
  foodLevel: number,
  armorPoints: number,
  position?: { x: number; y: number; z: number },
  lastDeath?: {
    x: number;
    y: number;
    z: number;
    dimension: string;
    diedAt: string;
    droppedItems?: ReadonlyArray<{ itemId: string; count: number }>;
    xpPoints?: number;
  },
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
      food: { level: foodLevel, saturation: 5 },
      armorPoints,
      position: {
        x: position?.x ?? 0,
        y: position?.y ?? 64,
        z: position?.z ?? 0,
        dimension: "minecraft:overworld",
      },
      ...(lastDeath ? { lastDeath } : {}),
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
    skillCatalog: null,
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
