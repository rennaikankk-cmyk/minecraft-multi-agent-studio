import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import {
  blockNameForItem,
  craftRecipes,
  harvestRequirementForItem,
  materialTierSchema,
  normalizeItemName,
  parseToolId,
  toolIdFor,
  toolKinds,
  type CraftRecipe,
  type MaterialTier,
  type ToolKind,
} from "../commons/tools.js";
import { SkillFault } from "../errors.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// tool.plan —— 自举科技树的**计划**技能（纯函数）。
//
// 只规划，不合成、不挖掘：把"目标工具 + 手头材料 + 已知的采集来源"翻译成一条
// 有序合成链（原木→木板→木棍→木镐→圆石→石镐…），并如实报告还缺什么。
// 真正动手的是 craft.item / collect.block，本技能不声明任何 capability。
//
// 有序性是核心价值：配方本身没有顺序，但**依赖**有——没有镐就采不到圆石，
// 没有工作台就做不了熔炉。石镐之前的每一件工具都恰好落在背包 2×2 网格里，
// 所以"要不要先做工作台"由 planRequiresCraftingTable 如实回答，而不是猜。
//
// 记账规则只有一条（整个文件的正确性都挂在它上面）：
//   craft/采集 n 件 → 先吃掉手头的，不够的才新做/新采，产出减去本次需求剩下的
//   记回 available 供后续步骤复用。少了"复用余量"，1 原木做木镐会被算成砍 2 棵树。
//
// 可行性是硬约束：一步只有在**它自己和它的全部前置**都能满足时才进计划。
// 拿不出工作台就不会出现"用工作台合成熔炉"这种自相矛盾的步骤，
// 而是把 crafting_table 记进 missingMaterials。
// ---------------------------------------------------------------------------

export const TOOL_PLAN_TIMEOUT_MS = 2_000;
/** 计划步数上限：正常自举（木/石/铁/钻石镐）不超过 20 步，留足余量又不至于失控。 */
export const TOOL_PLAN_MAX_STEPS = 256;

const itemNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u);
const consumeSchema = z.object({ itemName: itemNameSchema, count: z.number().int().min(1).max(4_096) }).strict();

export const toolPlanStepSchema = z
  .object({
    order: z.number().int().min(1).max(TOOL_PLAN_MAX_STEPS),
    action: z.enum(["craft", "mine", "smelt"]),
    itemName: itemNameSchema,
    /** 合成次数（2×2）；采集/烧炼步这里等于件数。 */
    batches: z.number().int().min(1).max(TOOL_PLAN_MAX_STEPS),
    /** 该步的总产出件数。 */
    outputCount: z.number().int().min(1).max(4_096),
    consumes: z.array(consumeSchema).max(9),
    /** 该步是否必须在工作台（3×3）上完成。 */
    needsCraftingTable: z.boolean(),
    /** mine/smelt 步：必须先持有这套工具，否则这一步做不成。 */
    requiredTool: z.union([z.enum(toolKinds), z.literal("shears")]).nullable(),
    requiredTier: materialTierSchema,
    note: z.string().min(1).max(256),
  })
  .strict();
export type ToolPlanStep = z.infer<typeof toolPlanStepSchema>;

export const toolPlanInputSchema = z
  .object({
    goalTool: itemNameSchema,
    count: z.number().int().min(1).max(64),
    /** 手头材料/成品的现有计数。 */
    available: z
      .array(z.object({ itemName: itemNameSchema, count: z.number().int().min(0).max(4_096) }).strict())
      .max(256),
    /**
     * 已知可以直接采集到的原料（附近有树 → "oak_log"；脚下就是石头 → "stone"）。
     * 缺省表示"没有已知来源"，此时这些原料会被如实记进 missingMaterials。
     */
    harvestable: z.array(itemNameSchema).max(64).optional(),
    /** 已经持有的工具 id；缺省时从 available 里反解。 */
    tools: z.array(itemNameSchema).max(64).optional(),
    /** 是否已有工作台可用（放在手边/附近）。 */
    craftingTableAvailable: z.boolean().optional(),
    serverProfileId: identifierSchema,
  })
  .strict();
export type ToolPlanInput = z.infer<typeof toolPlanInputSchema>;

const missingSchema = z
  .object({
    itemName: itemNameSchema,
    missingCount: z.number().int().min(1).max(4_096),
    /** 为什么拿不到：没有已知来源、没有对应工具、还是受工作台限制。 */
    reason: z.enum(["NO_SOURCE", "NO_TOOL", "NEEDS_CRAFTING_TABLE"]),
  })
  .strict();

export const toolPlanOutputSchema = z
  .object({
    verdict: z.enum(["PLAN_READY", "NEEDS_CRAFTING_TABLE", "MISSING_MATERIALS"]),
    goalTool: itemNameSchema,
    goalCount: z.number().int().min(1).max(64),
    /** 整条链是否必须用到工作台（3×3）。 */
    planRequiresCraftingTable: z.boolean(),
    /** 调用方已确认有工作台时为 true——那么"做工作台"这一步就是多余的。 */
    craftingTableAlreadyHeld: z.boolean(),
    steps: z.array(toolPlanStepSchema).max(TOOL_PLAN_MAX_STEPS),
    missingMaterials: z.array(missingSchema).max(256),
    /** 计划执行完之后的预计库存（初始 + 产出 − 消耗）。 */
    remainingAfterPlan: z.array(z.object({ itemName: itemNameSchema, count: z.number().int().min(0).max(4_096) }).strict()).max(256),
  })
  .strict();
export type ToolPlanOutput = z.infer<typeof toolPlanOutputSchema>;

export const toolPlanStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
  })
  .strip();
export type ToolPlanState = z.infer<typeof toolPlanStateSchema>;

const tierOrder: readonly MaterialTier[] = ["none", "wood", "stone", "iron", "diamond", "netherite"];

/** 目标档位 → 需要的最低镐档位（把"缺什么"说清楚用）。 */
export function minimumPickaxeTierFor(tier: MaterialTier): MaterialTier {
  switch (tier) {
    case "diamond":
      return "iron";
    case "iron":
      return "stone";
    case "stone":
      return "wood";
    default:
      return "none";
  }
}

/** 从 available/tools 里反解已持有的工具 id 集合。 */
export function knownTools(input: ToolPlanInput): ReadonlySet<string> {
  const tools = new Set<string>();
  for (const toolId of input.tools ?? []) tools.add(normalizeItemName(toolId));
  for (const entry of input.available) {
    if (parseToolId(entry.itemName) !== null) tools.add(normalizeItemName(entry.itemName));
  }
  return tools;
}

/** 是否持有满足 (类别, 最低档位) 的工具。shears 单独处理（不是四档工具）。 */
export function hasToolAtTier(tools: ReadonlySet<string>, kind: ToolKind | "shears", minTier: MaterialTier): boolean {
  if (kind === "shears") return tools.has("shears");
  // 最低档位是 "none" 意味着徒手也能干（砍原木就是）：恒为真。
  // 少了这一条，自举第一步就会因为"没有斧头"判死——本技能的第一版就踩过。
  if (minTier === "none") return true;
  for (const toolId of tools) {
    const parsed = parseToolId(toolId);
    if (parsed === null || parsed.kind !== kind) continue;
    if (tierOrder.indexOf(parsed.tier) >= tierOrder.indexOf(minTier)) return true;
  }
  return false;
}

/**
 * 本表里"只能合成出来"的物品（出现在某个配方的原料位）。
 * 目前只用于文档与自检；缺口清单按"根因"上报，不再按它过滤。
 */
const craftOnlyItems: ReadonlySet<string> = new Set(
  [...craftRecipes.values()].flatMap((recipe) => recipe.inputs.map((input) => normalizeItemName(input.itemName))),
);

function harvestNoteFor(itemName: string, count: number): string {
  const harvest = harvestRequirementForItem(itemName);
  const blockName = blockNameForItem(itemName);
  const from = blockName === itemName ? "" : `（挖 ${blockName}）`;
  return harvest === null
    ? `采集 ${count} 个 ${itemName}${from}：常识表没有它的开采硬约束。`
    : `采集 ${count} 个 ${itemName}${from}：需要 ${harvest.tool}，最低档位 ${harvest.minTier}。`;
}

/**
 * 缺口原因。两种缺口的**性质完全不同**，混为一谈会把"还没有铁镐"说成"没有铁矿"：
 *   - NO_SOURCE：本表既没有配方、也没有已知采集来源 —— 硬缺口，计划到此为止。
 *   - NO_TOOL：来源是有的，只是眼下这级工具还做不出来 —— 软缺口，计划继续往下排，
 *     由调用方决定"先补齐前置还是换个目标"。
 *   - NEEDS_CRAFTING_TABLE：3×3 配方缺工作台，同属软缺口。
 */
type MissingReason = "NO_SOURCE" | "NO_TOOL" | "NEEDS_CRAFTING_TABLE";

/** 软缺口的表现：值得上报，但不代表整条链无解。 */
function isSoftReason(reason: MissingReason): boolean {
  return reason !== "NO_SOURCE";
}

/**
 * 一次需求解析的结果。**契约**：
 *   - `ok` 为 true 时，`available[itemName]` 已经包含了"多出来的余量"；
 *   - `ok` 为 false 时，**本次调用没有消费任何东西**（手头那份原封不动退回去），
 *     这样父层可以直接判整条链不可行，不会留下"合成到一半"的假账。
 *   - `blockedBy` 说明卡在哪件物品上，父层据此把根因往上写。
 */
interface NeedResult {
  readonly ok: boolean;
  readonly blockedBy: string | null;
  /** blockedBy 那一件**自己**缺多少（父层的批量会把它放大，所以必须由子层给出）。 */
  readonly blockedCount: number;
  /** 缺口性质：NO_SOURCE 是硬缺口（整条链无解），NO_TOOL/NEEDS_CRAFTING_TABLE 是软缺口。 */
  readonly blockedReason: MissingReason;
}

const OK: NeedResult = { ok: true, blockedBy: null, blockedCount: 0, blockedReason: "NO_SOURCE" };

function fail(blockedBy: string, blockedCount: number, blockedReason: MissingReason): NeedResult {
  return { ok: false, blockedBy, blockedCount, blockedReason };
}

interface Planner {
  readonly available: Map<string, number>;
  readonly produced: Map<string, number>;
  readonly steps: ToolPlanStep[];
  readonly missing: Map<string, { missingCount: number; reason: MissingReason }>;
  readonly harvestable: ReadonlySet<string>;
  /** 合成链里已确定的工具（含本次计划将做出来的），供后续 mine 步判断工具是否够档。 */
  readonly tools: Set<string>;
  /** 递归栈：环状配方（本表没有，但表可扩展）当场判不可行，而不是靠步数上限兜。 */
  readonly visiting: Set<string>;
  /** 是否出现过硬缺口。软件缺口（NO_TOOL）不算——"还没有铁镐"不等于"没有铁矿"。 */
  hardBlocked: boolean;
}

function recordMissing(planner: Planner, itemName: string, count: number, reason: MissingReason): void {
  if (!isSoftReason(reason)) planner.hardBlocked = true;
  const existing = planner.missing.get(itemName);
  planner.missing.set(itemName, {
    missingCount: Math.max(existing?.missingCount ?? 0, count),
    // 硬缺口（NO_SOURCE）优先于软缺口：说"没有来源"比说"工具不够"更根本。
    reason: existing !== undefined && !isSoftReason(existing.reason) ? existing.reason : reason,
  });
}

function pushStep(
  planner: Planner,
  recipe: CraftRecipe,
  itemName: string,
  batches: number,
  outputCount: number,
  note: string,
): void {
  planner.steps.push(
    toolPlanStepSchema.parse({
      order: planner.steps.length + 1,
      action: recipe.kind === "mining" ? "mine" : recipe.kind === "smelting" ? "smelt" : "craft",
      itemName,
      batches,
      outputCount,
      consumes: recipe.inputs.map((entry) => ({ itemName: entry.itemName, count: entry.count * batches })),
      needsCraftingTable: recipe.kind === "crafting_table",
      requiredTool: recipe.requiredTool,
      requiredTier: recipe.requiredTier,
      note,
    }),
  );
}

/**
 * 解析"还差 `needed` 个 `itemName`"。
 *
 * 唯一的记账规则在这里：
 *   craft/采集 n 件 → 先吃掉手头的 have，不够的才新做/新采（deficit），
 *   产出减去本次需求剩下的记回 available 供后续步骤复用。
 */
function resolveNeed(planner: Planner, rawItemName: string, needed: number): NeedResult {
  if (needed <= 0) return OK;
  const itemName = normalizeItemName(rawItemName);
  if (planner.steps.length >= TOOL_PLAN_MAX_STEPS) {
    recordMissing(planner, itemName, needed, "NO_SOURCE");
    return fail(itemName, needed, "NO_SOURCE");
  }
  const have = planner.available.get(itemName) ?? 0;
  if (have >= needed) {
    planner.available.set(itemName, have - needed);
    return OK;
  }
  const deficit = needed - have;
  /**
   * 记账规则（整个文件的正确性都挂在这里）：
   *   先把这件物品**预留下来**（从池子里拿走 have），再递归解析原料，
   *   最后把"产出 - 本次需求"的余量连同上一步预留下的 have 一起放回池子。
   *
   * 为什么必须预留：不预留的话，`stick` 需要 2 块木板时会看不到木镐已经留下的
   * 那 1 块，于是为了补 1 块的差额再搓一整批 4 块——实测表现就是"1 原木做木镐"
   * 被排成砍 2 棵树、搓 2 批木板。
   *
   * 失败时必须把 have **原样退回**：本函数的契约是失败路径不消费任何东西，
   * 否则父层判定整条链不可行之后，池子里会留下一个假的"已经被吃掉了"。
   */
  planner.available.set(itemName, 0);
  const restoreOnFailure = (): void => {
    planner.available.set(itemName, (planner.available.get(itemName) ?? 0) + have);
  };

  // 1) 已知可以直接采集：不需要配方（原木、圆石、矿石都走这条）。
  if (planner.harvestable.has(itemName)) {
    const harvest = harvestRequirementForItem(itemName);
    // 本表没有该物品的开采知识时不假装有硬约束：如实给出无约束的采集步。
    if (harvest !== null && !hasToolAtTier(planner.tools, harvest.tool === "hand" ? "pickaxe" : harvest.tool, harvest.minTier)) {
      recordMissing(planner, itemName, deficit, "NO_TOOL");
      restoreOnFailure();
      return fail(itemName, deficit, "NO_TOOL");
    }
    pushStep(planner, harvestRecipe(itemName), itemName, deficit, deficit, harvestNoteFor(itemName, deficit));
    planner.produced.set(itemName, (planner.produced.get(itemName) ?? 0) + deficit);
    return OK;
  }

  // 2) 查配方。
  const recipe = craftRecipes.get(itemName);
  if (recipe === undefined) {
    // 没有配方、也没有已知来源 —— 这是**硬缺口**。
    recordMissing(planner, itemName, deficit, "NO_SOURCE");
    restoreOnFailure();
    return fail(itemName, deficit, "NO_SOURCE");
  }
  if (planner.visiting.has(itemName)) {
    recordMissing(planner, itemName, deficit, "NO_SOURCE");
    restoreOnFailure();
    return fail(itemName, deficit, "NO_SOURCE");
  }
  planner.visiting.add(itemName);
  try {
    // 2a) 3×3 配方先确保工作台本身可行（工作台会排在这一步之前）。
    if (recipe.kind === "crafting_table") {
      const table = resolveNeed(planner, "crafting_table", 1);
      if (!table.ok) {
        // 工作台做不出来只说明"缺前置"，性质由前置自己决定（可能是缺木板=硬缺口）。
        recordMissing(planner, table.blockedBy ?? "crafting_table", table.blockedCount, table.blockedReason);
        restoreOnFailure();
        return fail(table.blockedBy ?? "crafting_table", table.blockedCount, table.blockedReason);
      }
    }
    // 2b) 采集步：先确保对应工具可行（工具会排在这一步之前）。
    //     件数按 deficit 算，不按批次数——只有合成才有"批"的概念。
    if (recipe.kind === "mining") {
      const tool = recipe.requiredTool;
      if (tool !== null && !hasToolAtTier(planner.tools, tool, recipe.requiredTier)) {
        // 试着把工具做出来（它会排在这一步之前）。做不出来时分两种情形：
        //   - 这件物品**自己**在已知来源里（例如"脚下就是圆石"）→ 缺的是工具，NO_TOOL（软）；
        //   - 否则来源本身就没落到清单里（例如"铁矿不知道在哪"）→ NO_SOURCE（硬）。
        // 混为一谈会把"还没有铁镐"报成"没有铁矿"，本技能的第一版就是这么错的。
        const toolId =
          tool === "shears"
            ? "shears"
            : toolIdFor(recipe.requiredTier === "none" ? "wood" : recipe.requiredTier, tool);
        const toolNeed = toolId === null ? fail(itemName, deficit, "NO_TOOL") : resolveNeed(planner, toolId, 1);
        if (!toolNeed.ok) {
          const reason: MissingReason = planner.harvestable.has(itemName) ? "NO_TOOL" : "NO_SOURCE";
          recordMissing(planner, itemName, deficit, reason);
          restoreOnFailure();
          return fail(itemName, deficit, reason);
        }
      }
      pushStep(planner, recipe, itemName, deficit, deficit, harvestNoteFor(itemName, deficit));
      planner.produced.set(itemName, (planner.produced.get(itemName) ?? 0) + deficit);
      return OK;
    }
    // 2c) 合成/烧炼：先解析原料，全绿才落这一步（失败时一个字节都不改）。
    const isCraft = recipe.kind === "crafting";
    const batches = isCraft ? Math.ceil(deficit / recipe.outputCount) : deficit;
    const produced = isCraft ? batches * recipe.outputCount : deficit;
    for (const entry of recipe.inputs) {
      const child = resolveNeed(planner, entry.itemName, entry.count * batches);
      if (!child.ok) {
        const blocker = child.blockedBy ?? entry.itemName;
        // 缺口数量用**子层自己**的差量，不用父层的批量：木镐要 3 板不代表要 3 根原木。
        recordMissing(planner, blocker, child.blockedCount, child.blockedReason);
        restoreOnFailure();
        return fail(blocker, child.blockedCount, child.blockedReason);
      }
    }
    pushStep(
      planner,
      recipe,
      itemName,
      isCraft ? batches : deficit,
      produced,
      recipe.kind === "smelting"
        ? `烧炼 ${deficit} 次（需要燃料与熔炉）。`
        : `合成 ${batches} 批（2×2 背包网格即可）。`,
    );
    if (parseToolId(itemName) !== null || itemName === "shears") planner.tools.add(itemName);
    planner.produced.set(itemName, (planner.produced.get(itemName) ?? 0) + produced);
    // 预算被预留的 have 归还，再加上本次多余出来的部分。
    planner.available.set(itemName, have + produced - needed);
    return OK;
  } finally {
    planner.visiting.delete(itemName);
  }
}

/**
 * 采集步用的匿名配方：不进 craftRecipes（那会污染配方表），只用来把"直接采集"
 * 也表达成同一种 step 形状。开采约束取自**方块**（圆石要挖石头、钻石要挖钻石矿）。
 */
function harvestRecipe(itemName: string): CraftRecipe {
  const harvest = harvestRequirementForItem(itemName);
  return {
    itemName,
    outputCount: 1,
    kind: "mining",
    inputs: [],
    requiredTier: harvest?.minTier ?? "none",
    requiredTool: harvest === null || harvest.tool === "hand" ? null : harvest.tool,
  };
}

export const toolPlanSkill = defineSkill({
  id: "tool.plan",
  version: "1.0.0",
  progressContract: "WAITING_EXTERNAL",
  inputSchema: toolPlanInputSchema,
  outputSchema: toolPlanOutputSchema,
  stateSchema: toolPlanStateSchema,
  compatibility: {
    variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }],
  },
  // 纯规划：不合成、不挖掘、不读世界（与 stock.levels / movement.profile 同类）。
  requiredCapabilities: [] as const,
  timeoutMs: TOOL_PLAN_TIMEOUT_MS,
  idempotent: true,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    {
      id: "l0.normal-actions-allowed",
      failureCode: "NORMAL_ACTIONS_PAUSED",
      check: (_input, state) => state.normalActionsAllowed,
    },
    {
      id: "target.server-profile-matches",
      failureCode: "TARGET_SERVER_PROFILE_MISMATCH",
      check: (input, state) => input.serverProfileId === state.serverProfileId,
    },
    {
      id: "tool.goal-known",
      // 复用已分类的码（recovery/failure-classifier.ts: PLAN_ITEM_UNOBTAINABLE → UNSUPPORTED）：
      // 常识表里没有这件物品的配方/工具定义，属于"目标本身不支持"，不是可重试的故障，
      // 也不是合同 bug。**不新造码**——扫描器会把新码自动纳入断言，而分类表不归本文件管。
      failureCode: "PLAN_ITEM_UNOBTAINABLE",
      check: (input) =>
        craftRecipes.has(normalizeItemName(input.goalTool)) || parseToolId(input.goalTool) !== null,
    },
  ],
  execute: async (_context, input) => {
    const goalTool = normalizeItemName(input.goalTool);
    if (!craftRecipes.has(goalTool) && parseToolId(goalTool) === null) {
      throw new SkillFault("PLAN_ITEM_UNOBTAINABLE", `常识表里没有 ${goalTool} 的配方或工具定义。`);
    }
    const available = new Map<string, number>();
    for (const entry of input.available) {
      const key = normalizeItemName(entry.itemName);
      available.set(key, (available.get(key) ?? 0) + entry.count);
    }
    const craftingTableAlreadyHeld =
      input.craftingTableAvailable === true || (available.get("crafting_table") ?? 0) > 0;
    if (craftingTableAlreadyHeld) {
      // 工作台在手边等价于"已经拥有"：把它算进库存，省掉一次多余合成。
      available.set("crafting_table", Math.max(1, available.get("crafting_table") ?? 0));
    }
    const planner: Planner = {
      available,
      produced: new Map(),
      steps: [],
      missing: new Map(),
      harvestable: new Set((input.harvestable ?? []).map(normalizeItemName)),
      tools: new Set(knownTools(input)),
      visiting: new Set(),
      hardBlocked: false,
    };
    resolveNeed(planner, goalTool, input.count);

    // 只报**根因**缺口：父层失败时记录的是 child.blockedBy（真正的堵点），
    // 所以这里不需要再按"中间产物"过滤——过滤反而会把原木这类真根因一起滤掉
    // （本技能的第一版就踩过：原木被当成"只能合成的中间产物"，缺口清单变空）。
    const missingMaterials = [...planner.missing.entries()]
      .map(([itemName, entry]) => ({ itemName, missingCount: entry.missingCount, reason: entry.reason }))
      .sort((left, right) => left.itemName.localeCompare(right.itemName));
    const planRequiresCraftingTable = planner.steps.some((step) => step.needsCraftingTable);
    // 只有**硬缺口**（没有来源）才把整个计划判为不可行。软缺口（工具档位还不够、
    // 工作台还没做）照常给计划：靠挖矿步骤自身携带的 requiredTool/requiredTier
    // 把"这一步得先有那把镐"说清楚，由调用方决定补前置还是换目标。
    const craftingTableRequiredButMissing =
      planRequiresCraftingTable && !craftingTableAlreadyHeld && missingMaterials.length === 0;
    const remainingAfterPlan = [...planner.available.entries()]
      .filter(([, count]) => count > 0)
      .map(([itemName, count]) => ({ itemName, count }))
      .sort((left, right) => left.itemName.localeCompare(right.itemName));
    return toolPlanOutputSchema.parse({
      verdict: planner.hardBlocked
        ? "MISSING_MATERIALS"
        : craftingTableRequiredButMissing
          ? "NEEDS_CRAFTING_TABLE"
          : "PLAN_READY",
      goalTool,
      goalCount: input.count,
      planRequiresCraftingTable,
      craftingTableAlreadyHeld,
      steps: planner.steps,
      missingMaterials,
      remainingAfterPlan,
    });
  },
});
