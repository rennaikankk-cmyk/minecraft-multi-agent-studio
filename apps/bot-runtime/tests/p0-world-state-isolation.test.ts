// P0-B10 回归测试——WorldStateStore 必须按 serverProfileId + dimension 双键隔离

import { describe, expect, it } from "vitest";

import { WorldStateStore, type WorldStateObservation } from "../src/world-state.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");

function makeObservation(overrides: Partial<WorldStateObservation> & {
  serverProfileId: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
  blockName: string;
}): WorldStateObservation {
  const { serverProfileId, dimension, x, y, z, blockName, ...rest } = overrides;
  return {
    observedAt: NOW,
    nearbyBlocks: [{
      name: blockName,
      position: { x, y, z, dimension, serverProfileId },
      lastSeen: NOW.toISOString(),
      reachable: true,
      source: "observation",
      confidence: 1,
    }],
    ...rest,
  };
}

describe("P0-B10: WorldStateStore must filter by serverProfileId + dimension", () => {
  it("findNearbyBlock must NOT return blocks from a different serverProfileId", () => {
    const store = new WorldStateStore();
    // Bot is on server-B, but server-A blocks were previously observed
    store.observe(makeObservation({
      serverProfileId: "server-A",
      dimension: "minecraft:overworld",
      x: 10, y: 64, z: 10,
      blockName: "oak_log",
    }));
    // Switch to server-B (position changes)
    store.observe({
      observedAt: NOW,
      position: { x: 10, y: 64, z: 10, dimension: "minecraft:overworld", serverProfileId: "server-B" },
    });

    const found = store.findNearbyBlock("oak_log");
    // The only oak_log was observed on server-A; must NOT be visible from server-B
    expect(found).toBeNull();
  });

  it("findNearbyBlock must NOT return blocks from a different dimension", () => {
    const store = new WorldStateStore();
    store.observe(makeObservation({
      serverProfileId: "test",
      dimension: "minecraft:the_nether",
      x: 10, y: 40, z: 10,
      blockName: "oak_log",
    }));
    store.observe({
      observedAt: NOW,
      position: { x: 10, y: 64, z: 10, dimension: "minecraft:overworld", serverProfileId: "test" },
    });

    const found = store.findNearbyBlock("oak_log");
    expect(found).toBeNull();
  });

  it("same serverProfileId + dimension => normal find works", () => {
    const store = new WorldStateStore();
    store.observe(makeObservation({
      serverProfileId: "test",
      dimension: "minecraft:overworld",
      x: 10, y: 64, z: 10,
      blockName: "oak_log",
    }));
    store.observe({
      observedAt: NOW,
      position: { x: 10, y: 64, z: 10, dimension: "minecraft:overworld", serverProfileId: "test" },
    });

    const found = store.findNearbyBlock("oak_log");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("oak_log");
  });
});
