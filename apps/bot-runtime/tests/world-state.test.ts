import { describe, expect, it } from "vitest";

import { WorldStateStore } from "../src/world-state.js";

const position = {
  x: 0,
  y: 64,
  z: 0,
  dimension: "minecraft:overworld",
  serverProfileId: "isolated-local",
} as const;

describe("WorldStateStore", () => {
  it("increments versions and reuses the nearest observed workstation", () => {
    const store = new WorldStateStore();
    store.observe({
      observedAt: new Date("2026-08-28T00:00:00.000Z"),
      position,
      inventory: [
        { name: "oak_planks", count: 4, durability: null, maxDurability: null },
        { name: "oak_planks", count: 2, durability: null, maxDurability: null },
      ],
      nearbyBlocks: [
        {
          name: "crafting_table",
          position: { ...position, x: 3 },
          lastSeen: "2026-08-28T00:00:00.000Z",
          reachable: true,
          source: "observation",
          confidence: 1,
        },
      ],
    });
    expect(store.snapshot().version).toBe(1);
    expect(store.inventoryCount("oak_planks")).toBe(6);
    expect(store.findNearbyBlock("crafting_table", { reachableOnly: true })?.position.x).toBe(3);
  });

  it("removes a disappeared block after a complete nearby scan", () => {
    const store = new WorldStateStore();
    store.observe({
      observedAt: new Date("2026-08-28T00:00:00.000Z"),
      position,
      replaceNearbyBlocks: true,
      nearbyBlocks: [{
        name: "crafting_table",
        position: { ...position, x: 3 },
        lastSeen: "2026-08-28T00:00:00.000Z",
        reachable: true,
        source: "observation",
        confidence: 1,
      }],
    });

    expect(store.observe({
      observedAt: new Date("2026-08-28T00:00:01.000Z"),
      position,
      replaceNearbyBlocks: true,
      nearbyBlocks: [],
    })).toBe(2);
    expect(store.findNearbyBlock("crafting_table")).toBeNull();
  });

  it("prevents over-reservation and releases resources", () => {
    const store = new WorldStateStore();
    store.observe({
      observedAt: new Date("2026-08-28T00:00:00.000Z"),
      position,
      inventory: [{ name: "stick", count: 2, durability: null, maxDurability: null }],
    });
    expect(store.reserve("stick", 2)).toBe(true);
    expect(store.reserve("stick", 1)).toBe(false);
    expect(store.snapshot().reservedResources).toEqual({ stick: 2 });
    store.release("stick", 1);
    expect(store.snapshot().reservedResources).toEqual({ stick: 1 });
    const version = store.snapshot().version;
    store.release("missing", 1);
    store.release("stick", Number.NaN);
    expect(store.snapshot().version).toBe(version);
    expect(store.snapshot().reservedResources).toEqual({ stick: 1 });
  });

  it("does not invalidate a plan for an identical observation timestamp refresh", () => {
    const store = new WorldStateStore();
    const first = {
      observedAt: new Date("2026-08-28T00:00:00.000Z"),
      position,
      inventory: [
        { name: "stick", count: 2, durability: null, maxDurability: null },
      ],
    } as const;
    expect(store.observe(first)).toBe(1);
    expect(store.observe({
      ...first,
      observedAt: new Date("2026-08-28T00:00:01.000Z"),
    })).toBe(1);
    expect(store.observe({
      ...first,
      observedAt: new Date("2026-08-28T00:00:02.000Z"),
      inventory: [
        { name: "stick", count: 3, durability: null, maxDurability: null },
      ],
    })).toBe(2);
  });

  it("does not invalidate planning for ordinary movement in the same world", () => {
    const store = new WorldStateStore();
    expect(store.observe({
      observedAt: new Date("2026-08-28T00:00:00.000Z"),
      position,
    })).toBe(1);
    expect(store.observe({
      observedAt: new Date("2026-08-28T00:00:01.000Z"),
      position: { ...position, x: 18.75, y: 65, z: -4.5 },
    })).toBe(1);
    expect(store.snapshot().position).toMatchObject({
      x: 18.75,
      y: 65,
      z: -4.5,
    });
    expect(store.observe({
      observedAt: new Date("2026-08-28T00:00:02.000Z"),
      position: { ...position, dimension: "minecraft:the_nether" },
    })).toBe(2);
  });

  it("versions path resets but not path-length telemetry jitter", () => {
    const store = new WorldStateStore();
    expect(store.observe({
      observedAt: new Date("2026-08-28T00:00:00.000Z"),
      position,
      navigation: {
        movementOwner: "skill:movement.goto:one",
        target: { ...position, x: 10 },
        pathLength: 8,
        pathResetCount: 0,
      },
    })).toBe(1);
    expect(store.observe({
      observedAt: new Date("2026-08-28T00:00:01.000Z"),
      navigation: { pathLength: 7 },
    })).toBe(1);
    expect(store.observe({
      observedAt: new Date("2026-08-28T00:00:02.000Z"),
      navigation: { pathResetCount: 1 },
    })).toBe(2);
  });
});
