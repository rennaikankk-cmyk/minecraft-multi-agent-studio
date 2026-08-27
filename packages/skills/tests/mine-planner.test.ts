import { describe, expect, it } from "vitest";

import {
  mineBranchCapabilityInputSchema,
  mineBranchSkill,
} from "../src/index.js";

const input = {
  targetItem: "minecraft:iron_ore",
  yLevel: 65,
  branchLength: 2,
  branchSpacing: 2,
  maxBlocks: 2,
  origin: { x: 0, y: 65, z: 4 },
  dimension: "minecraft:overworld",
  serverProfileId: "isolated-profile",
  backfill: true,
  exclusions: [
    "own-hideout",
    "blueprint-anchor",
    "load-bearing",
    "liquid-adjacent",
  ] as const,
};

describe("mine planner capability boundary", () => {
  it("strips planner-only fields before dispatching a strict capability input", async () => {
    const calls: unknown[] = [];
    const context = {
      invocationId: "invocation",
      traceId: "trace",
      taskId: "task",
      botId: "bot",
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 60_000,
      compatibility: {
        minecraftVersion: "1.21.8",
        protocolVersion: 772,
        variantId: "portable",
        verification: "unverified" as const,
      },
      callCapability: async (...args: unknown[]) => {
        calls.push(args);
        const capabilityInput = args[2] as { plan: unknown };
        return capabilityInput.plan;
      },
    };

    const output = await mineBranchSkill.execute(context, input, {
      online: true,
      normalActionsAllowed: true,
      serverProfileId: "isolated-profile",
      position: {
        x: 0,
        y: 65,
        z: 4,
        dimension: "minecraft:overworld",
        serverProfileId: "isolated-profile",
      },
      safety: { lavaAdjacent: false, voidRisk: false, waterAdjacent: false },
    });

    expect(calls).toHaveLength(1);
    const capabilityInput = (calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(mineBranchCapabilityInputSchema.safeParse(capabilityInput).success).toBe(true);
    expect(capabilityInput.plan).not.toHaveProperty("ok");
    expect(capabilityInput.plan).not.toHaveProperty("exclusions");
    expect(output.steps).toHaveLength(2);
  });
});
