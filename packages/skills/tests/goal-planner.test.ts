import { describe, expect, it } from "vitest";

import {
  GoalPlanner,
  MAX_GOAL_COUNT,
  ResourceGraph,
  resourceRecipeSchema,
  skillIdForStepKind,
  vanillaResourceRecipes,
  type PlanResult,
  type PlanStep,
  type PlannerInventory,
} from "../src/index.js";

function planned(result: PlanResult): readonly PlanStep[] {
  if (!result.planned) {
    throw new Error(`expected a plan, got ${result.errorCode} on ${result.blockedOn}`);
  }
  return result.steps;
}

function plan(
  goals: readonly { itemName: string; count: number }[],
  inventory: PlannerInventory = {},
) {
  return new GoalPlanner().plan(goals, inventory);
}

/**
 * 某物品第一次被产出的步序，用于断言依赖顺序。挖掘步骤按被挖方块也能命中，
 * 这样 "stone" / "iron_ore" 这类方块名和 "iron_ingot" 这类产出名都可查。
 */
function firstIndexOf(steps: readonly PlanStep[], name: string): number {
  return steps.findIndex(
    (step) => step.itemName === name || step.targetBlock === name,
  );
}

describe("ResourceGraph consistency", () => {
  it("ships a self-consistent vanilla recipe table", () => {
    const graph = new ResourceGraph();
    expect(graph.issues).toEqual([]);
    expect(graph.recipeFor("dirt")).toMatchObject({
      kind: "mine",
      sourceBlock: "dirt",
      toolTier: "none",
    });
    expect(graph.knows("diamond_pickaxe")).toBe(true);
    expect(graph.recipeFor("nether_star")).toBeNull();
  });

  it("reports duplicates, unknown inputs, and cycles instead of throwing", () => {
    const duplicate = new ResourceGraph([
      ...vanillaResourceRecipes,
      resourceRecipeSchema.parse({
        itemName: "stick",
        kind: "craft",
        yield: 1,
        inputs: [],
        toolTier: "none",
        station: null,
        sourceBlock: null,
        fuelCandidates: [],
      }),
    ]);
    expect(duplicate.issues).toContainEqual({
      itemName: "stick",
      code: "RESOURCE_RECIPE_DUPLICATE",
    });

    const unknownInput = new ResourceGraph([
      resourceRecipeSchema.parse({
        itemName: "widget",
        kind: "craft",
        yield: 1,
        inputs: [{ itemName: "unobtanium", count: 1 }],
        toolTier: "none",
        station: null,
        sourceBlock: null,
        fuelCandidates: [],
      }),
    ]);
    expect(unknownInput.issues).toContainEqual({
      itemName: "unobtanium",
      code: "RESOURCE_INPUT_UNKNOWN",
    });

    const cyclic = new ResourceGraph([
      resourceRecipeSchema.parse({
        itemName: "a",
        kind: "craft",
        yield: 1,
        inputs: [{ itemName: "b", count: 1 }],
        toolTier: "none",
        station: null,
        sourceBlock: null,
        fuelCandidates: [],
      }),
      resourceRecipeSchema.parse({
        itemName: "b",
        kind: "craft",
        yield: 1,
        inputs: [{ itemName: "a", count: 1 }],
        toolTier: "none",
        station: null,
        sourceBlock: null,
        fuelCandidates: [],
      }),
    ]);
    expect(cyclic.issues.some((issue) => issue.code === "RESOURCE_CYCLE")).toBe(true);
  });

  it("derives transitive tool requirements rather than only the direct one", () => {
    const graph = new ResourceGraph();
    // 铁镐配方本身不要求任何镐，但它的铁锭链路回溯到铁矿需要石镐。
    expect(graph.recipeFor("iron_pickaxe")?.toolTier).toBe("none");
    expect(graph.requiredToolTier("iron_pickaxe")).toBe("stone");
    expect(graph.requiredToolTier("diamond")).toBe("iron");
    expect(graph.requiredToolTier("oak_planks")).toBe("none");
  });

  it("rejects malformed recipes at the schema level", () => {
    const base = {
      itemName: "thing",
      kind: "mine",
      yield: 1,
      inputs: [],
      toolTier: "none",
      station: null,
      sourceBlock: null,
      fuelCandidates: [],
    };
    // mine 必须有 sourceBlock。
    expect(resourceRecipeSchema.safeParse(base).success).toBe(false);
    // craft 不能带 sourceBlock。
    expect(
      resourceRecipeSchema.safeParse({ ...base, kind: "craft", sourceBlock: "stone" })
        .success,
    ).toBe(false);
    // smelt 必须有燃料。
    expect(
      resourceRecipeSchema.safeParse({ ...base, kind: "smelt" }).success,
    ).toBe(false);
    // mine 不消耗任何东西。
    expect(
      resourceRecipeSchema.safeParse({
        ...base,
        sourceBlock: "stone",
        inputs: [{ itemName: "stick", count: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("GoalPlanner derives the diamond chain", () => {
  const result = plan([{ itemName: "diamond_pickaxe", count: 1 }]);
  const steps = planned(result);

  it("reaches a diamond pickaxe from an empty inventory", () => {
    expect(result.planned).toBe(true);
    expect(steps.at(-1)).toMatchObject({
      kind: "craft",
      itemName: "diamond_pickaxe",
      skillId: skillIdForStepKind.craft,
    });
  });

  it("orders the tool ladder wood → stone → iron before mining diamond", () => {
    const wooden = firstIndexOf(steps, "wooden_pickaxe");
    const stone = firstIndexOf(steps, "stone_pickaxe");
    const iron = firstIndexOf(steps, "iron_pickaxe");
    const diamondOre = firstIndexOf(steps, "diamond_ore");

    expect(wooden).toBeGreaterThanOrEqual(0);
    expect(wooden).toBeLessThan(stone);
    expect(stone).toBeLessThan(iron);
    expect(iron).toBeLessThan(diamondOre);
  });

  it("mines each ore only after the tier that can break it exists", () => {
    const stoneMine = firstIndexOf(steps, "stone");
    const ironOre = firstIndexOf(steps, "iron_ore");
    expect(firstIndexOf(steps, "wooden_pickaxe")).toBeLessThan(stoneMine);
    expect(firstIndexOf(steps, "stone_pickaxe")).toBeLessThan(ironOre);
  });

  it("smelts iron through a placed furnace with real fuel", () => {
    const smelt = steps.find((step) => step.kind === "smelt");
    expect(smelt).toMatchObject({ itemName: "iron_ingot", station: "furnace" });
    expect(smelt?.consumes.some((entry) => entry.itemName === "raw_iron")).toBe(true);
    // 燃料必须真的被列为消耗，而不是假设总能烧点什么。
    const fuel = smelt?.consumes.find((entry) =>
      (smelt?.fuelCandidates ?? []).includes(entry.itemName),
    );
    expect(fuel).toBeDefined();
    expect(firstIndexOf(steps, "furnace")).toBeLessThan(
      steps.findIndex((step) => step.kind === "smelt"),
    );
  });

  it("places each station once, not once per craft", () => {
    const placements = steps.filter((step) => step.kind === "place-station");
    const stations = placements.map((step) => step.itemName);
    expect(new Set(stations).size).toBe(stations.length);
    expect(stations).toContain("crafting_table");
    if (result.planned) expect(result.stations).toContain("crafting_table");
  });

  it("crafts one pickaxe per tier, not one per block mined", () => {
    for (const tool of ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe"]) {
      expect(steps.filter((step) => step.itemName === tool)).toHaveLength(1);
    }
  });

  it("labels every step with a dispatchable skill id", () => {
    for (const step of steps) {
      expect(step.skillId).toBe(skillIdForStepKind[step.kind]);
      expect(step.runs).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("GoalPlanner scaling and inventory", () => {
  it("derives a full diamond armour set as one shared chain", () => {
    const result = plan([
      { itemName: "diamond_helmet", count: 1 },
      { itemName: "diamond_chestplate", count: 1 },
      { itemName: "diamond_leggings", count: 1 },
      { itemName: "diamond_boots", count: 1 },
    ]);
    const steps = planned(result);
    // 四件护甲共享同一条镐子升级链，不会重复推四次。
    expect(steps.filter((step) => step.itemName === "iron_pickaxe")).toHaveLength(1);
    const diamondMined = steps
      .filter((step) => step.kind === "mine" && step.targetBlock === "diamond_ore")
      .reduce((total, step) => total + step.producedCount, 0);
    expect(diamondMined).toBeGreaterThanOrEqual(5 + 8 + 7 + 4);
  });

  it("skips work that existing inventory already covers", () => {
    const withIron = plan([{ itemName: "iron_pickaxe", count: 1 }], {
      iron_ingot: 3,
      stick: 2,
      crafting_table: 1,
    });
    const steps = planned(withIron);
    expect(steps.some((step) => step.kind === "smelt")).toBe(false);
    expect(steps.some((step) => step.itemName === "wooden_pickaxe")).toBe(false);
    expect(steps.at(-1)?.itemName).toBe("iron_pickaxe");
  });

  it("counts an owned higher tier as satisfying a lower requirement", () => {
    const steps = planned(
      plan([{ itemName: "cobblestone", count: 3 }], { diamond_pickaxe: 1 }),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: "mine",
      itemName: "cobblestone",
      targetBlock: "stone",
    });
  });

  it("reserves only what it actually spends from the starting inventory", () => {
    const result = plan([{ itemName: "stick", count: 4 }], {
      oak_planks: 10,
      diamond: 5,
    });
    expect(result.planned).toBe(true);
    if (!result.planned) return;
    expect(result.reservations).toEqual([{ itemName: "oak_planks", count: 2 }]);
  });

  it("scales batches by recipe yield instead of one run per unit", () => {
    const steps = planned(plan([{ itemName: "oak_planks", count: 8 }]));
    const planksStep = steps.find((step) => step.itemName === "oak_planks");
    expect(planksStep).toMatchObject({ runs: 2, producedCount: 8 });
    expect(planksStep?.consumes).toEqual([{ itemName: "oak_log", count: 2 }]);
  });

  it("reports the final tool tier the plan leaves behind", () => {
    const result = plan([{ itemName: "diamond", count: 1 }]);
    expect(result.planned).toBe(true);
    if (result.planned) expect(result.finalToolTier).toBe("iron");
  });
});

/**
 * 最重要的一组断言：把计划当成真的执行一遍。规划器说"消耗 3 个木板"时，
 * 那一刻虚拟库存里必须真的有 3 个木板——否则计划在服务器上必然中途失败。
 */
function replay(
  steps: readonly PlanStep[],
  startInventory: PlannerInventory = {},
): Map<string, number> {
  const stock = new Map<string, number>(Object.entries(startInventory));
  const have = (itemName: string) => stock.get(itemName) ?? 0;
  for (const step of steps) {
    for (const consumed of step.consumes) {
      if (have(consumed.itemName) < consumed.count) {
        throw new Error(
          `step ${step.stepIndex} (${step.kind} ${step.itemName}) needs ` +
            `${consumed.count}x ${consumed.itemName} but only ${have(
              consumed.itemName,
            )} available`,
        );
      }
      stock.set(consumed.itemName, have(consumed.itemName) - consumed.count);
    }
    if (step.kind !== "place-station") {
      stock.set(step.itemName, have(step.itemName) + step.producedCount);
    }
  }
  return stock;
}

describe("GoalPlanner plans are executable as ordered", () => {
  it("never consumes an item before the plan has produced it", () => {
    const cases: readonly { goals: { itemName: string; count: number }[]; inv: PlannerInventory }[] =
      [
        { goals: [{ itemName: "diamond_pickaxe", count: 1 }], inv: {} },
        { goals: [{ itemName: "diamond_sword", count: 1 }], inv: {} },
        { goals: [{ itemName: "furnace", count: 1 }], inv: {} },
        { goals: [{ itemName: "iron_ingot", count: 5 }], inv: {} },
        {
          goals: [
            { itemName: "diamond_helmet", count: 1 },
            { itemName: "diamond_chestplate", count: 1 },
            { itemName: "diamond_leggings", count: 1 },
            { itemName: "diamond_boots", count: 1 },
          ],
          inv: {},
        },
        {
          goals: [{ itemName: "iron_pickaxe", count: 1 }],
          inv: { iron_ingot: 3, stick: 2, crafting_table: 1 },
        },
        { goals: [{ itemName: "stone_pickaxe", count: 2 }], inv: { oak_log: 1 } },
      ];
    for (const { goals, inv } of cases) {
      const steps = planned(plan(goals, inv));
      expect(() => replay(steps, inv)).not.toThrow();
    }
  });

  it("ends holding at least the goal amount", () => {
    const goals = [{ itemName: "diamond_pickaxe", count: 1 }];
    const finalStock = replay(planned(plan(goals)));
    expect(finalStock.get("diamond_pickaxe") ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("reports the tier it ends up holding even when the tool is the goal", () => {
    const result = plan([{ itemName: "iron_pickaxe", count: 1 }], {
      iron_ingot: 3,
      stick: 2,
      crafting_table: 1,
    });
    expect(result.planned).toBe(true);
    if (result.planned) expect(result.finalToolTier).toBe("iron");
  });
});

describe("GoalPlanner failure reporting", () => {
  it("names the unobtainable item rather than failing vaguely", () => {
    expect(plan([{ itemName: "netherite_ingot", count: 1 }])).toMatchObject({
      planned: false,
      errorCode: "PLAN_ITEM_UNOBTAINABLE",
      blockedOn: "netherite_ingot",
    });
  });

  it("rejects invalid goals up front", () => {
    expect(plan([])).toMatchObject({
      planned: false,
      errorCode: "PLAN_GOAL_INVALID",
    });
    expect(plan([{ itemName: "stick", count: 0 }])).toMatchObject({
      planned: false,
      errorCode: "PLAN_GOAL_INVALID",
      blockedOn: "stick",
    });
    expect(plan([{ itemName: "stick", count: 1.5 }])).toMatchObject({
      planned: false,
      errorCode: "PLAN_GOAL_INVALID",
    });
    expect(
      plan([{ itemName: "stick", count: MAX_GOAL_COUNT + 1 }]),
    ).toMatchObject({ planned: false, errorCode: "PLAN_GOAL_INVALID" });
  });

  it("stays inside its step budget for the largest sensible request", () => {
    const result = plan([
      { itemName: "diamond_pickaxe", count: 1 },
      { itemName: "diamond_sword", count: 1 },
      { itemName: "diamond_helmet", count: 1 },
      { itemName: "diamond_chestplate", count: 1 },
      { itemName: "diamond_leggings", count: 1 },
      { itemName: "diamond_boots", count: 1 },
    ]);
    const steps = planned(result);
    expect(steps.length).toBeLessThanOrEqual(64);
    expect(steps.at(-1)?.itemName).toBe("diamond_boots");
  });

  it("fails closed on a cyclic custom graph instead of looping forever", () => {
    const cyclic = new GoalPlanner(
      new ResourceGraph([
        resourceRecipeSchema.parse({
          itemName: "a",
          kind: "craft",
          yield: 1,
          inputs: [{ itemName: "b", count: 1 }],
          toolTier: "none",
          station: null,
          sourceBlock: null,
          fuelCandidates: [],
        }),
        resourceRecipeSchema.parse({
          itemName: "b",
          kind: "craft",
          yield: 1,
          inputs: [{ itemName: "a", count: 1 }],
          toolTier: "none",
          station: null,
          sourceBlock: null,
          fuelCandidates: [],
        }),
      ]),
    );
    expect(cyclic.plan([{ itemName: "a", count: 1 }])).toMatchObject({
      planned: false,
      errorCode: "PLAN_CYCLIC_DEPENDENCY",
    });
  });

  it("reports unreachable tiers instead of inventing a tool", () => {
    const unreachable = new GoalPlanner(
      new ResourceGraph([
        resourceRecipeSchema.parse({
          itemName: "bedrock",
          kind: "mine",
          yield: 1,
          inputs: [],
          toolTier: "diamond",
          station: null,
          sourceBlock: "bedrock",
          fuelCandidates: [],
        }),
      ]),
    );
    expect(unreachable.plan([{ itemName: "bedrock", count: 1 }])).toMatchObject({
      planned: false,
      errorCode: "PLAN_ITEM_UNOBTAINABLE",
    });
  });
});

describe("plank family equivalence", () => {
  it("plans sticks from a birch-only inventory without oak logs", () => {
    const steps = planned(plan([{ itemName: "stick", count: 4 }], { birch_log: 2 }));
    // 缺口谱系选择：手里有桦木原木 → 直接 craft birch_planks，不再要求 oak 链路
    const birchPlanks = firstIndexOf(steps, "birch_planks");
    expect(birchPlanks).toBeGreaterThanOrEqual(0);
    const stick = firstIndexOf(steps, "stick");
    expect(stick).toBeGreaterThan(birchPlanks);
    expect(steps.some((step) => step.itemName === "oak_planks")).toBe(false);
  });

  it("keeps the canonical oak lineage when no logs are in stock", () => {
    const steps = planned(plan([{ itemName: "stick", count: 4 }], {}));
    expect(steps.some((step) => step.itemName === "oak_planks")).toBe(true);
  });

  it("counts spruce planks already in stock toward an oak_planks requirement", () => {
    const steps = planned(
      plan([{ itemName: "crafting_table", count: 1 }], { spruce_planks: 4 }),
    );
    // 已有 4 云杉木板 → 无需再产出 oak_planks，也无需采集（crafting_table
    // 本身仍是一条 craft 步骤，工作站按需放置）。
    expect(steps.some((step) => step.itemName === "oak_planks")).toBe(false);
    expect(steps.some((step) => step.kind === "mine")).toBe(false);
  });
});
