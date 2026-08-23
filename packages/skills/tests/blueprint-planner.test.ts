import { describe, expect, it } from "vitest";

import {
  buildBlueprintInputSchema,
  buildBlueprintSkill,
  isIntermediateBlueprintSafe,
  orderBlueprintCells,
  planBlueprint,
} from "../src/index.js";

const blueprint = buildBlueprintInputSchema.parse({
  blueprint: {
    anchor: { x: 100, y: 64, z: 100 },
    dimension: "minecraft:overworld",
    serverProfileId: "isolated-profile",
    cells: [
      { offset: { x: 0, y: 2, z: 0 }, itemName: "glass", blockClass: "decoration", order: 0 },
      { offset: { x: 0, y: 0, z: 0 }, itemName: "obsidian", blockClass: "foundation", order: 2 },
      { offset: { x: 0, y: 1, z: 0 }, itemName: "stone", blockClass: "shell", order: 1 },
      { offset: { x: 1, y: 0, z: 0 }, itemName: "obsidian", blockClass: "load-bearing", order: 0 },
    ],
  },
  availableMaterials: [
    { itemName: "obsidian", count: 2 },
    { itemName: "stone", count: 1 },
    { itemName: "glass", count: 1 },
  ],
});

describe("blueprint planner", () => {
  it("orders structural cells before shell and decoration with stable ties", () => {
    const ordered = orderBlueprintCells(blueprint.blueprint);
    expect(ordered.map((cell) => cell.blockClass)).toEqual([
      "foundation", "load-bearing", "shell", "decoration",
    ]);
    expect(isIntermediateBlueprintSafe(ordered)).toBe(true);
    expect(isIntermediateBlueprintSafe([ordered[2]!, ordered[0]!])).toBe(false);
  });

  it("exposes a bounded plan and resumes from a batch index", async () => {
    const plan = planBlueprint(blueprint);
    expect(plan.totalCells).toBe(4);
    expect(plan.estimatedDurationMs).toBeGreaterThan(0);
    const calls: unknown[] = [];
    const context = {
      invocationId: "invocation",
      traceId: "trace",
      taskId: "task",
      botId: "bot",
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
      compatibility: { minecraftVersion: "1.21.8", protocolVersion: 768, variantId: "portable", verification: "unverified" as const },
      callCapability: async (_capability: string, _operation: string, input: any) => {
        calls.push(input);
        return { placed: true, placedBlockName: input.itemName, position: input.target };
      },
    };
    const output = await buildBlueprintSkill.execute(context, { ...blueprint, startIndex: 0, maxPlacements: 2 }, {
      online: true,
      normalActionsAllowed: true,
      retreatInProgress: false,
      serverProfileId: "isolated-profile",
      position: { x: 100, y: 64, z: 100, dimension: "minecraft:overworld", serverProfileId: "isolated-profile" },
    });
    expect(output.completed).toBe(false);
    expect(output.nextIndex).toBe(2);
    expect(calls).toHaveLength(2);
    expect((calls[0] as any).target).toEqual({ x: 100, y: 64, z: 100 });
  });
});

