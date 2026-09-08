import { describe, expect, it } from "vitest";

import {
  BotWorkingMemory,
  InMemoryWorkingMemoryStore,
  WorkingMemoryScopeError,
} from "../src/index.js";

function clock() {
  let current = new Date("2026-08-28T06:00:00.000Z");
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    value: () => new Date(current).toISOString(),
  };
}

describe("bot working memory", () => {
  it("updates event-driven inventory, nearby blocks and navigation without a planner", () => {
    const time = clock();
    const store = new InMemoryWorkingMemoryStore();
    const memory = new BotWorkingMemory({
      botId: "_Miner",
      serverProfileId: "isolated-local",
      dimension: "minecraft:overworld",
      now: time.now,
      store,
    });
    const initialVersion = memory.version;
    memory.updateInventory("minecraft:crafting_table", 1);
    memory.observeBlock({
      kind: "crafting_table",
      position: { x: 2, y: 64, z: 2 },
      dimension: "minecraft:overworld",
      lastSeen: time.value(),
      reachable: true,
      source: "block_update",
      ownership: null,
      confidence: 1,
      staleAfterMs: 30_000,
    });
    memory.updateNavigation({ lastPosition: { x: 0, y: 64, z: 0 } });
    expect(memory.version).toBeGreaterThan(initialVersion);
    expect(memory.hasItem("minecraft:crafting_table")).toBe(true);
    expect(memory.isCraftingTableAvailable(16)).toBe(true);
    expect(memory.nearestBlock("crafting_table")?.position).toEqual({ x: 2, y: 64, z: 2 });

    const restored = new BotWorkingMemory({
      botId: "_Miner",
      serverProfileId: "isolated-local",
      dimension: "minecraft:overworld",
      now: time.now,
      store,
    });
    expect(restored.snapshot()).toEqual(memory.snapshot());
  });

  it("enforces resource reservations and stale/duplicate block handling", () => {
    const time = clock();
    const memory = new BotWorkingMemory({
      botId: "bot-02",
      serverProfileId: "isolated-local",
      dimension: "minecraft:overworld",
      now: time.now,
    });
    memory.updateInventory("minecraft:iron_ingot", 3);
    memory.reserveResource("minecraft:iron_ingot", 2);
    expect(() => memory.reserveResource("minecraft:iron_ingot", 2)).toThrow("Insufficient");
    memory.releaseResource("minecraft:iron_ingot", 1);
    expect(memory.snapshot().inventory.reservedResources).toEqual({ "minecraft:iron_ingot": 1 });
    const block = {
      kind: "crafting_table" as const,
      position: { x: 1, y: 64, z: 1 },
      dimension: "minecraft:overworld",
      lastSeen: time.value(),
      reachable: true,
      source: "scan",
      ownership: null,
      confidence: 1,
      staleAfterMs: 1_000,
    };
    memory.observeBlock(block);
    memory.observeBlock({ ...block, confidence: 0.5 });
    expect(memory.nearbyBlocks("crafting_table")).toHaveLength(1);
    time.advance(2_000);
    expect(memory.isCraftingTableAvailable()).toBe(false);
  });

  it("clears observations when the bot changes world scope", () => {
    const time = clock();
    const store = new InMemoryWorkingMemoryStore();
    const memory = new BotWorkingMemory({
      botId: "bot-03",
      serverProfileId: "isolated-local",
      dimension: "minecraft:overworld",
      now: time.now,
      store,
    });
    memory.observeEntity({
      entityId: "zombie-1",
      kind: "zombie",
      position: { x: 1, y: 64, z: 1 },
      dimension: "minecraft:overworld",
      lastSeen: time.value(),
      hostile: true,
      health: 20,
    });
    memory.switchWorld("isolated-nether", "minecraft:the_nether");
    expect(memory.snapshot().entities).toEqual([]);
    expect(memory.snapshot().serverProfileId).toBe("isolated-nether");
    expect(() => new BotWorkingMemory({
      botId: "bot-03",
      serverProfileId: "isolated-local",
      dimension: "minecraft:overworld",
      now: time.now,
      store,
    })).toThrow(WorkingMemoryScopeError);
  });
});
