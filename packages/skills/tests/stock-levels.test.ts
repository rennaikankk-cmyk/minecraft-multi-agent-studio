import { describe, expect, it } from "vitest";

import {
  evaluateStockLevel,
  evaluateStockLevels,
  packShulkerSkill,
  stockLevelSchema,
  storeSortSkill,
  secureFoodOutputSchema,
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

  it.each([0, 1])("keeps a partially filled route pending and resumes only its residual (%s moved)", async (amount) => {
    const scope = { serverProfileId: "fixture", dimension: "minecraft:overworld" };
    const context = { signal: new AbortController().signal, callCapability: async (_c: string, _o: string, input: any) =>
      ({ direction: "deposit", itemName: input.itemName, requestedCount: input.count, movedCount: amount }) } as any;
    const state = { ...scope, online: true, normalActionsAllowed: true, position: { ...scope, x: 0, y: 64, z: 0 } };
    const route = { ...scope, itemName: "stone", count: 2, container: { x: 1, y: 64, z: 0 } };
    const input = { routes: [route, { ...route, itemName: "dirt" }], startIndex: 0, maxTransfers: 2 };
    const result = await storeSortSkill.execute(context, input, state);
    expect(result).toMatchObject({ nextIndex: 0, remainingCount: 2 - amount, completed: false });
    expect(result.moved).toHaveLength(1);
    const calls: number[] = [];
    context.callCapability = async (_c: string, _o: string, input: any) => {
      calls.push(input.count);
      return { direction: "deposit", itemName: input.itemName, requestedCount: input.count, movedCount: input.count };
    };
    expect(await storeSortSkill.execute(context, { ...input, remainingCount: result.remainingCount }, state)).toMatchObject({ nextIndex: 2, completed: true, remainingCount: 0 });
    expect(calls).toEqual([2 - amount, 2]);
  });

  it("does not report shulker completion after a partial transfer", async () => {
    const scope = { serverProfileId: "fixture", dimension: "minecraft:overworld" };
    const context = { signal: new AbortController().signal, callCapability: async () =>
      ({ direction: "deposit", itemName: "stone", requestedCount: 4, movedCount: 1 }) } as any;
    const state = { ...scope, online: true, normalActionsAllowed: true, position: { ...scope, x: 0, y: 64, z: 0 } };
    expect(await packShulkerSkill.execute(context, { ...scope, shulker: { x: 1, y: 64, z: 0 },
      items: [{ itemName: "stone", count: 4 }], startIndex: 0, maxTransfers: 1 }, state))
      .toMatchObject({ nextIndex: 0, remainingCount: 3, completed: false });
  });

  it("accepts a real pickup larger than the requested food target and rejects contradictory receipts", () => {
    const receipt = { safeFoodCount: 64, secured: 64, targetCount: 16, targetReached: true, reasonCode: "TARGET_REACHED" };
    expect(secureFoodOutputSchema.safeParse(receipt).success).toBe(true);
    expect(secureFoodOutputSchema.safeParse({ ...receipt, targetReached: false }).success).toBe(false);
  });
});
