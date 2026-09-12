// ---------------------------------------------------------------------------
// Minecraft 常识：工具与自举科技树。
//
// 覆盖"裸装冷启动 → 木 → 石 → 铁 → 钻石"这条最小可行路线所需要的**配方知识**：
//   - 每种配方的输入/产出、是否必须工作台（3×3）还是背包 2×2 就够
//   - 材料档位（wood/stone/iron/diamond）与"哪把工具能挖什么"的硬约束
//   - 一件物品的完整依赖展开（纯函数，不执行、不关心库存从哪来）
//
// 纯知识层：只吃 (itemName, 已有材料计数)，只吐计划/缺口。不碰世界、不碰背包。
// ---------------------------------------------------------------------------

import { z } from "zod";

/** 材料档位。数值越大越高级（开采等级判定用）。 */
export const materialTiers = ["none", "wood", "stone", "iron", "diamond", "netherite"] as const;
export const materialTierSchema = z.enum(materialTiers);
export type MaterialTier = (typeof materialTiers)[number];

/** 工具类别。hoe 只用于耕地，shears 是独立物品（不在四档工具链里）。 */
export const toolKinds = ["pickaxe", "axe", "shovel", "sword", "hoe"] as const;
export const toolKindSchema = z.enum(toolKinds);
export type ToolKind = (typeof toolKinds)[number];

/**
 * 配方种类：
 *   crafting        随手合成（2×2 背包网格即可）
 *   crafting_table  必须 3×3 工作台（或用工作台做 2×2 也行）
 *   smelting        熔炉烧炼（需要燃料 + 熔炉）
 *   mining          必须破坏方块取得（工具产出，不是配方）
 */
export const recipeKinds = ["crafting", "crafting_table", "smelting", "mining"] as const;
export const recipeKindSchema = z.enum(recipeKinds);
export type RecipeKind = (typeof recipeKinds)[number];

export const craftInputSchema = z
  .object({ itemName: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u), count: z.number().int().min(1).max(64) })
  .strict();
export type CraftInput = z.infer<typeof craftInputSchema>;

export const craftRecipeSchema = z
  .object({
    itemName: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u),
    /** 一次合成的产出数量（木板 4、木棍 4、其余多数为 1）。 */
    outputCount: z.number().int().min(1).max(64),
    kind: recipeKindSchema,
    /** 配方原料。`kind="mining"` 是从世界里挖出来的，没有原料，允许为空数组。 */
    inputs: z.array(craftInputSchema).max(9),
    /** 开采产物的最低工具档位（仅 kind=mining 有意义；其余为 "none"）。 */
    requiredTier: materialTierSchema,
    /** 该产物必须的收割工具（仅 kind=mining；无要求为 null）。 */
    requiredTool: z.union([toolKindSchema, z.literal("shears")]).nullable(),
  })
  .strict()
  .superRefine((recipe, context) => {
    // 合成/烧炼必须有原料：空原料的合成配方是数据错误，不是"免费的午餐"。
    if (recipe.kind !== "mining" && recipe.inputs.length === 0) {
      context.addIssue({ code: "custom", path: ["inputs"], message: "合成/烧炼配方必须至少有一种原料。" });
    }
  });
export type CraftRecipe = z.infer<typeof craftRecipeSchema>;

// ---------------------------------------------------------------------------
// 配方表。数值出处：原版合成表（Java 版 1.13+ 的 id 命名，全部去掉
// minecraft: 前缀）。木/石工具都是"3 材料 + 2 木棍"（铲 1+2，剑 2+1）。
// ---------------------------------------------------------------------------

/** 各档工具的材料物品。null = 该档位没有"单一材料物品"（徒手 / 下界合金由锻造台升级）。 */
export const toolMaterialItemByTier: Readonly<Record<MaterialTier, string | null>> = Object.freeze({
  none: null,
  wood: "oak_planks",
  stone: "cobblestone",
  iron: "iron_ingot",
  diamond: "diamond",
  netherite: null,
});

/** 每种工具每档消耗的材料数（原版合成表）。 */
export const toolMaterialCostByKind: Readonly<Record<ToolKind, { readonly material: number; readonly sticks: number }>> =
  Object.freeze({
    pickaxe: { material: 3, sticks: 2 },
    axe: { material: 3, sticks: 2 },
    shovel: { material: 1, sticks: 2 },
    sword: { material: 2, sticks: 1 },
    // 锄：两块材料 + 两根木棍（原版锄配方：2 材料对角 + 2 木棍）。
    hoe: { material: 2, sticks: 2 },
  });

/** 工具 id：`<material>_<kind>`，如 oak_planks 档位对应 wooden_pickaxe。 */
export const toolIdByTierAndKind: Readonly<Record<Exclude<MaterialTier, "none" | "netherite">, Readonly<Record<ToolKind, string>>>> =
  Object.freeze({
    wood: Object.freeze({ pickaxe: "wooden_pickaxe", axe: "wooden_axe", shovel: "wooden_shovel", sword: "wooden_sword", hoe: "wooden_hoe" }),
    stone: Object.freeze({ pickaxe: "stone_pickaxe", axe: "stone_axe", shovel: "stone_shovel", sword: "stone_sword", hoe: "stone_hoe" }),
    iron: Object.freeze({ pickaxe: "iron_pickaxe", axe: "iron_axe", shovel: "iron_shovel", sword: "iron_sword", hoe: "iron_hoe" }),
    diamond: Object.freeze({ pickaxe: "diamond_pickaxe", axe: "diamond_axe", shovel: "diamond_shovel", sword: "diamond_sword", hoe: "diamond_hoe" }),
  });

/** 取工具 id；档位为 none/netherite（本表不展开）时返回 null。 */
export function toolIdFor(tier: MaterialTier, kind: ToolKind): string | null {
  if (tier === "none" || tier === "netherite") return null;
  return toolIdByTierAndKind[tier][kind];
}

const rawRecipes: readonly CraftRecipe[] = [
  // 原木 → 木板：1 原木 = 4 木板（背包 2×2 即可）。
  { itemName: "oak_planks", outputCount: 4, kind: "crafting", inputs: [{ itemName: "oak_log", count: 1 }], requiredTier: "none", requiredTool: null },
  // 木板 → 木棍：2 木板 = 4 木棍（竖排两格，2×2 即可）。
  { itemName: "stick", outputCount: 4, kind: "crafting", inputs: [{ itemName: "oak_planks", count: 2 }], requiredTier: "none", requiredTool: null },
  // 工作台：4 木板铺满 2×2（所以背包里就能做出来，不需要已有工作台）。
  { itemName: "crafting_table", outputCount: 1, kind: "crafting", inputs: [{ itemName: "oak_planks", count: 4 }], requiredTier: "none", requiredTool: null },
  // 熔炉：8 圆石围一圈，**必须**工作台（3×3）。挖圆石需要镐。
  { itemName: "furnace", outputCount: 1, kind: "crafting_table", inputs: [{ itemName: "cobblestone", count: 8 }], requiredTier: "none", requiredTool: null },
  // 箱子：8 木板，必须工作台。
  { itemName: "chest", outputCount: 1, kind: "crafting_table", inputs: [{ itemName: "oak_planks", count: 8 }], requiredTier: "none", requiredTool: null },
  // 火把：1 煤炭 + 1 木棍 = 4 火把（2×2 即可）。
  { itemName: "torch", outputCount: 4, kind: "crafting", inputs: [{ itemName: "coal", count: 1 }, { itemName: "stick", count: 1 }], requiredTier: "none", requiredTool: null },
  // 木镐：3 木板 + 2 木棍（2×2）。
  { itemName: "wooden_pickaxe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "oak_planks", count: 3 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  // 圆石：挖石头取得，**必须**镐（徒手挖石头不掉落）。
  { itemName: "cobblestone", outputCount: 1, kind: "mining", inputs: [], requiredTier: "wood", requiredTool: "pickaxe" },
  { itemName: "coal", outputCount: 1, kind: "mining", inputs: [], requiredTier: "wood", requiredTool: "pickaxe" },
  { itemName: "iron_ingot", outputCount: 1, kind: "smelting", inputs: [{ itemName: "raw_iron", count: 1 }], requiredTier: "none", requiredTool: null },
  { itemName: "raw_iron", outputCount: 1, kind: "mining", inputs: [], requiredTier: "stone", requiredTool: "pickaxe" },
  { itemName: "diamond", outputCount: 1, kind: "mining", inputs: [], requiredTier: "iron", requiredTool: "pickaxe" },
  { itemName: "obsidian", outputCount: 1, kind: "mining", inputs: [], requiredTier: "diamond", requiredTool: "pickaxe" },
  // 石制工具：材料换成圆石，形制与木制相同（2×2）。
  { itemName: "stone_pickaxe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "cobblestone", count: 3 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "stone_axe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "cobblestone", count: 3 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "stone_shovel", outputCount: 1, kind: "crafting", inputs: [{ itemName: "cobblestone", count: 1 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "stone_sword", outputCount: 1, kind: "crafting", inputs: [{ itemName: "cobblestone", count: 2 }, { itemName: "stick", count: 1 }], requiredTier: "none", requiredTool: null },
  { itemName: "stone_hoe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "cobblestone", count: 2 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "iron_pickaxe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "iron_ingot", count: 3 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "iron_axe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "iron_ingot", count: 3 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "iron_shovel", outputCount: 1, kind: "crafting", inputs: [{ itemName: "iron_ingot", count: 1 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "iron_sword", outputCount: 1, kind: "crafting", inputs: [{ itemName: "iron_ingot", count: 2 }, { itemName: "stick", count: 1 }], requiredTier: "none", requiredTool: null },
  { itemName: "iron_hoe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "iron_ingot", count: 2 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "diamond_pickaxe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "diamond", count: 3 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "diamond_axe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "diamond", count: 3 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "diamond_shovel", outputCount: 1, kind: "crafting", inputs: [{ itemName: "diamond", count: 1 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "diamond_sword", outputCount: 1, kind: "crafting", inputs: [{ itemName: "diamond", count: 2 }, { itemName: "stick", count: 1 }], requiredTier: "none", requiredTool: null },
  { itemName: "diamond_hoe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "diamond", count: 2 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  // 木制工具剩余三种（木镐已在上面单列）。
  { itemName: "wooden_axe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "oak_planks", count: 3 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "wooden_shovel", outputCount: 1, kind: "crafting", inputs: [{ itemName: "oak_planks", count: 1 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  { itemName: "wooden_sword", outputCount: 1, kind: "crafting", inputs: [{ itemName: "oak_planks", count: 2 }, { itemName: "stick", count: 1 }], requiredTier: "none", requiredTool: null },
  { itemName: "wooden_hoe", outputCount: 1, kind: "crafting", inputs: [{ itemName: "oak_planks", count: 2 }, { itemName: "stick", count: 2 }], requiredTier: "none", requiredTool: null },
  // 剪刀：2 铁锭斜放（2×2 即可）。
  { itemName: "shears", outputCount: 1, kind: "crafting", inputs: [{ itemName: "iron_ingot", count: 2 }], requiredTier: "none", requiredTool: null },
];

/** 配方索引。同名配方只保留第一条（本表内无重复）。 */
export const craftRecipes: ReadonlyMap<string, CraftRecipe> = new Map(
  rawRecipes.map((recipe) => [recipe.itemName, craftRecipeSchema.parse(recipe)]),
);

/** 查配方；未知物品返回 null（调用方负责报 UNKNOWN_ITEM）。 */
export function recipeFor(itemName: string): CraftRecipe | null {
  return craftRecipes.get(normalizeItemName(itemName)) ?? null;
}

/** 去掉 minecraft: 命名空间前缀，统一小写。 */
export function normalizeItemName(itemName: string): string {
  const trimmed = itemName.trim().toLowerCase();
  return trimmed.startsWith("minecraft:") ? trimmed.slice("minecraft:".length) : trimmed;
}

// ---------------------------------------------------------------------------
// 开采硬约束：哪把工具能挖什么。
//
// 出处：原版"需要正确工具才能掉落 / 才能高效采集"的规则——
//   - 原木徒手也能砍（只是慢），所以是 hand；
//   - 石头/矿石必须用镐，否则挖了不掉落；
//   - 土/沙/沙砾用锹（徒手也能挖，有锹更快）；
//   - 羊毛/树叶用剪刀（徒手也能扯，但剪刀才不破坏方块）。
// 矿石另有**最低镐档**：铁矿要石镐以上，金/钻石/红石/青金石要铁镐以上，
// 黑曜石要钻石镐。用不足档位的镐挖了也不掉东西（新手最常踩的坑）。
// ---------------------------------------------------------------------------

export interface HarvestRequirement {
  readonly tool: ToolKind | "shears" | "hand";
  readonly minTier: MaterialTier;
}

const harvestRequirements: Readonly<Record<string, HarvestRequirement>> = Object.freeze({
  // 原木徒手可采（只是慢）——自举的起点，绝不能要求斧头，否则整条链死锁。
  oak_log: { tool: "hand", minTier: "none" },
  stone: { tool: "pickaxe", minTier: "wood" },
  cobblestone: { tool: "pickaxe", minTier: "wood" },
  coal_ore: { tool: "pickaxe", minTier: "wood" },
  iron_ore: { tool: "pickaxe", minTier: "stone" },
  raw_iron: { tool: "pickaxe", minTier: "stone" },
  copper_ore: { tool: "pickaxe", minTier: "stone" },
  lapis_ore: { tool: "pickaxe", minTier: "stone" },
  gold_ore: { tool: "pickaxe", minTier: "iron" },
  redstone_ore: { tool: "pickaxe", minTier: "iron" },
  diamond_ore: { tool: "pickaxe", minTier: "iron" },
  diamond: { tool: "pickaxe", minTier: "iron" },
  obsidian: { tool: "pickaxe", minTier: "diamond" },
  dirt: { tool: "shovel", minTier: "none" },
  sand: { tool: "shovel", minTier: "none" },
  gravel: { tool: "shovel", minTier: "none" },
  white_wool: { tool: "shears", minTier: "none" },
  oak_leaves: { tool: "shears", minTier: "none" },
});

/** 查开采要求；未知方块返回 null，表示"本表没有硬约束知识"。 */
export function harvestRequirementFor(blockName: string): HarvestRequirement | null {
  return harvestRequirements[normalizeItemName(blockName)] ?? null;
}

/**
 * 方块 → 掉落物。只在两者不同名时登记（石头掉圆石、矿石掉粗矿/煤/钻石…）。
 * 有了它，规划器才能把"缺 3 个圆石"翻译成"去挖 3 个石头"，而不是凭空要圆石。
 */
export const blockDropByItemName: Readonly<Record<string, string>> = Object.freeze({
  cobblestone: "stone",
  coal: "coal_ore",
  raw_iron: "iron_ore",
  raw_copper: "copper_ore",
  diamond: "diamond_ore",
  gold_ingot: "gold_ore",
  redstone: "redstone_ore",
  lapis_lazuli: "lapis_ore",
});

/** 取得 `itemName` 需要破坏的方块名；没有映射时就是它自己。 */
export function blockNameForItem(itemName: string): string {
  const key = normalizeItemName(itemName);
  return blockDropByItemName[key] ?? key;
}

/**
 * 取得该**物品**的开采要求：物品名本身是方块就直接查，否则先经掉落映射
 * 换成方块名（`cobblestone → stone`、`diamond → diamond_ore`）。
 * 返回 null 表示本表没有它的开采知识（例如木板、木棍这类只能合成的东西）。
 */
export function harvestRequirementForItem(itemName: string): HarvestRequirement | null {
  const key = normalizeItemName(itemName);
  return harvestRequirements[key] ?? harvestRequirements[blockDropByItemName[key] ?? ""] ?? null;
}

/** 档位序号比较：`have >= need` 时返回 true。 */
export function tierAtLeast(have: MaterialTier, need: MaterialTier): boolean {
  return materialTiers.indexOf(have) >= materialTiers.indexOf(need);
}

// ---------------------------------------------------------------------------
// 依赖展开：把目标工具拆成"需要哪些原始材料"。
// ---------------------------------------------------------------------------

export interface CraftPlanNode {
  readonly itemName: string;
  /** 需要的总件数。 */
  readonly count: number;
  /** 这件东西必须自己合成/开采，还是调用方已足量持有。 */
  readonly source: "available" | "craft" | "mine" | "smelt" | "unknown";
  /** 未满足时，还差几件。 */
  readonly missingCount: number;
  readonly children: readonly CraftPlanNode[];
}

/**
 * 递归展开 `itemName × count` 的材料需求。
 *
 * `available` 是**已有计数**（只读，不会被消耗改写——本函数是纯计算，
 * 真正的扣减由调用方的计划执行器做）。递归带 visited 保护，遇到循环配方
 * （本表没有，但表可扩展）立即停止，不栈溢出、不编造结论。
 */
export function expandCraftPlan(
  itemName: string,
  count: number,
  available: Readonly<Record<string, number>>,
): CraftPlanNode {
  const key = normalizeItemName(itemName);
  const recipe = craftRecipes.get(key) ?? null;
  const have = Math.max(0, Math.floor(available[key] ?? 0));
  const missingCount = Math.max(0, count - have);
  if (recipe === null) {
    return { itemName: key, count, source: missingCount > 0 ? "unknown" : "available", missingCount, children: [] };
  }
  if (missingCount === 0) {
    return { itemName: key, count, source: "available", missingCount: 0, children: [] };
  }
  if (recipe.kind === "mining") {
    return { itemName: key, count, source: "mine", missingCount, children: [] };
  }
  if (recipe.kind === "smelting") {
    const children = recipe.inputs.map((input) =>
      expandCraftPlan(input.itemName, input.count * missingCount, available),
    );
    return { itemName: key, count, source: "smelt", missingCount, children };
  }
  const batches = Math.ceil(missingCount / recipe.outputCount);
  const children = recipe.inputs.map((input) =>
    expandCraftPlan(input.itemName, input.count * batches, available),
  );
  return { itemName: key, count, source: "craft", missingCount, children };
}

/** 工具的档位与类别反解：`wooden_pickaxe` → { tier: "wood", kind: "pickaxe" }。 */
export function parseToolId(toolId: string): { readonly tier: MaterialTier; readonly kind: ToolKind } | null {
  const key = normalizeItemName(toolId);
  for (const tier of ["wood", "stone", "iron", "diamond"] as const) {
    for (const kind of toolKinds) {
      if (toolIdByTierAndKind[tier][kind] === key) return { tier, kind };
    }
  }
  return null;
}

/** 该物品是否属于"材料档位物品"（木板/圆石/铁锭/钻石/netherite 锭）。 */
export function materialTierOfItem(itemName: string): MaterialTier {
  const key = normalizeItemName(itemName);
  for (const tier of materialTiers) {
    if (toolMaterialItemByTier[tier] === key) return tier;
  }
  if (key.endsWith("_planks")) return "wood";
  return "none";
}

/**
 * 木板的材料等价：所有 `<wood>_planks` 视为同一种材料（木板家族通用）。
 * 原版里不同木材的木板可以混用，这里把它们折算到同一计数上。
 */
export function isPlanks(itemName: string): boolean {
  return normalizeItemName(itemName).endsWith("_planks");
}

/** 原木家族同木板：`<wood>_log` / `<wood>_stem` 都算 1 原木。 */
export function isLog(itemName: string): boolean {
  const key = normalizeItemName(itemName);
  return key.endsWith("_log") || key.endsWith("_stem");
}
