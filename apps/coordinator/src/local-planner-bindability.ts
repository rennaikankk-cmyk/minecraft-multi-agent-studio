/**
 * Local planner 的放置/可绑定纯规则域与目标别名表（从 local-planner.ts
 * 拆出，2026-09-10 结构拆分批次 4）。执行与状态机仍归 CoordinatorLocalPlanner。
 */
import type { PlanStep } from "@minecraft-studio/skills";

export const COORDINATOR_COLLECT_MAX_DISTANCE = 64;
export const REOBSERVE_TIMEOUT_MS = 5_000;
export const NON_IDEMPOTENT_RESULT_UNCERTAIN = "NON_IDEMPOTENT_RESULT_UNCERTAIN";

/** The one face a scanned ground block can be built on without further observation. */
export const COORDINATOR_PLACEMENT_FACE = Object.freeze({ x: 0, y: 1, z: 0 });
/** Stations the coordinator can place after observing a trusted ground block. */
export const COORDINATOR_PLACEABLE_STATIONS: ReadonlySet<string> = new Set([
  "crafting_table",
  "furnace",
]);
/** Both are needed for any placement: one to observe the site, one to build on it. */
export const COORDINATOR_PLACEMENT_SKILLS = Object.freeze([
  "world.scan",
  "world.place-block",
]);
/**
 * Ground blocks worth scanning for a placement reference. Every one is solid by
 * name, so whichever the scan actually returns is an observed fact rather than
 * an assumption about what the bot happens to be standing on.
 */
export const COORDINATOR_PLACEMENT_GROUND_BLOCKS = Object.freeze([
  "grass_block",
  "dirt",
  "stone",
  "cobblestone",
  "sand",
  "gravel",
  "coarse_dirt",
  "podzol",
]);
export const COORDINATOR_PLACEMENT_SCAN_MAX_COUNT = 16;
export const COORDINATOR_PLACEMENT_SCAN_MAX_DISTANCE = 6;
export const COORDINATOR_PLACEMENT_OPEN_BLOCK = "air";
/**
 * A reference must be far enough not to be the block under the bot's own feet
 * and near enough to stay inside placement reach. Outside this window the
 * coordinator reports no site rather than dispatching a placement the Runtime
 * would refuse.
 */
export const COORDINATOR_PLACEMENT_MIN_DISTANCE = 2;
// The Runtime defaults unknown servers to STRICT (3.8 block reach). The scan
// distance is measured to the reference block corner while crafting checks the
// placed station center one block higher, so 3.0 keeps the resulting station in
// reach instead of merely keeping its supporting block in reach.
export const COORDINATOR_PLACEMENT_MAX_DISTANCE = 3.0;

export type PlacementPosition = Readonly<{ x: number; y: number; z: number }>;

/**
 * Why a plan step cannot be bound, or null when it can.
 *
 * The single rule shared by the advertised-item report and the pre-dispatch
 * execution gate. Two copies of it drifted once already: a unit test observed
 * `SKILL_NOT_ADVERTISED:world.place-block` while production observed
 * `STEP_KIND_UNSUPPORTED:place-station` for the same goal, because each caller
 * decided in its own order which gate to check first.
 */
export function unbindableStepReason(
  step: PlanStep,
  advertised: ReadonlySet<string>,
): string | null {
  if (!advertised.has(step.skillId)) {
    return `SKILL_NOT_ADVERTISED:${step.skillId}`;
  }
  if (step.kind === "mine") return null;
  if (step.kind === "craft") {
    if (step.station === null) return null;
    return COORDINATOR_PLACEABLE_STATIONS.has(step.station)
      ? placementSupportReason(advertised)
      : `STATION_UNSUPPORTED:${step.station}`;
  }
  if (step.kind === "smelt") {
    if (step.station === null) return "STATION_UNSUPPORTED:furnace";
    return COORDINATOR_PLACEABLE_STATIONS.has(step.station)
      ? placementSupportReason(advertised)
      : `STATION_UNSUPPORTED:${step.station}`;
  }
  if (step.kind === "place-station") {
    return COORDINATOR_PLACEABLE_STATIONS.has(step.itemName)
      ? placementSupportReason(advertised)
      : `STATION_UNSUPPORTED:${step.itemName}`;
  }
  return `STEP_KIND_UNSUPPORTED:${step.kind}`;
}

export function placementSupportReason(advertised: ReadonlySet<string>): string | null {
  for (const skillId of COORDINATOR_PLACEMENT_SKILLS) {
    if (!advertised.has(skillId)) return `SKILL_NOT_ADVERTISED:${skillId}`;
  }
  return null;
}
/**
 * 中文与自然英文说法 → 计划物品名。**只影响"这条目标提到了哪个物品"的判定**，
 * 不放宽任何检查：候选永远来自确定性 GoalPlanner 已证明可达的集合，
 * 命中之后仍要过 assertPlanGoalsGrounded。
 *
 * 覆盖面必须跟上 ResourceGraph。此前只登记了四个物品，于是"做一个熔炉"这类
 * 目标在规划器明明推得出链条时仍然被判成"没提到任何可达物品"而降级 noop——
 * 缺的不是能力，是这张表。下面的 `plannedItemGoalAliasCoverage` 把它变成测试。
 */
export const PLANNED_ITEM_GOAL_ALIASES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    oak_log: Object.freeze(["oak log", "oak_log", "橡木原木", "原木", "木头"]),
    birch_log: Object.freeze(["birch log", "birch_log", "白桦原木"]),
    spruce_log: Object.freeze(["spruce log", "spruce_log", "云杉原木"]),
    jungle_log: Object.freeze(["jungle log", "jungle_log", "丛林原木"]),
    acacia_log: Object.freeze(["acacia log", "acacia_log", "金合欢原木"]),
    dark_oak_log: Object.freeze(["dark oak log", "dark_oak_log", "深色橡木原木"]),
    mangrove_log: Object.freeze(["mangrove log", "mangrove_log", "红树林原木"]),
    cherry_log: Object.freeze(["cherry log", "cherry_log", "樱花原木"]),
    dirt: Object.freeze(["dirt", "泥土"]),
    oak_planks: Object.freeze([
      "oak planks",
      "oak_planks",
      "橡木木板",
      "木板",
    ]),
    birch_planks: Object.freeze(["birch_planks", "birch planks", "白桦木板"]),
    spruce_planks: Object.freeze(["spruce_planks", "spruce planks", "云杉木板"]),
    jungle_planks: Object.freeze(["jungle_planks", "jungle planks", "丛林木板"]),
    acacia_planks: Object.freeze(["acacia_planks", "acacia planks", "金合欢木板"]),
    dark_oak_planks: Object.freeze(["dark_oak_planks", "dark oak planks", "深色橡木木板"]),
    mangrove_planks: Object.freeze(["mangrove_planks", "mangrove planks", "红树林木板"]),
    cherry_planks: Object.freeze(["cherry_planks", "cherry planks", "樱花木板"]),
    stick: Object.freeze(["stick", "sticks", "木棍", "木棒"]),
    crafting_table: Object.freeze([
      "crafting table",
      "crafting_table",
      "工作台",
      "合成台",
    ]),
    cobblestone: Object.freeze(["cobblestone", "圆石", "鹅卵石"]),
    coal: Object.freeze(["coal", "煤炭", "煤"]),
    raw_iron: Object.freeze(["raw iron", "raw_iron", "粗铁", "铁矿石"]),
    iron_ingot: Object.freeze(["iron ingot", "iron_ingot", "铁锭"]),
    diamond: Object.freeze(["diamond", "diamonds", "钻石"]),
    furnace: Object.freeze(["furnace", "熔炉", "炉子"]),
    white_wool: Object.freeze(["white wool", "white_wool", "白羊毛", "羊毛"]),
    bed: Object.freeze(["bed", "床"]),
    wooden_pickaxe: Object.freeze([
      "wooden pickaxe",
      "wooden_pickaxe",
      "木镐",
      "木制镐",
    ]),
    stone_pickaxe: Object.freeze([
      "stone pickaxe",
      "stone_pickaxe",
      "石镐",
      "石制镐",
    ]),
    iron_pickaxe: Object.freeze([
      "iron pickaxe",
      "iron_pickaxe",
      "铁镐",
      "铁制镐",
    ]),
    diamond_pickaxe: Object.freeze([
      "diamond pickaxe",
      "diamond_pickaxe",
      "钻石镐",
    ]),
    diamond_axe: Object.freeze(["diamond axe", "diamond_axe", "钻石斧"]),
    diamond_shovel: Object.freeze(["diamond shovel", "diamond_shovel", "钻石铲"]),
    diamond_hoe: Object.freeze(["diamond hoe", "diamond_hoe", "钻石锄"]),
    obsidian: Object.freeze(["obsidian", "黑曜石"]),
    diamond_sword: Object.freeze([
      "diamond sword",
      "diamond_sword",
      "钻石剑",
    ]),
    diamond_helmet: Object.freeze([
      "diamond helmet",
      "diamond_helmet",
      "钻石头盔",
    ]),
    diamond_chestplate: Object.freeze([
      "diamond chestplate",
      "diamond_chestplate",
      "钻石胸甲",
    ]),
    diamond_leggings: Object.freeze([
      "diamond leggings",
      "diamond_leggings",
      "钻石护腿",
    ]),
    diamond_boots: Object.freeze([
      "diamond boots",
      "diamond_boots",
      "钻石靴子",
      "钻石鞋",
    ]),
    charcoal: Object.freeze(["charcoal", "木炭"]),
    torch: Object.freeze(["torch", "torches", "火把"]),
    chest: Object.freeze(["chest", "chests", "箱子", "储物箱"]),
    wooden_sword: Object.freeze([
      "wooden sword",
      "wooden_sword",
      "木剑",
      "木制剑",
    ]),
    stone_sword: Object.freeze([
      "stone sword",
      "stone_sword",
      "石剑",
      "石制剑",
    ]),
    iron_sword: Object.freeze([
      "iron sword",
      "iron_sword",
      "铁剑",
      "铁制剑",
    ]),
    shield: Object.freeze(["shield", "盾牌", "盾"]),
    iron_helmet: Object.freeze([
      "iron helmet",
      "iron_helmet",
      "铁头盔",
      "铁头盔",
    ]),
    iron_chestplate: Object.freeze([
      "iron chestplate",
      "iron_chestplate",
      "铁胸甲",
    ]),
    iron_leggings: Object.freeze([
      "iron leggings",
      "iron_leggings",
      "铁护腿",
    ]),
    iron_boots: Object.freeze(["iron boots", "iron_boots", "铁靴子", "铁鞋"]),
  });

/**
 * 别名表覆盖到的物品名，供测试与 ResourceGraph 对账。导出的是键集合而不是整张
 * 表：调用方需要的是"哪些物品能被目标文本认出来"，不该拿到可改的别名列表。
 */
export const plannedItemGoalAliasCoverage: readonly string[] = Object.freeze(
  Object.keys(PLANNED_ITEM_GOAL_ALIASES).sort(),
);
