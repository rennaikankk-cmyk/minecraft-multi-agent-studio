import { describe, expect, it, vi } from "vitest";

import {
  ensureItemInputSchema,
  ensureItemSkill,
  SkillFault,
  type SkillExecutionContext,
} from "../src/index.js";

const SERVER = "isolated-local";
const DIMENSION = "minecraft:overworld";

type Inventory = Record<string, number>;

function contextFor(
  inventory: Inventory,
  options: Readonly<{
    failCraftOnce?: boolean;
    pauseInitialSnapshots?: number;
    pauseAfterCraftSnapshots?: number;
  }> = {},
): Readonly<{
  context: SkillExecutionContext;
  operations: string[];
  inventory: Inventory;
}> {
  let worldStateVersion = 1;
  let failedCraft = false;
  let craftCompleted = false;
  let initialPausesRemaining = options.pauseInitialSnapshots ?? 0;
  let postCraftPausesRemaining = options.pauseAfterCraftSnapshots ?? 0;
  const operations: string[] = [];
  const controller = new AbortController();
  const state = { ...inventory };
  const count = (name: string): number => state[name] ?? 0;
  const add = (name: string, amount: number): void => {
    state[name] = Math.max(0, count(name) + amount);
    worldStateVersion += 1;
  };
  const consume = (name: string, amount: number): void => {
    state[name] = Math.max(0, count(name) - amount);
    worldStateVersion += 1;
  };
  const context = Object.freeze({
    invocationId: "11111111-1111-4111-8111-111111111111",
    traceId: "trace-ensure-item-001",
    taskId: "task-ensure-item-001",
    botId: "worker-01",
    signal: controller.signal,
    deadlineMs: Date.now() + 120_000,
    compatibility: Object.freeze({
      minecraftVersion: "1.21.8",
      protocolVersion: 774,
      variantId: "portable",
      verification: "unverified" as const,
    }),
    callCapability: async <TOutput>(
      _capability: string,
      operation: string,
      input: unknown,
    ): Promise<TOutput> => {
      operations.push(operation);
      if (operation === "inventory.snapshot") {
        if (initialPausesRemaining > 0) {
          initialPausesRemaining -= 1;
          throw new SkillFault("NORMAL_ACTIONS_PAUSED");
        }
        if (craftCompleted && postCraftPausesRemaining > 0) {
          postCraftPausesRemaining -= 1;
          throw new SkillFault("SKILL_EXECUTION_INTERRUPTED");
        }
        return {
          dimension: DIMENSION,
          serverProfileId: SERVER,
          worldStateVersion,
          items: Object.entries(state)
            .filter(([, amount]) => amount > 0)
            .map(([itemName, amount]) => ({ itemName, count: amount })),
        } as TOutput;
      }

      if (operation === "collect.blocks-safe") {
        const collectInput = input as { blockName: string; maxCount: number };
        const drops: Readonly<Record<string, string>> = {
          stone: "cobblestone",
          coal_ore: "coal",
          iron_ore: "raw_iron",
        };
        add(drops[collectInput.blockName] ?? collectInput.blockName, collectInput.maxCount);
        return {
          blockName: collectInput.blockName,
          targetsFound: collectInput.maxCount,
          itemsCollected: collectInput.maxCount,
        } as TOutput;
      }

      if (operation === "craft.item-safe") {
        if (options.failCraftOnce && !failedCraft) {
          failedCraft = true;
          throw new Error("transient craft transport failure");
        }
        const craftInput = input as { itemName: string; count: number };
        const target = craftInput.itemName;
        const recipes: Record<string, Readonly<{ inputs: readonly [string, number][]; output: number }>> = {
          oak_planks: { inputs: [["oak_log", 1]], output: 4 },
          stick: { inputs: [["oak_planks", 2]], output: 4 },
          crafting_table: { inputs: [["oak_planks", 4]], output: 1 },
          furnace: { inputs: [["cobblestone", 8]], output: 1 },
          wooden_pickaxe: { inputs: [["oak_planks", 3], ["stick", 2]], output: 1 },
          stone_pickaxe: { inputs: [["cobblestone", 3], ["stick", 2]], output: 1 },
          iron_pickaxe: { inputs: [["iron_ingot", 3], ["stick", 2]], output: 1 },
        };
        const recipe = recipes[target];
        if (recipe === undefined) {
          throw new Error(`fake recipe unavailable for ${target}`);
        }
        const shortfall = Math.max(0, craftInput.count - count(target));
        const runs = Math.ceil(shortfall / recipe.output);
        for (const [name, amount] of recipe.inputs) consume(name, amount * runs);
        const crafted = runs * recipe.output;
        add(target, crafted);
        craftCompleted = true;
        return {
          itemName: target,
          requestedCount: craftInput.count,
          craftedCount: crafted,
          usedCraftingTable: target === "wooden_pickaxe",
        } as TOutput;
      }

      if (operation === "smelt.item-safe") {
        const smeltInput = input as {
          inputItemName: string;
          fuelItemName: string;
          fuelCount: number;
          count: number;
        };
        consume(smeltInput.inputItemName, smeltInput.count);
        consume(smeltInput.fuelItemName, smeltInput.fuelCount);
        add("iron_ingot", smeltInput.count);
        return {
          inputItemName: smeltInput.inputItemName,
          fuelItemName: smeltInput.fuelItemName,
          outputItemName: "iron_ingot",
          insertedFuelCount: smeltInput.fuelCount,
          requestedCount: smeltInput.count,
          smeltedCount: smeltInput.count,
        } as TOutput;
      }
      throw new Error(`unexpected operation ${operation}`);
    },
  }) as unknown as SkillExecutionContext;
  return { context, operations, inventory: state };
}

function run(
  inventory: Inventory,
  options: Readonly<{
    failCraftOnce?: boolean;
    pauseInitialSnapshots?: number;
    pauseAfterCraftSnapshots?: number;
  }> = {},
) {
  return runGoal("wooden_pickaxe", inventory, options);
}

function runGoal(
  itemName: string,
  inventory: Inventory,
  options: Readonly<{
    failCraftOnce?: boolean;
    pauseInitialSnapshots?: number;
    pauseAfterCraftSnapshots?: number;
  }> = {},
  count = 1,
) {
  const fixture = contextFor(inventory, options);
  const input = ensureItemInputSchema.parse({
    itemName,
    count,
    dimension: DIMENSION,
    serverProfileId: SERVER,
  });
  return ensureItemSkill.execute(fixture.context, input, {
    online: true,
    normalActionsAllowed: true,
    serverProfileId: SERVER,
    position: {
      x: 0,
      y: 64,
      z: 0,
      dimension: DIMENSION,
      serverProfileId: SERVER,
    },
  }).then((output) => ({ ...fixture, output }));
}

describe("goal.ensure-item", () => {
  it("short-circuits from one bounded inventory snapshot", async () => {
    const result = await run({ wooden_pickaxe: 1 });
    expect(result.output.reason).toBe("GOAL_ALREADY_SATISFIED");
    expect(result.output.progress.actualCount).toBe(1);
    expect(result.output.metrics.inventorySnapshots).toBe(1);
    expect(result.operations).toEqual(["inventory.snapshot"]);
  });

  it("executes the wooden pickaxe dependency chain without direct station placement", async () => {
    const result = await run({});
    expect(result.output.status).toBe("SUCCESS");
    expect(result.output.reason).toBe("GOAL_POSTCONDITION_VERIFIED");
    expect(result.inventory.wooden_pickaxe).toBeGreaterThanOrEqual(1);
    expect(result.output.verification.verified).toBe(true);
    expect(result.output.metrics.llmRequests).toBe(0);
    expect(result.operations).not.toContain("world.place-block");
    expect(result.operations).not.toContain("place-station");
    expect(result.output.metrics.stationStepsDelegated).toBeGreaterThan(0);
    expect(result.output.evidence.some((entry) => entry.action === "craft.item-safe")).toBe(true);
  });

  it("does not make another station when inventory already contains many tables", async () => {
    const result = await run({
      oak_planks: 3,
      stick: 2,
      crafting_table: 10,
    });
    expect(result.inventory.crafting_table).toBe(10);
    expect(result.inventory.wooden_pickaxe).toBe(1);
    expect(result.operations.filter((operation) => operation === "world.place-block")).toHaveLength(0);
    expect(result.operations.filter((operation) => operation === "craft.item-safe")).toHaveLength(1);
  });

  it("executes a station item goal instead of treating its preparation as a no-op", async () => {
    const fixture = contextFor({
      cobblestone: 8,
      crafting_table: 1,
    });
    const input = ensureItemInputSchema.parse({
      itemName: "furnace",
      count: 1,
      dimension: DIMENSION,
      serverProfileId: SERVER,
    });
    const output = await ensureItemSkill.execute(fixture.context, input, {
      online: true,
      normalActionsAllowed: true,
      serverProfileId: SERVER,
      position: {
        x: 0,
        y: 64,
        z: 0,
        dimension: DIMENSION,
        serverProfileId: SERVER,
      },
    });
    expect(output.status).toBe("SUCCESS");
    expect(fixture.inventory.furnace).toBeGreaterThanOrEqual(1);
    expect(fixture.operations).toContain("craft.item-safe");
  });

  it("allows a bounded goal to craft more than one stack of an intermediate", async () => {
    const result = await runGoal("crafting_table", {}, {}, 64);

    expect(result.output.status).toBe("SUCCESS");
    expect(result.inventory.crafting_table).toBeGreaterThanOrEqual(64);
    expect(result.output.verification.verified).toBe(true);
  });

  it("executes the empty-inventory iron pickaxe chain including furnace creation", async () => {
    const result = await runGoal("iron_pickaxe", {});

    expect(result.output.status).toBe("SUCCESS");
    expect(result.inventory.iron_pickaxe).toBeGreaterThanOrEqual(1);
    expect(result.output.metrics.llmRequests).toBe(0);
    expect(result.operations).toContain("smelt.item-safe");
    expect(result.output.evidence).toContainEqual(
      expect.objectContaining({
        kind: "craft",
        itemName: "furnace",
        action: "craft.item-safe",
        verified: true,
      }),
    );
    expect(result.operations).not.toContain("world.place-block");
  });

  it("uses PlanSupervisor's bounded retry after a transient action failure", async () => {
    const result = await run({ oak_planks: 3, stick: 2, crafting_table: 1 }, { failCraftOnce: true });
    expect(result.output.status).toBe("SUCCESS");
    expect(result.output.metrics.retries).toBeGreaterThanOrEqual(1);
    expect(result.output.metrics.recoveries).toBeGreaterThanOrEqual(1);
    expect(result.inventory.wooden_pickaxe).toBe(1);
  });

  it("waits through a bounded L0 pause before the initial precheck", async () => {
    const result = await run(
      { wooden_pickaxe: 1 },
      { pauseInitialSnapshots: 2 },
    );
    expect(result.output.reason).toBe("GOAL_ALREADY_SATISFIED");
    expect(result.operations.filter((operation) => operation === "inventory.snapshot"))
      .toHaveLength(3);
  });

  it("reobserves and continues after L0 interrupts an in-flight plan", async () => {
    const result = await run(
      { oak_planks: 3, stick: 2, crafting_table: 1 },
      { pauseAfterCraftSnapshots: 2 },
    );
    expect(result.output.status).toBe("SUCCESS");
    expect(result.inventory.wooden_pickaxe).toBe(1);
    expect(result.output.metrics.llmRequests).toBe(0);
  });
});

describe("goal.ensure-item cancellation", () => {
  it("checks the AbortSignal before issuing a capability call", async () => {
    const fixture = contextFor({});
    const controller = new AbortController();
    controller.abort();
    const abortedContext = Object.freeze({ ...fixture.context, signal: controller.signal });
    await expect(
      ensureItemSkill.execute(
        abortedContext,
        ensureItemInputSchema.parse({
          itemName: "wooden_pickaxe",
          count: 1,
          dimension: DIMENSION,
          serverProfileId: SERVER,
        }),
        {
          online: true,
          normalActionsAllowed: true,
          serverProfileId: SERVER,
          position: null,
        },
      ),
    ).rejects.toMatchObject({ code: "SKILL_CANCELLED" });
  });
});
