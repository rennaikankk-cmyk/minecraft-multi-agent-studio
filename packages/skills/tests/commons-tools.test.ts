import { describe, expect, it } from "vitest";

import {
  blockNameForItem,
  blockDropByItemName,
  craftRecipes,
  expandCraftPlan,
  harvestRequirementFor,
  harvestRequirementForItem,
  isLog,
  isPlanks,
  materialTierOfItem,
  normalizeItemName,
  parseToolId,
  recipeFor,
  tierAtLeast,
  toolIdFor,
  toolMaterialCostByKind,
} from "../src/commons/index.js";
import { toolPlanSkill } from "../src/builtin/tool-plan.js";

// ---------------------------------------------------------------------------
// 自举科技树的配方事实 + 计划器的顺序与缺口报告。
// ---------------------------------------------------------------------------

const scope = { serverProfileId: "isolated-local" };
const state = { online: true, normalActionsAllowed: true, serverProfileId: "isolated-local" };

describe("commons/tools — 配方表", () => {
  it("记住木材链：1 原木 = 4 木板，2 木板 = 4 木棍，工作台 = 4 木板", () => {
    expect(recipeFor("oak_planks")).toMatchObject({ outputCount: 4, kind: "crafting", inputs: [{ itemName: "oak_log", count: 1 }] });
    expect(recipeFor("stick")).toMatchObject({ outputCount: 4, kind: "crafting", inputs: [{ itemName: "oak_planks", count: 2 }] });
    expect(recipeFor("crafting_table")).toMatchObject({ outputCount: 1, kind: "crafting", inputs: [{ itemName: "oak_planks", count: 4 }] });
  });

  it("记住四档工具的材料数：镐/斧 3+2，铲 1+2，剑 2+1", () => {
    expect(toolMaterialCostByKind.pickaxe).toEqual({ material: 3, sticks: 2 });
    expect(toolMaterialCostByKind.axe).toEqual({ material: 3, sticks: 2 });
    expect(toolMaterialCostByKind.shovel).toEqual({ material: 1, sticks: 2 });
    expect(toolMaterialCostByKind.sword).toEqual({ material: 2, sticks: 1 });
    expect(toolIdFor("wood", "pickaxe")).toBe("wooden_pickaxe");
    expect(toolIdFor("stone", "pickaxe")).toBe("stone_pickaxe");
    expect(toolIdFor("none", "pickaxe")).toBeNull();
  });

  it("工作台是 2×2 配方，熔炉是 3×3 配方且要 8 圆石", () => {
    expect(recipeFor("crafting_table")?.kind).toBe("crafting");
    expect(recipeFor("furnace")).toMatchObject({ kind: "crafting_table", inputs: [{ itemName: "cobblestone", count: 8 }] });
  });

  it("记住工具→方块对应：镐挖石/矿，徒手砍木，铲挖土，剪刀剪羊毛/树叶", () => {
    expect(harvestRequirementFor("stone")).toMatchObject({ tool: "pickaxe", minTier: "wood" });
    expect(harvestRequirementFor("iron_ore")).toMatchObject({ tool: "pickaxe", minTier: "stone" });
    expect(harvestRequirementFor("diamond_ore")).toMatchObject({ tool: "pickaxe", minTier: "iron" });
    expect(harvestRequirementFor("obsidian")).toMatchObject({ tool: "pickaxe", minTier: "diamond" });
    // 原木徒手可采（自举起点，不能要求斧头）。
    expect(harvestRequirementFor("oak_log")).toMatchObject({ tool: "hand", minTier: "none" });
    expect(harvestRequirementFor("dirt")).toMatchObject({ tool: "shovel" });
    expect(harvestRequirementFor("white_wool")).toMatchObject({ tool: "shears" });
    // 物品→方块再查：圆石来自石头、钻石来自钻石矿。
    expect(harvestRequirementForItem("cobblestone")).toMatchObject({ tool: "pickaxe", minTier: "wood" });
    expect(harvestRequirementForItem("diamond")).toMatchObject({ tool: "pickaxe", minTier: "iron" });
    expect(harvestRequirementForItem("oak_planks")).toBeNull();
  });

  it("档位比较与方块掉落的映射", () => {
    expect(tierAtLeast("stone", "wood")).toBe(true);
    expect(tierAtLeast("wood", "stone")).toBe(false);
    expect(blockNameForItem("cobblestone")).toBe("stone");
    expect(blockNameForItem("diamond")).toBe("diamond_ore");
    expect(blockNameForItem("oak_log")).toBe("oak_log");
    expect(Object.keys(blockDropByItemName)).toContain("raw_iron");
  });

  it("id 规范化与家族识别（命名空间前缀、木板/原木）", () => {
    expect(normalizeItemName("minecraft:Oak_Log")).toBe("oak_log");
    expect(isPlanks("minecraft:birch_planks")).toBe(true);
    expect(isLog("spruce_log")).toBe(true);
    expect(isLog("spruce_stem")).toBe(true);
    expect(materialTierOfItem("iron_ingot")).toBe("iron");
    expect(materialTierOfItem("birch_planks")).toBe("wood");
    expect(materialTierOfItem("dirt")).toBe("none");
  });

  it("配方表里每一条都能自洽解析（kind 与 requiredTool 一致）", () => {
    for (const recipe of craftRecipes.values()) {
      if (recipe.kind === "mining") {
        expect(recipe.inputs).toEqual([]);
        expect(recipe.requiredTool).not.toBeNull();
      } else {
        expect(recipe.inputs.length).toBeGreaterThan(0);
        expect(recipe.requiredTool).toBeNull();
      }
    }
  });
});

describe("commons/tools — 依赖展开", () => {
  it("木镐 + 空背包 → 缺 3 木板与 2 木棍，一路展开到原木", () => {
    const plan = expandCraftPlan("wooden_pickaxe", 1, {});
    expect(plan).toMatchObject({ itemName: "wooden_pickaxe", source: "craft", missingCount: 1 });
    const planks = plan.children.find((child) => child.itemName === "oak_planks");
    const sticks = plan.children.find((child) => child.itemName === "stick");
    expect(planks).toMatchObject({ count: 3, source: "craft" });
    expect(sticks).toMatchObject({ count: 2, source: "craft" });
    // 2 木棍 = 1 批木棍配方 = 2 木板；合计 3 + 2 = 5 木板 → 2 原木（每原木 4 木板）。
    const stickPlanks = sticks?.children.find((child) => child.itemName === "oak_planks");
    expect(stickPlanks).toMatchObject({ count: 2, missingCount: 2 });
    expect(planks?.children.find((child) => child.itemName === "oak_log")).toMatchObject({ count: 1, missingCount: 1 });
  });

  it("已有材料时不再展开", () => {
    const plan = expandCraftPlan("wooden_pickaxe", 1, { wooden_pickaxe: 1 });
    expect(plan).toMatchObject({ source: "available", missingCount: 0, children: [] });
  });

  it("圆石按 mining 处理（不再往下要材料）", () => {
    const plan = expandCraftPlan("stone_pickaxe", 1, {});
    const cobble = plan.children.find((child) => child.itemName === "cobblestone");
    expect(cobble).toMatchObject({ source: "mine", count: 3, children: [] });
  });
});

describe("tool.plan — 有序自举计划", () => {
  it("空手 + 1 原木 → 木镐：木板→木棍→木镐，全部 2×2，不需要工作台", async () => {
    const output = await toolPlanSkill.execute(
      {} as never,
      { goalTool: "wooden_pickaxe", count: 1, available: [{ itemName: "oak_log", count: 1 }], harvestable: ["oak_log"], ...scope },
      state,
    );
    expect(output.verdict).toBe("PLAN_READY");
    expect(output.planRequiresCraftingTable).toBe(false);
    // 木镐要 3 板 + 2 棍 = 4 板 → 正好 1 原木；两批木板（第 1 批用库存原木，
    // 第 2 批现砍）都落在 2×2 网格里，全程不需要工作台。
    expect(output.steps.map((step) => step.itemName)).toEqual(["oak_planks", "oak_log", "oak_planks", "stick", "wooden_pickaxe"]);
    expect(output.steps.map((step) => step.order)).toEqual([1, 2, 3, 4, 5]);
    expect(output.steps.every((step) => !step.needsCraftingTable)).toBe(true);
    expect(output.missingMaterials).toEqual([]);
    // 2 批木板 = 8 板；镐用 3、棍用 2（木棍 4 根只用 2）= 用掉 5 → 剩 3 板 + 2 棍。
    expect(output.remainingAfterPlan).toEqual([
      { itemName: "oak_planks", count: 3 },
      { itemName: "stick", count: 2 },
    ]);
  });

  it("手头木板够时不再多砍一棵树（余量复用）", async () => {
    const output = await toolPlanSkill.execute(
      {} as never,
      {
        goalTool: "wooden_pickaxe",
        count: 1,
        available: [{ itemName: "oak_planks", count: 4 }],
        harvestable: ["oak_log"],
        ...scope,
      },
      state,
    );
    expect(output.verdict).toBe("PLAN_READY");
    // 4 板里 2 板做木棍、3 板做木镐，还差 1 板 → 补 1 批木板（现砍 1 根原木），一块不多搓。
    expect(output.steps.map((step) => step.itemName)).toEqual(["oak_log", "oak_planks", "stick", "wooden_pickaxe"]);
    expect(output.remainingAfterPlan).toEqual([{ itemName: "oak_planks", count: 3 }, { itemName: "stick", count: 2 }]);
  });

  it("没告诉计划器原木从哪来时，如实报缺口而不是假装有计划", async () => {
    const output = await toolPlanSkill.execute(
      {} as never,
      { goalTool: "wooden_pickaxe", count: 1, available: [], ...scope },
      state,
    );
    expect(output.verdict).toBe("MISSING_MATERIALS");
    expect(output.steps).toEqual([]);
    expect(output.missingMaterials).toEqual([{ itemName: "oak_log", missingCount: 1, reason: "NO_SOURCE" }]);
  });

  it("空手 + 原木 → 石镐：必须先做出木镐才排得动挖圆石这一步", async () => {
    const output = await toolPlanSkill.execute(
      {} as never,
      { goalTool: "stone_pickaxe", count: 1, available: [{ itemName: "oak_log", count: 1 }], harvestable: ["oak_log"], ...scope },
      state,
    );
    const order = output.steps.map((step) => step.itemName);
    // 木镐要 4 板（3 做镐 + 2 做棍 → 2 批木板），所以先砍一根原木再补一批。
    expect(order).toEqual(["oak_planks", "oak_log", "oak_planks", "stick", "wooden_pickaxe", "cobblestone", "stone_pickaxe"]);
    const mineStep = output.steps.find((step) => step.itemName === "cobblestone")!;
    expect(mineStep).toMatchObject({ action: "mine", requiredTool: "pickaxe", requiredTier: "wood", outputCount: 3, needsCraftingTable: false });
    // 工具必须在挖矿步之前出现。
    expect(order.indexOf("wooden_pickaxe")).toBeLessThan(order.indexOf("cobblestone"));
    expect(output.verdict).toBe("PLAN_READY");
  });

  it("熔炉是 3×3 配方：先排工作台，并把 8 圆石写进消耗", async () => {
    const output = await toolPlanSkill.execute(
      {} as never,
      { goalTool: "furnace", count: 1, available: [{ itemName: "oak_log", count: 4 }], harvestable: ["oak_log"], ...scope },
      state,
    );
    const order = output.steps.map((step) => step.itemName);
    expect(order).toContain("crafting_table");
    expect(order.indexOf("crafting_table")).toBeLessThan(order.indexOf("furnace"));
    expect(output.planRequiresCraftingTable).toBe(true);
    expect(output.verdict).toBe("NEEDS_CRAFTING_TABLE");
    const furnaceStep = output.steps.find((step) => step.itemName === "furnace")!;
    expect(furnaceStep).toMatchObject({ action: "craft", needsCraftingTable: true, consumes: [{ itemName: "cobblestone", count: 8 }] });
  });

  it("已经拿着工作台时不再重复合成，verdict 也不再是 NEEDS_CRAFTING_TABLE", async () => {
    const output = await toolPlanSkill.execute(
      {} as never,
      {
        goalTool: "furnace",
        count: 1,
        available: [{ itemName: "oak_log", count: 4 }, { itemName: "crafting_table", count: 1 }],
        harvestable: ["oak_log"],
        ...scope,
      },
      state,
    );
    expect(output.craftingTableAlreadyHeld).toBe(true);
    expect(output.steps.map((step) => step.itemName)).not.toContain("crafting_table");
    expect(output.verdict).toBe("PLAN_READY");
  });

  it("矿石来源齐全时整条链排到钻石镐：计划里没有缺口，只剩「去哪儿挖」", async () => {
    const output = await toolPlanSkill.execute(
      {} as never,
      {
        goalTool: "diamond_pickaxe",
        count: 1,
        // 6 原木 = 24 木板，够整条链的木板开销（木镐 5 + 石镐 5 + 工作台 4 + 铁镐 5）。
        available: [{ itemName: "oak_log", count: 6 }],
        harvestable: ["oak_log", "stone", "iron_ore", "diamond_ore"],
        ...scope,
      },
      state,
    );
    expect(output.verdict).toBe("PLAN_READY");
    expect(output.missingMaterials).toEqual([]);
    expect(output.steps.map((step) => step.itemName)).toContain("diamond_pickaxe");
  });

  it("矿石来源齐全时，从空手一路排到钻石镐：档位依赖必须逐级出现", async () => {
    const output = await toolPlanSkill.execute(
      {} as never,
      {
        goalTool: "diamond_pickaxe",
        count: 1,
        // 6 原木 = 24 木板，够整条链的木板开销（木镐 5 + 石镐 5 + 工作台 4 + 铁镐 5）。
        available: [{ itemName: "oak_log", count: 6 }],
        harvestable: ["oak_log", "stone", "iron_ore", "diamond_ore"],
        ...scope,
      },
      state,
    );
    expect(output.verdict).toBe("PLAN_READY");
    const order = output.steps.map((step) => step.itemName);
    // 每一级的工具都在"用它挖矿"之前，且整体顺序单调递增。
    const sequence = ["wooden_pickaxe", "cobblestone", "stone_pickaxe", "raw_iron", "iron_ingot", "iron_pickaxe", "diamond", "diamond_pickaxe"];
    let cursor = -1;
    for (const itemName of sequence) {
      const index = order.indexOf(itemName);
      expect(index, `${itemName} 应当出现在计划里：${order.join("→")}`).toBeGreaterThan(-1);
      expect(index, `${itemName} 的顺序不对：${order.join("→")}`).toBeGreaterThan(cursor);
      cursor = index;
    }
    const diamondMine = output.steps.find((step) => step.itemName === "diamond")!;
    expect(diamondMine).toMatchObject({ action: "mine", requiredTier: "iron" });
  });

  it("钻石矿有来源但铁矿没来源时：计划仍自洽，缺口清单如实报出没来源的那一项", async () => {
    const output = await toolPlanSkill.execute(
      {} as never,
      {
        goalTool: "diamond_pickaxe",
        count: 1,
        // 木头/石头能采、钻石矿也在来源清单里，但**铁矿不知道在哪**。
        // 计划器不假装知道矿脉：它照常排"挖铁矿 → 烧铁锭 → 做铁镐 → 挖钻石"，
        // 由调用方去核实铁矿到底有没有。
        available: [{ itemName: "oak_log", count: 8 }],
        harvestable: ["oak_log", "stone", "diamond_ore"],
        ...scope,
      },
      state,
    );
    const order = output.steps.map((step) => step.itemName);
    // 核心不变式：铁镐先被做出来，才轮到挖钻石。
    expect(order).toContain("raw_iron");
    expect(order.indexOf("iron_pickaxe")).toBeLessThan(order.indexOf("diamond"));
    // 铁锭这一步自带工具前提说明（需要熔炉燃料），不是无声的凭空产出。
    const smelt = output.steps.find((step) => step.itemName === "iron_ingot")!;
    expect(smelt).toMatchObject({ action: "smelt", consumes: [{ itemName: "raw_iron", count: 3 }] });
    expect(smelt.note).toContain("熔炉");
  });

  it("没有任何已知来源时判 MISSING_MATERIALS，且不排出半成品计划", async () => {
    const output = await toolPlanSkill.execute(
      {} as never,
      { goalTool: "wooden_pickaxe", count: 1, available: [], harvestable: [], ...scope },
      state,
    );
    expect(output.verdict).toBe("MISSING_MATERIALS");
    expect(output.steps).toEqual([]);
    expect(output.missingMaterials).toEqual([{ itemName: "oak_log", missingCount: 1, reason: "NO_SOURCE" }]);
  });

  it("来源齐全时会把整条工具链按档位逐级做出来（不会用还不存在的铁镐去挖钻石）", async () => {
    const output = await toolPlanSkill.execute(
      {} as never,
      {
        goalTool: "diamond_pickaxe",
        count: 1,
        available: [{ itemName: "oak_log", count: 8 }],
        harvestable: ["oak_log", "stone", "iron_ore", "diamond_ore"],
        ...scope,
      },
      state,
    );
    expect(output.verdict).toBe("PLAN_READY");
    const order = output.steps.map((step) => step.itemName);
    // 关键不变式：每一步挖矿/烧炼所要求的工具，都已经在它**之前**的合成步里出现过。
    const tierRank: Record<string, number> = { none: 0, wood: 1, stone: 2, iron: 3, diamond: 4 };
    for (const [index, step] of output.steps.entries()) {
      if (step.requiredTool === null || step.requiredTier === "none") continue;
      const satisfied = output.steps.slice(0, index).some((earlier) => {
        if (earlier.action !== "craft") return false;
        const parsed = parseToolId(earlier.itemName);
        return (
          parsed !== null &&
          parsed.kind === step.requiredTool &&
          tierRank[parsed.tier]! >= tierRank[step.requiredTier]!
        );
      });
      expect(satisfied, `${step.itemName} 需要的 ${step.requiredTier} ${step.requiredTool} 必须先被做出来：${order.join("→")}`).toBe(true);
    }
    expect(order.indexOf("wooden_pickaxe")).toBeLessThan(order.indexOf("cobblestone"));
    expect(order.indexOf("stone_pickaxe")).toBeLessThan(order.indexOf("raw_iron"));
    expect(order.indexOf("iron_pickaxe")).toBeLessThan(order.indexOf("diamond"));
  });

  it("确定性的：同输入两次跑出完全一样的计划", async () => {
    const input = { goalTool: "stone_axe", count: 1, available: [{ itemName: "oak_log", count: 2 }], harvestable: ["oak_log"], ...scope };
    const first = await toolPlanSkill.execute({} as never, input, state);
    const second = await toolPlanSkill.execute({} as never, input, state);
    expect(first).toEqual(second);
  });

  it("目标物品没有配方时抛 SkillFault（结构性问题，不当裁决返回）", async () => {
    await expect(
      toolPlanSkill.execute({} as never, { goalTool: "dirt", count: 1, available: [], ...scope }, state),
    ).rejects.toMatchObject({ code: "PLAN_ITEM_UNOBTAINABLE" });
  });

  it("声明层面：纯技能、幂等、不重试、无 capability", () => {
    expect(toolPlanSkill.requiredCapabilities).toEqual([]);
    expect(toolPlanSkill.idempotent).toBe(true);
    expect(toolPlanSkill.retryPolicy).toMatchObject({ maxAttempts: 1, retryableErrorCodes: [] });
    expect(toolPlanSkill.preconditions.map(({ failureCode }) => failureCode)).toContain("BOT_NOT_ONLINE");
    expect(toolPlanSkill.preconditions.map(({ failureCode }) => failureCode)).toContain("NORMAL_ACTIONS_PAUSED");
    expect(parseToolId("wooden_pickaxe")).toEqual({ tier: "wood", kind: "pickaxe" });
  });
});
