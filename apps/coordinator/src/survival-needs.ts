import { DeathStreakTracker, assessDropRecovery } from "@minecraft-studio/skills";
// ---------------------------------------------------------------------------
// SurvivalNeeds —— 自主生存的确定性需求评估器（Needs/Utility + Goal Graph）。
//
// 替换原先 12 步固定脚本（AUTONOMOUS_GOAL_SEQUENCE）的根因：那份清单到
// shelter 就走完，然后永远循环砍树/挖避难所；没有食物目标、没有武器护甲、
// 没有钻石推进。这里把"下一步做什么"变成一个纯函数：
//
//   输入 = Bot 的真实状态（health/food/inventory/armorPoints）+ 少量进程内记忆
//   输出 = 按 urgency × 权重打分排序的需求列表，每条带人类可读的"为什么"
//
// 全部确定性：无随机、无时钟依赖（除显式传入的记忆时间戳）、平局按固定
// 优先级裁决——同一状态永远得到同一决策，可单测、可回放。
//
// 目标文本格式与 deterministic-goals.ts 的模板解析器严格对齐：打分器产出
// 的每一条 operatorGoal 都能被确定性派发，不经过模型。
// ---------------------------------------------------------------------------

import type { BotRegistryRecord } from "./bot-registry.js";

/** 安全食物名册（与 runtime L0 的 safeFoodItems 口径对齐：能吃的、无副作用的）。 */
import { SAFE_FOOD_ITEMS as CATALOG_SAFE_FOOD, totalWoodUnits } from "@minecraft-studio/skills";

/** @deprecated 使用 @minecraft-studio/skills 的 SAFE_FOOD_ITEMS（唯一定义点）。 */
export const SAFE_FOOD_ITEM_NAMES: ReadonlySet<string> = CATALOG_SAFE_FOOD;

export type SurvivalNeedKey =
  | "FOOD_SECURITY"
  | "EQUIP_ARMOR"
  | "DEATH_RECOVERY"
  | "TOOL_RECOVERY"
  | "WEAPON_RECOVERY"
  | "TOOL_PROGRESSION"
  | "WOOD_RESERVE"
  | "WEAPON"
  | "ARMOR"
  | "IRON_RESERVE"
  | "SHIELD"
  | "SHELTER"
  | "DIAMOND_PROGRESSION"
  | "DIAMOND_ARMOR"
  | "COAL_RESERVE"
  | "TORCH"
  | "CHEST"
  | "EXPLORATION";

export type SurvivalNeed = Readonly<{
  key: SurvivalNeedKey;
  /** 0–100 的紧迫度；同分按 PRIORITY_ORDER 裁决。 */
  score: number;
  /** Dashboard/日志里给人看的一句话：为什么是这条。 */
  reason: string;
  /** 下发 planner 的目标文本；格式必须能被 deterministic-goals 解析。 */
  operatorGoal: string;
  /** 展示标题（任务视图用）。 */
  title: string;
  /**
   * 采集链的源方块（恢复梯扫描用）。None 表示这不是一条采集型需求
   * （食物/避难所/探索走各自的技能路径）。
   */
  sourceBlock: string | null;
}>;

export type SurvivalAssessmentInput = Readonly<{
  record: BotRegistryRecord;
  /** 该 Bot 是否已成功挖过避难所（进程内记忆，重启后重来是安全侧的失败）。 */
  shelterBuilt: boolean;
  /** 已完成回收的死亡时间戳（diedAt ISO 串），避免反复回同一个死点。 */
  recoveredDeaths?: readonly string[];
  /**
   * 战略评审重心对需求键的加权表（strategy-review 的 FOCUS_NEED_BOOSTS）。
   * 只加不减、加权后钳到 95：重心改变"先做什么"，改不掉硬性生存需求。
   */
  focusBoosts?: Readonly<Record<string, number>> | undefined;
  /** 可注入时钟（P0-A8）：不传则用 Date。一次读取贯穿整个评估。 */
  now?: Date;
}>;

/**
 * 平局裁决顺序。食物永远最高；探索永远垫底。顺序本身就是产品决策：
 * 活着 > 能挖 > 有木头 > 打得过 > 穿得上 > 长期推进。
 */
const PRIORITY_ORDER: readonly SurvivalNeedKey[] = Object.freeze([
  "FOOD_SECURITY",
  "EQUIP_ARMOR",
  "DEATH_RECOVERY",
  "TOOL_RECOVERY",
  "WEAPON_RECOVERY",
  "TOOL_PROGRESSION",
  "WOOD_RESERVE",
  "WEAPON",
  "ARMOR",
  "IRON_RESERVE",
  "SHIELD",
  "SHELTER",
  "DIAMOND_PROGRESSION",
  "DIAMOND_ARMOR",
  "COAL_RESERVE",
  "TORCH",
  "CHEST",
  "EXPLORATION",
]);

/** 任何档位的护甲件（用于"有甲未穿"的 EQUIP_ARMOR 判定）。 */
const ARMOR_PIECE_NAMES = [
  "iron_helmet",
  "iron_chestplate",
  "iron_leggings",
  "iron_boots",
  "diamond_helmet",
  "diamond_chestplate",
  "diamond_leggings",
  "diamond_boots",
] as const;

const FOOD_EMERGENCY = 3;
const FOOD_MINIMUM = 6;
const FOOD_TARGET = 12;
const WOOD_MINIMUM = 16;
const WOOD_CRITICAL = 4;
const COAL_MINIMUM = 8;
const IRON_MINIMUM = 6;
const TORCH_MINIMUM = 16;
const DIAMOND_PICKAXE_RESERVE = 3;
/** 死亡点回收窗口：掉落物 5 分钟后开始消失，留 15 分钟是保守上限。 */

/** 连续死亡追踪——streak ≥ 3 时停止送装备去捡装备。 */
const deathStreakTracker = new DeathStreakTracker({ resetWindowMs: 5 * 60_000 });
const DEATH_RECOVERY_WINDOW_MS = 15 * 60_000;
/** 距死点多近算"已到达"（掉落物碰撞拾取半径外扩）。 */
const DEATH_RECOVERY_ARRIVAL_BLOCKS = 6;

import { PICKAXE_BY_TIER } from "@minecraft-studio/skills";
const PICKAXE_TIERS = ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe"] as const;
const TOOL_SOURCE_BLOCKS = ["oak_log", "stone", "iron_ore", "diamond_ore"] as const;

export function assessSurvivalNeeds(
  input: SurvivalAssessmentInput,
): readonly SurvivalNeed[] {
  const status = input.record.currentStatus;
  const inventory = inventoryMap(status?.inventory);
  const now = input.now ?? new Date();
  const needs: SurvivalNeed[] = [];

  const safeFood = countSafeFood(inventory);
  const foodLevel = status?.food.level ?? 20;
  const woodUnits = totalWoodUnits(new Map(
    [...inventoryMap(status?.inventory).entries()].map(([k, v]) => [k, v.count] as const)
  ));

  // ---- 食物安全：曲线而非开关。饿着肚子时储备不足急剧升权；饱腹时
  // 只做"顺手补到 12"的低权维护，不挡工具进度。
  if (safeFood < FOOD_EMERGENCY) {
    needs.push(foodNeed(FOOD_TARGET, foodLevel < 16 ? 92 : 62, safeFood, "emergency"));
  } else if (safeFood < FOOD_MINIMUM) {
    needs.push(foodNeed(FOOD_TARGET, foodLevel < 16 ? 78 : 52, safeFood, "minimum"));
  } else if (safeFood < FOOD_TARGET) {
    needs.push(foodNeed(FOOD_TARGET, 34, safeFood, "target"));
  }

  // ---- 死亡点回收：装备掉在原地，走过去就自动拾取（MC 的掉落物靠
  // 碰撞拾取）。15 分钟内、8 格外、未回收过的死亡点是最有价值的单目标。
  const lastDeath = status?.lastDeath ?? null;
  if (
    lastDeath &&
    status?.position &&
    !(input.recoveredDeaths ?? []).includes(lastDeath.diedAt)
  ) {
    const deathAgeMs = Date.parse(lastDeath.diedAt);
    // P0-A7: 跨维度不导航——下界坐标拿到主世界走是致命错误
    const sameDimension = status.position.dimension === lastDeath.dimension;
    const distance = sameDimension ? Math.hypot(
      status.position.x - lastDeath.x,
      status.position.y - lastDeath.y,
      status.position.z - lastDeath.z,
    ) : Infinity;
    if (
      sameDimension &&
      Number.isFinite(deathAgeMs) &&
      now.getTime() - deathAgeMs <= DEATH_RECOVERY_WINDOW_MS &&
      distance > DEATH_RECOVERY_ARRIVAL_BLOCKS
    ) {
      // Phase 1d：用 assessDropRecovery 做价值/风险/streak 评估
      // （inventory 是近似——死亡时掉的就是死前有的）。
      const assessment = assessDropRecovery({
        drops: [...inventory.entries()].map(([itemId, info]) => ({ itemId, count: info.count })),
        diedAtMs: deathAgeMs,
        nowMs: now.getTime(),
        distanceBlocks: Math.round(distance),
        deathStreak: deathStreakTracker.streak,
        sameDimension,
        despawnWindowMs: DEATH_RECOVERY_WINDOW_MS,
      });
      if (assessment.shouldRecover) {
        needs.push({
          key: "DEATH_RECOVERY",
          score: 85,
          reason: assessment.reason,
          title: "回收死亡掉落",
          operatorGoal: `移动到坐标 x=${lastDeath.x} y=${lastDeath.y} z=${lastDeath.z} 附近，回收死亡掉落物`,
          sourceBlock: null,
        });
      }
    }
  }

  // ---- 工具阶梯：Goal Graph 的主干。每档只看"有没有"，链路（木/石/铁）
  // 由确定性 GoalPlanner 倒推，这里不重复描述依赖。
  // P0-A1: 从最高档往下找——同时有木镐和铁镐时，当前档位是铁，不是木。
  const pickaxeTier = (() => {
    for (let i = PICKAXE_TIERS.length - 1; i >= 0; i -= 1) {
      if ((inventory.get(PICKAXE_TIERS[i]!)?.count ?? 0) > 0) return i;
    }
    return -1;
  })();
  if (pickaxeTier < 0) {
    needs.push(itemNeed("TOOL_PROGRESSION", 75, "wooden_pickaxe", "no pickaxe at all", 1, "oak_log"));
  } else if (pickaxeTier < PICKAXE_TIERS.length - 1) {
    const next = PICKAXE_TIERS[pickaxeTier + 1]!;
    const score = pickaxeTier === 0 ? 65 : pickaxeTier === 1 ? 55 : 42;
    needs.push(itemNeed("TOOL_PROGRESSION", score, next, `pickaxe tier ${PICKAXE_TIERS[pickaxeTier]} < next ${next}`, 1, TOOL_SOURCE_BLOCKS[pickaxeTier + 1] ?? null));
  }

  // ---- 耐久恢复：当前主力工具磨损到阈值之下就补一件备用（目标数 = 现有+1，
  // 确定性规划器据此真的多合一件）。镐子在路上断掉等于整个采集链停摆，
  // 所以分数压过梯队推进。
  const TOOL_DURABILITY_FRACTION = 0.2;
  if (pickaxeTier >= 0) {
    const current = PICKAXE_TIERS[pickaxeTier]!;
    const fraction = durabilityFraction(inventory.get(current));
    if (fraction < TOOL_DURABILITY_FRACTION) {
      const owned = inventory.get(current)?.count ?? 1;
      needs.push(itemNeed(
        "TOOL_RECOVERY",
        68,
        current,
        `${current} durability ${(fraction * 100).toFixed(0)}% < ${(TOOL_DURABILITY_FRACTION * 100).toFixed(0)}%`,
        owned + 1,
        TOOL_SOURCE_BLOCKS[pickaxeTier] ?? null,
      ));
    }
  }
  for (const sword of ["stone_sword", "iron_sword", "diamond_sword"] as const) {
    const entry = inventory.get(sword);
    if ((entry?.count ?? 0) === 0) continue;
    const fraction = durabilityFraction(entry);
    if (fraction < TOOL_DURABILITY_FRACTION) {
      needs.push(itemNeed(
        "WEAPON_RECOVERY",
        48,
        sword,
        `${sword} durability ${(fraction * 100).toFixed(0)}% < ${(TOOL_DURABILITY_FRACTION * 100).toFixed(0)}%`,
        (entry?.count ?? 1) + 1,
        sword === "stone_sword" ? "stone" : "iron_ore",
      ));
      break;
    }
  }

  // ---- 木料储备：工具之外持续补充的建筑/燃料本钱。
  if (woodUnits < WOOD_CRITICAL) {
    needs.push(itemNeed("WOOD_RESERVE", 68, "oak_log", `wood reserve ${woodUnits} < critical ${WOOD_CRITICAL}`, deficitCount(WOOD_MINIMUM, woodUnits), "oak_log"));
  } else if (woodUnits < WOOD_MINIMUM) {
    needs.push(itemNeed("WOOD_RESERVE", 30, "oak_log", `wood reserve ${woodUnits} < minimum ${WOOD_MINIMUM}`, deficitCount(WOOD_MINIMUM, woodUnits), "oak_log"));
  }

  // ---- 武器：石器时代之后必须有；铁器时代升铁剑。
  // P0-A1: 剑也用最高可用档
  const bestSwordTier = (() => {
    if ((inventory.get("diamond_sword")?.count ?? 0) > 0) return 3;
    if ((inventory.get("iron_sword")?.count ?? 0) > 0) return 2;
    if ((inventory.get("stone_sword")?.count ?? 0) > 0) return 1;
    if ((inventory.get("wooden_sword")?.count ?? 0) > 0) return 0;
    return -1;
  })();
  if (pickaxeTier >= 1 && bestSwordTier < 1) {
    needs.push(itemNeed("WEAPON", 50, "stone_sword", "no sword for defense and hunting", 1, "stone"));
  } else if (pickaxeTier >= 2 && bestSwordTier < 2) {
    needs.push(itemNeed("WEAPON", 44, "iron_sword", "iron age reached but sword is below tier", 1, "iron_ore"));
  }

  // ---- 有甲未穿：armorPoints 只反映穿戴，合好的甲放在背包里等于没有。
  // 穿戴是零成本幂等技能（inventory.equip-armor），永远先于"再合一件"。
  const armorPoints = status?.armorPoints ?? 0;
  const ownedArmorPieces = ARMOR_PIECE_NAMES.filter((name) => (inventory.get(name)?.count ?? 0) > 0);
  if (armorPoints === 0 && ownedArmorPieces.length > 0) {
    needs.push({
      key: "EQUIP_ARMOR",
      score: 60,
      reason: `armor points 0 while carrying ${ownedArmorPieces.length} armor piece(s)`,
      title: "穿上最好的护甲",
      operatorGoal: "穿上最好的护甲",
      sourceBlock: null,
    });
  }

  // ---- 铁甲：armorPoints 只告诉"穿了没"，不告诉穿了什么；逐件补齐。
  // 只有在一件甲都没有时才走合成链——有甲先穿，缺件再补。
  // P0-A3: 只在背包中没有可穿护甲时才合成新的（有的话先 EQUIP_ARMOR）。
  // armorPoints < 15 (full iron = 2+6+5+2) 表示没穿满。
  if (pickaxeTier >= 2 && armorPoints < 15 && ownedArmorPieces.length === 0) {
    // P0-A3: armorPoints < 15 (full iron = 2+6+5+2) 表示没穿满。
    // 协议没有逐槽信息，用 armorPoints 推断下一个缺失件：
    // <2=盔, <8=胸, <13=腿, <15=靴。
    const nextPiece = armorPoints < 2 ? "iron_helmet"
      : armorPoints < 8 ? "iron_chestplate"
      : armorPoints < 13 ? "iron_leggings"
      : "iron_boots";
    needs.push(itemNeed("ARMOR", 40, nextPiece, `armor points ${armorPoints} < 15, filling slots`, 1, "iron_ore"));
  }

  // ---- 铁储备：铁器时代的持续本钱（工具链自己会要铁，这里补余量）。
  const ironUnits = (inventory.get("raw_iron")?.count ?? 0) + (inventory.get("iron_ingot")?.count ?? 0);
  if (pickaxeTier >= 1 && ironUnits < IRON_MINIMUM) {
    needs.push(itemNeed("IRON_RESERVE", 35, "raw_iron", `iron reserve ${ironUnits} < minimum ${IRON_MINIMUM}`, deficitCount(IRON_MINIMUM, ironUnits), "iron_ore"));
  }

  // ---- 盾牌：铁器时代后的保命件。
  if (pickaxeTier >= 2 && (inventory.get("shield")?.count ?? 0) === 0) {
    needs.push(itemNeed("SHIELD", 33, "shield", "iron age reached without a shield", 1, "iron_ore"));
  }

  // ---- 避难所：一次性行为，靠记忆去重，不靠背包推断。
  // 受伤时（实测：首个夜晚无甲无剑被压到 2 血触发 L0 断线保号）避难所
  // 紧急度提到工具之上——徒手挖土就能成型的地洞不需要任何工具档位，
  // 所以受伤分支同时放开 pickaxeTier 门槛。
  const healthMaximum = status?.health.maximum ?? 20;
  const healthCurrent = status?.health.current ?? healthMaximum;
  const takingDamage = healthCurrent < healthMaximum * 0.7;
  if (!input.shelterBuilt && (pickaxeTier >= 1 || takingDamage)) {
    needs.push({
      key: "SHELTER",
      score: takingDamage ? 72 : 28,
      reason: takingDamage
        ? `health ${healthCurrent.toFixed(1)}/${healthMaximum} — dig in before the next hit`
        : "stone age reached without a dug shelter",
      title: "建立安全避难所",
      operatorGoal: "在当前维度向 north 挖一个 2 格深的安全避难所，并用 dirt 封口",
      sourceBlock: null,
    });
  }

  // ---- 钻石推进：铁镐之后的下一个台阶，先攒镐+剑的本钱再谈甲。
  const diamonds = inventory.get("diamond")?.count ?? 0;
  if (pickaxeTier === 2 && diamonds < DIAMOND_PICKAXE_RESERVE) {
    needs.push(itemNeed("DIAMOND_PROGRESSION", 48, "diamond", `diamond reserve ${diamonds} < ${DIAMOND_PICKAXE_RESERVE} for a diamond pickaxe`, DIAMOND_PICKAXE_RESERVE - diamonds, "diamond_ore"));
  }
  if (pickaxeTier >= 3) {
    const missingDiamondArmor = firstMissing([
      "diamond_helmet",
      "diamond_chestplate",
      "diamond_leggings",
      "diamond_boots",
    ], inventory);
    if (missingDiamondArmor !== null) {
      needs.push(itemNeed("DIAMOND_ARMOR", 30, missingDiamondArmor, `diamond age reached but ${missingDiamondArmor} missing`, 1, "diamond_ore"));
    }
  }

  // ---- 煤/火把：照明与燃料的低权持续维护。
  const coalUnits = (inventory.get("coal")?.count ?? 0) + (inventory.get("charcoal")?.count ?? 0);
  if (pickaxeTier >= 1 && coalUnits < COAL_MINIMUM) {
    needs.push(itemNeed("COAL_RESERVE", 25, "coal", `coal reserve ${coalUnits} < minimum ${COAL_MINIMUM}`, deficitCount(COAL_MINIMUM, coalUnits), "coal_ore"));
  }
  if (pickaxeTier >= 1 && coalUnits >= 1 && (inventory.get("torch")?.count ?? 0) < TORCH_MINIMUM) {
    needs.push(itemNeed("TORCH", 20, "torch", `torches ${inventory.get("torch")?.count ?? 0} < minimum ${TORCH_MINIMUM}`, deficitCount(TORCH_MINIMUM, inventory.get("torch")?.count ?? 0), "coal_ore"));
  }

  // ---- 箱子：铁器时代后的储存基建（放箱子本身后续接入，先有物件）。
  if (pickaxeTier >= 2 && (inventory.get("chest")?.count ?? 0) === 0) {
    needs.push(itemNeed("CHEST", 18, "chest", "iron age reached without storage", 1, "oak_log"));
  }

  // ---- 探索：唯一允许的"没有更好目标时"行为；食物吃紧时压到 0（不许
  // 带着见底的储备远行）。坐标由 director 的扇区游标注入，这里只出意图。
  const explorationScore = safeFood >= FOOD_MINIMUM ? 5 : 0;
  if (explorationScore > 0) {
    needs.push({
      key: "EXPLORATION",
      score: explorationScore,
      reason: `no higher-scoring need; safe food ${safeFood} >= ${FOOD_MINIMUM}`,
      title: "向外探索新区域",
      // 占位坐标：director 用扇区游标替换成真实偏移目标。
      operatorGoal: "EXPLORATION",
      sourceBlock: null,
    });
  }

  if (input.focusBoosts) {
    for (let index = 0; index < needs.length; index += 1) {
      const need = needs[index]!;
      const boost = input.focusBoosts[need.key];
      if (boost && boost > 0) {
        needs[index] = { ...need, score: Math.min(95, need.score + boost) };
      }
    }
  }
  return needs.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return PRIORITY_ORDER.indexOf(left.key) - PRIORITY_ORDER.indexOf(right.key);
  });
}

function foodNeed(count: number, score: number, safeFood: number, tier: string): SurvivalNeed {
  return {
    key: "FOOD_SECURITY",
    score,
    reason: `safe food ${safeFood} below ${tier} threshold`,
    title: "补充安全食物储备",
    operatorGoal: `获取安全食物到总量 ${count} 份`,
    sourceBlock: null,
  };
}

function itemNeed(
  key: SurvivalNeedKey,
  score: number,
  itemName: string,
  reason: string,
  count = 1,
  sourceBlock: string | null = null,
): SurvivalNeed {
  return {
    key,
    score,
    reason,
    title: `获取 ${itemName}`,
    operatorGoal: count > 1 ? `获取 ${count} 个 ${itemName}` : `获取 ${itemName}`,
    sourceBlock,
  };
}

function deficitCount(minimum: number, current: number): number {
  return Math.max(1, Math.min(32, minimum - current));
}

function countSafeFood(inventory: ReadonlyMap<string, InventoryEntry>): number {
  let total = 0;
  for (const [name, entry] of inventory) {
    if (SAFE_FOOD_ITEM_NAMES.has(name)) total += entry.count;
  }
  return total;
}

function firstMissing(
  items: readonly string[],
  inventory: ReadonlyMap<string, InventoryEntry>,
): string | null {
  for (const item of items) {
    if ((inventory.get(item)?.count ?? 0) === 0) return item;
  }
  return null;
}

type InventoryEntry = Readonly<{
  count: number;
  durability: number | null;
  maxDurability: number | null;
}>;

function inventoryMap(
  inventory:
    | readonly Readonly<{
        itemName: string;
        count: number;
        durability?: number | undefined;
        maxDurability?: number | undefined;
      }>[]
    | undefined,
): ReadonlyMap<string, InventoryEntry> {
  const map = new Map<string, InventoryEntry>();
  for (const item of inventory ?? []) {
    const existing = map.get(item.itemName);
    map.set(item.itemName, {
      count: (existing?.count ?? 0) + item.count,
      durability: item.durability ?? existing?.durability ?? null,
      maxDurability: item.maxDurability ?? existing?.maxDurability ?? null,
    });
  }
  return map;
}

/** 耐久余量（0–1）；无耐久数据的物品按满耐久处理。 */
function durabilityFraction(entry: InventoryEntry | undefined): number {
  if (!entry || !entry.maxDurability || entry.maxDurability <= 0) return 1;
  const remaining = entry.durability ?? entry.maxDurability;
  // 钳制作用在比值上：把耐久值钳到 1 再除会把 8/132 算成 1%。
  return Math.max(0, Math.min(1, remaining / entry.maxDurability));
}
