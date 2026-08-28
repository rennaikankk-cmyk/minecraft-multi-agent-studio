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
      operatorGoal: "获取 12 份安全食物",
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
      operatorGoal: "获取 5 份安全食物",
      score: 34,
    });
  });

  it("treats rotten flesh as not safe food", () => {
    const needs = assess({
      inventory: [{ itemName: "rotten_flesh", count: 32 }],
      foodLevel: 12,
    });
    expect(needs.find((need) => need.key === "FOOD_SECURITY")).toMatchObject({
      score: 92,
    });
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
        { itemName: "diamond", count: 3 },
      ],
    });
    expect(diamondAge.find((n) => n.key === "DIAMOND_ARMOR")).toMatchObject({
      operatorGoal: "获取 diamond_helmet",
    });
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
    expect(needs.map(({ key }) => key)).toEqual(["EXPLORATION"]);
  });

  it("orders ties by the fixed priority order, deterministically", () => {
    const first = assess({ inventory: [], foodLevel: 20 });
    const second = assess({ inventory: [], foodLevel: 20 });
    expect(first.map(({ key }) => key)).toEqual(second.map(({ key }) => key));
  });
});

function assess(options: {
  inventory: ReadonlyArray<{ itemName: string; count: number }>;
  foodLevel?: number;
  armorPoints?: number;
  shelterBuilt?: boolean;
}): ReturnType<typeof assessSurvivalNeeds> {
  return assessSurvivalNeeds({
    shelterBuilt: options.shelterBuilt ?? false,
    record: record(options.inventory, options.foodLevel ?? 20, options.armorPoints ?? 0),
  });
}

function record(
  inventory: ReadonlyArray<{ itemName: string; count: number }>,
  foodLevel: number,
  armorPoints: number,
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
    skillCatalog: null,
    offlineReason: null,
  } as unknown as BotRegistryRecord;
}

function satisfied(): ReadonlyArray<{ itemName: string; count: number }> {
  return [
    { itemName: "cooked_beef", count: 12 },
    { itemName: "oak_log", count: 16 },
    { itemName: "diamond_pickaxe", count: 1 },
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
