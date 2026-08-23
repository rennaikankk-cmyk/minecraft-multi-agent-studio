import { describe, expect, it } from "vitest";

import {
  evaluateStockLevel,
  evaluateStockLevels,
  packShulkerSkill,
  stockLevelSchema,
  storeSortSkill,
} from "../src/index.js";

describe("stock levels and storage skills", () => {
  it("uses low/target/ceiling deterministically and excludes food", () => {
    const level = stockLevelSchema.parse({ itemName: "obsidian", low: 8, target: 16, ceiling: 32 });
    expect(evaluateStockLevel(level, 4)).toMatchObject({ state: "LOW", deficitToTarget: 12, produce: true });
    expect(evaluateStockLevel(level, 32)).toMatchObject({ state: "CEILING", stopProduction: true });
    const decisions = evaluateStockLevels(
      [level, { itemName: "bread", low: 1, target: 4, ceiling: 8 }],
      [{ itemName: "obsidian", count: 16 }, { itemName: "bread", count: 0 }],
    );
    expect(decisions.map((entry) => entry.itemName)).toEqual(["obsidian"]);
  });

  it("routes sorting and shulker packing through container.transfer-safe", async () => {
    const operations: string[] = [];
    const context = {
      invocationId: "invocation",
      traceId: "trace",
      taskId: "task",
      botId: "bot",
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
      compatibility: { minecraftVersion: "1.21.8", protocolVersion: 768, variantId: "portable", verification: "unverified" as const },
      callCapability: async (_capability: string, operation: string, input: any) => {
        operations.push(operation);
        return { direction: input.direction, itemName: input.itemName, requestedCount: input.count, movedCount: input.count };
      },
    };
    const state = { online: true, normalActionsAllowed: true, serverProfileId: "isolated-profile", position: { x: 3, y: 64, z: 0, dimension: "minecraft:overworld", serverProfileId: "isolated-profile" } };
    const sortOutput = await storeSortSkill.execute(context, { routes: [{ itemName: "obsidian", count: 2, container: { x: 3, y: 64, z: 0 }, dimension: "minecraft:overworld", serverProfileId: "isolated-profile" }], startIndex: 0, maxTransfers: 1 }, state);
    expect(sortOutput.moved[0]?.movedCount).toBe(2);
    const packOutput = await packShulkerSkill.execute(context, { shulker: { x: 3, y: 64, z: 0 }, items: [{ itemName: "obsidian", count: 2 }], dimension: "minecraft:overworld", serverProfileId: "isolated-profile", startIndex: 0, maxTransfers: 1 }, state);
    expect(packOutput.completed).toBe(true);
    expect(operations).toEqual(["container.transfer-safe", "container.transfer-safe"]);
  });
});

