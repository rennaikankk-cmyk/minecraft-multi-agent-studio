import { z } from "zod";

// ---------------------------------------------------------------------------
// ResourceGraph —— 目标 → 资源依赖的知识库。
//
// 这一层存在的理由：不要为"拿到钻石装备""造一把铁镐"各写一条硬编码流程。
// 只描述**每种物品怎么来**（配方、产量、所需工具档位、所需工作站），让规划器
// 自己从目标倒推出整条链。加一种新物品 = 加一条数据，不改规划器。
//
// 三种边，语义刻意分开：
//   - `inputs`   消耗品。数量随批次线性放大，规划时必须真的备够。
//   - `toolTier` 工具档位要求。**不消耗**，"有一把就行"，所以不能当成 inputs
//               处理，否则会算出"挖 3 个石头要 3 把木镐"。
//   - `station`  工作站（工作台/熔炉）。同样不消耗，但需要在场且在交互距离内，
//               因此可能额外派生一个"放置"步骤。
//
// 数据范围：覆盖原版 1.21 从空手到钻石装备的完整链路。刻意不追求配方全集——
// 全集属于版本数据包，应由数据源注入；这里给出可用的最小闭包与扩展入口。
// ---------------------------------------------------------------------------

/** 工具档位。索引即强弱顺序，"至少 X 档"用索引比较。 */
export const toolTiers = ["none", "wooden", "stone", "iron", "diamond"] as const;

export type ToolTier = (typeof toolTiers)[number];

export function tierRank(tier: ToolTier): number {
  return toolTiers.indexOf(tier);
}

/** 目标档位是否被手上档位满足。 */
export function tierSatisfies(have: ToolTier, need: ToolTier): boolean {
  return tierRank(have) >= tierRank(need);
}

export const resourceStations = ["crafting_table", "furnace", "villager"] as const;

export type ResourceStation = (typeof resourceStations)[number];

/** 获取方式。决定规划器最终派发哪个 Skill。 */
export const acquisitionKinds = ["mine", "craft", "smelt", "trade"] as const;

export type AcquisitionKind = (typeof acquisitionKinds)[number];

const itemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);

export const resourceInputSchema = z
  .object({
    itemName: itemNameSchema,
    count: z.number().int().min(1).max(64),
  })
  .strict();

export type ResourceInput = z.infer<typeof resourceInputSchema>;

export const resourceRecipeSchema = z
  .object({
    /** 产出物品。 */
    itemName: itemNameSchema,
    kind: z.enum(acquisitionKinds),
    /** 执行一次产出多少个（如 1 原木 → 4 木板）。 */
    yield: z.number().int().min(1).max(64),
    /** 消耗品。 */
    inputs: z.array(resourceInputSchema).max(9),
    /** 需要的最低工具档位（不消耗）。 */
    toolTier: z.enum(toolTiers),
    /** 需要的工作站（不消耗），null 表示随身即可（2x2 合成等）。 */
    station: z.enum(resourceStations).nullable(),
    /** kind === "mine" 时要挖的方块名；其余为 null。 */
    sourceBlock: itemNameSchema.nullable(),
    /** 熔炼所需燃料的候选（任一即可），非 smelt 配方为空。 */
    fuelCandidates: z.array(itemNameSchema).max(4),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    if (recipe.kind === "mine" && recipe.sourceBlock === null) {
      ctx.addIssue({ code: "custom", message: "mine recipe needs sourceBlock" });
    }
    if (recipe.kind !== "mine" && recipe.sourceBlock !== null) {
      ctx.addIssue({ code: "custom", message: "only mine recipes take sourceBlock" });
    }
    if (recipe.kind === "smelt" && recipe.fuelCandidates.length === 0) {
      ctx.addIssue({ code: "custom", message: "smelt recipe needs fuel" });
    }
    if (recipe.kind !== "smelt" && recipe.fuelCandidates.length > 0) {
      ctx.addIssue({ code: "custom", message: "only smelt recipes take fuel" });
    }
    if (recipe.kind === "mine" && recipe.inputs.length > 0) {
      ctx.addIssue({ code: "custom", message: "mine recipes consume nothing" });
    }
  });

export type ResourceRecipe = z.infer<typeof resourceRecipeSchema>;

type RecipeDraft = Readonly<{
  itemName: string;
  kind: AcquisitionKind;
  yield?: number;
  inputs?: readonly ResourceInput[];
  toolTier?: ToolTier;
  station?: ResourceStation | null;
  sourceBlock?: string | null;
  fuelCandidates?: readonly string[];
}>;

/** 把简写补全成完整配方，避免表里堆满 null 与空数组。 */
function recipe(draft: RecipeDraft): ResourceRecipe {
  return resourceRecipeSchema.parse({
    itemName: draft.itemName,
    kind: draft.kind,
    yield: draft.yield ?? 1,
    inputs: draft.inputs ?? [],
    toolTier: draft.toolTier ?? "none",
    station: draft.station ?? null,
    sourceBlock: draft.sourceBlock ?? (draft.kind === "mine" ? draft.itemName : null),
    fuelCandidates: draft.fuelCandidates ?? (draft.kind === "smelt" ? ["coal"] : []),
  });
}

const need = (itemName: string, count: number): ResourceInput => ({ itemName, count });

/**
 * 原版 1.21 的最小闭包配方表：空手 → 钻石装备全链路可从这张表推出。
 * 每条都是纯数据，规划器不认识"钻石装备"这个概念。
 */
export const vanillaResourceRecipes: readonly ResourceRecipe[] = Object.freeze([
  // ---- 采集源（不消耗任何东西，只需要档位） ----
  recipe({ itemName: "oak_log", kind: "mine", sourceBlock: "oak_log" }),
  recipe({ itemName: "cobblestone", kind: "mine", sourceBlock: "stone", toolTier: "wooden" }),
  recipe({ itemName: "coal", kind: "mine", sourceBlock: "coal_ore", toolTier: "wooden" }),
  recipe({
    itemName: "raw_iron",
    kind: "mine",
    sourceBlock: "iron_ore",
    toolTier: "stone",
  }),
  recipe({
    itemName: "diamond",
    kind: "mine",
    sourceBlock: "diamond_ore",
    toolTier: "iron",
  }),

  // ---- 基础加工 ----
  recipe({ itemName: "oak_planks", kind: "craft", yield: 4, inputs: [need("oak_log", 1)] }),
  recipe({ itemName: "stick", kind: "craft", yield: 4, inputs: [need("oak_planks", 2)] }),
  recipe({
    itemName: "crafting_table",
    kind: "craft",
    inputs: [need("oak_planks", 4)],
  }),
  recipe({
    itemName: "furnace",
    kind: "craft",
    inputs: [need("cobblestone", 8)],
    station: "crafting_table",
  }),
  recipe({
    itemName: "iron_ingot",
    kind: "smelt",
    inputs: [need("raw_iron", 1)],
    station: "furnace",
    fuelCandidates: ["coal", "charcoal", "oak_planks"],
  }),

  // ---- 工具阶梯 ----
  recipe({
    itemName: "wooden_pickaxe",
    kind: "craft",
    inputs: [need("oak_planks", 3), need("stick", 2)],
    station: "crafting_table",
  }),
  recipe({
    itemName: "stone_pickaxe",
    kind: "craft",
    inputs: [need("cobblestone", 3), need("stick", 2)],
    station: "crafting_table",
  }),
  recipe({
    itemName: "iron_pickaxe",
    kind: "craft",
    inputs: [need("iron_ingot", 3), need("stick", 2)],
    station: "crafting_table",
  }),
  recipe({
    itemName: "diamond_pickaxe",
    kind: "craft",
    inputs: [need("diamond", 3), need("stick", 2)],
    station: "crafting_table",
  }),
  recipe({
    itemName: "diamond_sword",
    kind: "craft",
    inputs: [need("diamond", 2), need("stick", 1)],
    station: "crafting_table",
  }),

  // ---- 钻石护甲 ----
  recipe({
    itemName: "diamond_helmet",
    kind: "craft",
    inputs: [need("diamond", 5)],
    station: "crafting_table",
  }),
  recipe({
    itemName: "diamond_chestplate",
    kind: "craft",
    inputs: [need("diamond", 8)],
    station: "crafting_table",
  }),
  recipe({
    itemName: "diamond_leggings",
    kind: "craft",
    inputs: [need("diamond", 7)],
    station: "crafting_table",
  }),
  recipe({
    itemName: "diamond_boots",
    kind: "craft",
    inputs: [need("diamond", 4)],
    station: "crafting_table",
  }),
]);

/** 工具物品 → 它提供的档位。用于"手上这把镐算几档"。 */
export const toolTierByItem: Readonly<Record<string, ToolTier>> = Object.freeze({
  wooden_pickaxe: "wooden",
  stone_pickaxe: "stone",
  iron_pickaxe: "iron",
  diamond_pickaxe: "diamond",
});

/** 该档位最容易到手的镐（规划器派生"先做一把镐"时用）。 */
export const pickaxeForTier: Readonly<Record<ToolTier, string | null>> =
  Object.freeze({
    none: null,
    wooden: "wooden_pickaxe",
    stone: "stone_pickaxe",
    iron: "iron_pickaxe",
    diamond: "diamond_pickaxe",
  });

export type ResourceGraphIssue = Readonly<{
  itemName: string;
  code: "RESOURCE_RECIPE_DUPLICATE" | "RESOURCE_INPUT_UNKNOWN" | "RESOURCE_CYCLE";
}>;

/**
 * 配方索引。构造时做一致性自检：重复产出、未知输入、依赖成环都会被记为
 * issue，而不是等到规划时炸成一个难查的栈。
 */
export class ResourceGraph {
  private readonly byItem = new Map<string, ResourceRecipe>();
  private readonly issueList: ResourceGraphIssue[] = [];

  constructor(recipes: readonly ResourceRecipe[] = vanillaResourceRecipes) {
    for (const entry of recipes) {
      if (this.byItem.has(entry.itemName)) {
        this.issueList.push(
          Object.freeze({
            itemName: entry.itemName,
            code: "RESOURCE_RECIPE_DUPLICATE" as const,
          }),
        );
        continue;
      }
      this.byItem.set(entry.itemName, entry);
    }
    for (const entry of this.byItem.values()) {
      for (const input of entry.inputs) {
        if (!this.byItem.has(input.itemName)) {
          this.issueList.push(
            Object.freeze({
              itemName: input.itemName,
              code: "RESOURCE_INPUT_UNKNOWN" as const,
            }),
          );
        }
      }
    }
    for (const itemName of this.byItem.keys()) {
      if (this.hasCycleFrom(itemName)) {
        this.issueList.push(
          Object.freeze({ itemName, code: "RESOURCE_CYCLE" as const }),
        );
      }
    }
  }

  private hasCycleFrom(root: string): boolean {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const walk = (itemName: string): boolean => {
      if (visiting.has(itemName)) return true;
      if (done.has(itemName)) return false;
      visiting.add(itemName);
      for (const input of this.byItem.get(itemName)?.inputs ?? []) {
        if (walk(input.itemName)) return true;
      }
      visiting.delete(itemName);
      done.add(itemName);
      return false;
    };
    return walk(root);
  }

  /** 构造期自检发现的问题（排序，便于稳定断言）。 */
  get issues(): readonly ResourceGraphIssue[] {
    return Object.freeze(
      [...this.issueList].sort((left, right) =>
        left.itemName === right.itemName
          ? left.code.localeCompare(right.code)
          : left.itemName.localeCompare(right.itemName),
      ),
    );
  }

  recipeFor(itemName: string): ResourceRecipe | null {
    return this.byItem.get(itemName) ?? null;
  }

  knows(itemName: string): boolean {
    return this.byItem.has(itemName);
  }

  knownItemNames(): readonly string[] {
    return Object.freeze([...this.byItem.keys()].sort());
  }

  /**
   * 该物品所需的最低工具档位——含**传递**依赖。铁镐本身不要求档位，但它的
   * 铁锭链路一路回溯到铁矿需要石镐，所以答案是石。规划器靠这个决定要不要先
   * 插一段"升级镐子"的子任务。
   */
  requiredToolTier(itemName: string, seen: ReadonlySet<string> = new Set()): ToolTier {
    const entry = this.byItem.get(itemName);
    if (entry === undefined || seen.has(itemName)) return "none";
    const nextSeen = new Set(seen).add(itemName);
    let highest = entry.toolTier;
    for (const input of entry.inputs) {
      const inputTier = this.requiredToolTier(input.itemName, nextSeen);
      if (tierRank(inputTier) > tierRank(highest)) highest = inputTier;
    }
    return highest;
  }
}
