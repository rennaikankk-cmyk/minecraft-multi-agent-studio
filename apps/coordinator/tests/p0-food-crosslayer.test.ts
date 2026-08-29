// P0 跨层回归——食物 contract 贯穿 survival-needs → deterministic-goals → planner → food.secure

import { describe, expect, it, vi } from "vitest";

// Layer 1: survival-needs (producer)
import { assessSurvivalNeeds } from "../src/survival-needs.js";
// Layer 2: deterministic-goals (parser)
import { parseDeterministicGoal, parseFoodGoal } from "../src/deterministic-goals.js";
// Layer 3: local-planner bindability (which items are reachable)
import { CoordinatorLocalPlanner } from "../src/local-planner.js";
import type { BotRegistryRecord } from "../src/bot-registry.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const BOT_ID = "studio-bot-01";

function makeRecord(inventory: ReadonlyArray<{ itemName: string; count: number }>): BotRegistryRecord {
  return {
    botId: BOT_ID,
    serverProfileId: "test",
    runtimeInstanceId: "rt-test",
    connectionState: "online",
    lastSequence: 1,
    lastObservedAt: NOW.toISOString(),
    lastMessageAt: NOW.toISOString(),
    lastHeartbeatAt: NOW.toISOString(),
    lastStatusAt: NOW.toISOString(),
    currentStatus: {
      serverProfileId: "test",
      runtimeInstanceId: "rt-test",
      sequence: 1,
      observedAt: NOW.toISOString(),
      connectionState: "online",
      health: { current: 20, maximum: 20 },
      food: { level: 14, saturation: 5 },
      armorPoints: 0,
      position: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
      latencyMs: 10,
      currentTask: null,
      safety: { mode: "monitoring", activeRisks: [], normalTasksPaused: false, lastDecisionId: null, lastAction: null },
      inventory,
    },
    minecraftVersion: null,
    skillCatalog: null,
    offlineReason: null,
  } as unknown as BotRegistryRecord;
}

describe("P0 food cross-layer contract", () => {
  it("Layer1→Layer2: survival-needs operatorGoal MUST be parseable by parseFoodGoal", () => {
    // Bot has 7 food, target is 12. The goal text must carry "12" not "5".
    const needs = assessSurvivalNeeds({
      shelterBuilt: true,
      record: makeRecord([{ itemName: "cooked_beef", count: 7 }]),
    });
    const food = needs.find((n) => n.key === "FOOD_SECURITY");
    expect(food).toBeDefined();
    const parsed = parseFoodGoal(food!.operatorGoal);
    expect(parsed).not.toBeNull();
    // This is the critical assertion: the parsed targetCount must be 12 (the TOTAL), not 5 (the deficit)
    expect(parsed!.targetCount).toBe(12);
  });

  it("Layer1→Layer2: safeFood=0 → parseFoodGoal targetCount=12", () => {
    const needs = assessSurvivalNeeds({
      shelterBuilt: true,
      record: makeRecord([]),
    });
    const food = needs.find((n) => n.key === "FOOD_SECURITY");
    const parsed = parseFoodGoal(food!.operatorGoal);
    expect(parsed).not.toBeNull();
    expect(parsed!.targetCount).toBe(12);
  });

  it("Layer1→Layer2: safeFood=11 → parseFoodGoal targetCount=12 (not 1)", () => {
    const needs = assessSurvivalNeeds({
      shelterBuilt: true,
      record: makeRecord([{ itemName: "bread", count: 11 }]),
    });
    const food = needs.find((n) => n.key === "FOOD_SECURITY");
    if (food) {
      const parsed = parseFoodGoal(food!.operatorGoal);
      expect(parsed).not.toBeNull();
      expect(parsed!.targetCount).toBe(12);
    }
  });

  it("FULL CHAIN: survival-needs → parseDeterministicGoal → targetCount=12", () => {
    const needs = assessSurvivalNeeds({
      shelterBuilt: true,
      record: makeRecord([{ itemName: "cooked_beef", count: 7 }]),
    });
    const food = needs.find((n) => n.key === "FOOD_SECURITY");
    expect(food).toBeDefined();
    // parseDeterministicGoal is what local-planner actually calls
    const BINDABLE = ["oak_log", "oak_planks", "crafting_table", "dirt", "diamond"];
    const parsed = parseDeterministicGoal(food!.operatorGoal, BINDABLE);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("secure-food");
    if (parsed!.kind === "secure-food") {
      expect(parsed!.targetCount).toBe(12);
    }
  });
});
