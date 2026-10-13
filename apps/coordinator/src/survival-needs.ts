import { armorScore, assessDropRecovery } from "@minecraft-studio/skills";
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
import type { BasePhaseSnapshot } from "./base-phase-state.js";

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
  | "BED"
  | "DIAMOND_PROGRESSION"
  | "DIAMOND_ARMOR"
  | "DIAMOND_TOOLS"
  | "DIAMOND_WEAPON"
  | "BASE_SITE_SELECTION"
  | "BASE_MAIN_CONSTRUCTION"
  | "BASE_FACILITY_COBBLE"
  | "BASE_FACILITY_FARM"
  | "BASE_FARM_MAINTENANCE"
  | "BASE_RETURN"
  | "COAL_RESERVE"
  | "TORCH"
  | "CHEST"
  | "RECON_PATROL"
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
  /**
   * R5-RECON：侦察巡逻（L-巡逻层）。仅在 director 显式供给走廊 goal 时
   * 参与（默认不供给 → 行为与旧版完全一致，场景期 STUDIO_AUTONOMY_ENABLED=0
   * 天然不受影响）。goalText 来自 recon-patrol 网格分配器，格式与
   * deterministic-goals 的 roof 模板严格对齐。
   */
  reconPatrol?: Readonly<{ goalText: string; reason: string }> | null;
  /**
   * 基地阶段真值（Implementation Prompt V1 · Phase 1）：7 个结构化阶段门
   * 快照，来自 BasePhaseTracker。未传入 = 基地流水线能力未接线 →
   * BASE_* needs 全部静默（防幽灵需求）。
   */
  basePhase?: BasePhaseSnapshot | null;
  /** 可注入时钟（P0-A8）：不传则用 Date。一次读取贯穿整个评估。 */
  now?: Date;
  recoveryMemory?: SurvivalRecoveryMemory;
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
  "BED",
  "DIAMOND_PROGRESSION",
  "DIAMOND_ARMOR",
  "DIAMOND_TOOLS",
  "DIAMOND_WEAPON",
  "BASE_SITE_SELECTION",
  "BASE_MAIN_CONSTRUCTION",
  "BASE_FACILITY_COBBLE",
  "BASE_FACILITY_FARM",
  "BASE_FARM_MAINTENANCE",
  "BASE_RETURN",
  "COAL_RESERVE",
  "TORCH",
  "CHEST",
  "RECON_PATROL",
  "EXPLORATION",
]);

/** 任何档位的护甲件（用于"有甲未穿"的 EQUIP_ARMOR 判定）。 */
const ARMOR_SLOT_PIECES = [
  ["head", "helmet"], ["chest", "chestplate"], ["legs", "leggings"], ["feet", "boots"],
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
/** 连续死亡追踪——streak ≥ 3 时停止送装备去捡装备。 */
export class SurvivalRecoveryMemory {
  private readonly entries = new Map<string, { seen: string; deaths: number[] }>();

  observe(record: BotRegistryRecord, nowMs: number, arrived: boolean): number {
    const diedAt = record.currentStatus?.lastDeath?.diedAt;
    if (!diedAt) return 0;
    const key = JSON.stringify([record.serverProfileId, record.botId]);
    const entry = this.entries.get(key) ?? { seen: "", deaths: [] };
    entry.deaths = entry.deaths.filter((at) => at > nowMs - 300_000 && at <= nowMs);
    const at = Date.parse(diedAt);
    if (entry.seen !== diedAt && Number.isFinite(at) && at <= nowMs && at > nowMs - 300_000) {
      entry.deaths.push(at);
    }
    entry.seen = diedAt;
    if (arrived) entry.deaths = [];
    this.entries.set(key, entry);
    return entry.deaths.length;
  }
}
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

  // ---- 死亡点回收：装备掉在原地。目标文本必须走 recover.drops，
  // 走近并确认 6 格内没有剩余掉落物才算捡回。15 分钟内、未回收过、
  // 还没站到死亡点上的同维度死亡点才进入需求。
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
    // streak 接线：新死亡记一次；到达死点（已捡回）则清零。
    const deathStreak = input.recoveryMemory?.observe(input.record, now.getTime(),
      sameDimension && distance <= DEATH_RECOVERY_ARRIVAL_BLOCKS) ?? 1;
    if (
      sameDimension &&
      Number.isFinite(deathAgeMs) &&
      now.getTime() >= deathAgeMs &&
      now.getTime() - deathAgeMs <= DEATH_RECOVERY_WINDOW_MS &&
      distance > DEATH_RECOVERY_ARRIVAL_BLOCKS
    ) {
      // Phase 1d：用 assessDropRecovery 做价值/风险/streak 评估。
      // 门禁 3：优先用死亡时刻快照（droppedItems/xpPoints）；快照缺失
      // （旧 runtime）才退回当前背包近似（重生后为空 = unknown-value）。
      const drops =
        lastDeath.droppedItems !== undefined && lastDeath.droppedItems.length > 0
          ? lastDeath.droppedItems.map((d) => ({ itemId: d.itemId, count: d.count }))
          : [...inventory.entries()].map(([itemId, info]) => ({ itemId, count: info.count }));
      const assessment = assessDropRecovery({
        drops,
        diedAtMs: deathAgeMs,
        nowMs: now.getTime(),
        distanceBlocks: Math.round(distance),
        deathStreak,
        sameDimension,
        despawnWindowMs: DEATH_RECOVERY_WINDOW_MS,
      });
      if (assessment.shouldRecover) {
        needs.push({
          key: "DEATH_RECOVERY",
          score: 85,
          reason: assessment.reason,
          title: "回收死亡掉落",
          operatorGoal: `移动到坐标 x=${Math.round(lastDeath.x)} y=${Math.round(lastDeath.y)} z=${Math.round(lastDeath.z)} 附近，回收死亡掉落物`,
          sourceBlock: null,
        });
      }
    }
  }

  // ---- 工具阶梯：Goal Graph 的主干。每档只看"有没有"，链路（木/石/铁）
  // 由确定性 GoalPlanner 倒推，这里不重复描述依赖。
  // P0-A1: 从最高档往下找——同时有木镐和铁镐时，当前档位是铁，不是木。
  const pickaxeTier = (() => {
    if ((inventory.get("netherite_pickaxe")?.count ?? 0) > 0) return 3;
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
    needs.push(itemNeed("WOOD_RESERVE", 68, "oak_log", `wood reserve ${woodUnits} < critical ${WOOD_CRITICAL}`, WOOD_MINIMUM, "oak_log"));
  } else if (woodUnits < WOOD_MINIMUM) {
    needs.push(itemNeed("WOOD_RESERVE", 30, "oak_log", `wood reserve ${woodUnits} < minimum ${WOOD_MINIMUM}`, WOOD_MINIMUM, "oak_log"));
  }

  // ---- 武器：石器时代之后必须有；铁器时代升铁剑。
  // P0-A1: 剑也用最高可用档
  const bestSwordTier = (() => {
    if ((inventory.get("netherite_sword")?.count ?? 0) > 0) return 3;
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
  const armorSlots = status?.armorSlots;
  const ownedArmorPieces = [...inventory.keys()].filter((name) => armorScore(name) > 0);
  const needsEquip = armorSlots
    ? ARMOR_SLOT_PIECES.some(([slot, suffix]) => ownedArmorPieces.some((name) =>
      name.endsWith(`_${suffix}`) && armorScore(name) > armorScore(armorSlots[slot])))
    : armorPoints === 0 && ownedArmorPieces.length > 0;
  const missingArmor = (material: "iron" | "diamond") => ARMOR_SLOT_PIECES.find(([slot, suffix]) => {
    const sufficient = (name: string | null) => name?.endsWith(`_${suffix}`) &&
      armorScore(name) >= armorScore(`${material}_${suffix}`);
    return !sufficient(armorSlots?.[slot] ?? null) && !ownedArmorPieces.some(sufficient);
  });
  if (needsEquip) {
    needs.push({
      key: "EQUIP_ARMOR",
      score: 60,
      reason: `carried armor improves an equipped slot (${armorPoints} armor points)`,
      title: "穿上最好的护甲",
      operatorGoal: "穿上最好的护甲",
      sourceBlock: null,
    });
  }

  // ---- 铁甲：先装备已有升级，再按实际槽位补件；兼容旧 Runtime 总护甲值。
  if (pickaxeTier >= 2 && !needsEquip && (armorSlots ? missingArmor("iron") !== undefined : armorPoints < 15 && ownedArmorPieces.length === 0)) {
    // 旧 Runtime 没有逐槽信息时保留原总护甲值推断。
    const nextPiece = armorSlots ? `iron_${missingArmor("iron")![1]}` : armorPoints < 2 ? "iron_helmet"
      : armorPoints < 8 ? "iron_chestplate"
      : armorPoints < 13 ? "iron_leggings"
      : "iron_boots";
    needs.push(itemNeed("ARMOR", 40, nextPiece, `armor points ${armorPoints} < 15, filling slots`, 1, "iron_ore"));
  }

  // ---- 铁储备：铁器时代的持续本钱（工具链自己会要铁，这里补余量）。
  const ironUnits = (inventory.get("raw_iron")?.count ?? 0) + (inventory.get("iron_ingot")?.count ?? 0);
  if (pickaxeTier >= 1 && ironUnits < IRON_MINIMUM) {
    needs.push(itemNeed("IRON_RESERVE", 35, "raw_iron", `iron reserve ${ironUnits} < minimum ${IRON_MINIMUM}`, IRON_MINIMUM, "iron_ore"));
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
      // 避难所优先于钻石升级；受伤分支提高到 72。
      score: takingDamage ? 72 : 51,
      reason: takingDamage
        ? `health ${healthCurrent.toFixed(1)}/${healthMaximum} — dig in before the next hit`
        : "stone age reached without a dug shelter",
      title: "建立安全避难所",
      operatorGoal: "在当前维度向 north 挖一个 2 格深的安全避难所，并用 dirt 封口",
      sourceBlock: null,
    });
  }

  // ---- 床（Implementation Prompt V1 · Phase 2）：避难所之后的重生点。
  // 50 分压过钻套（50 同分但 PRIORITY_ORDER 在前）——有庇护就该有重生点。
  // 最佳努力：采集链经 white_wool（可徒手挖的方块）；荒野无羊毛时失败→
  // 抑制→流水线继续。放置/睡下设重生点在基地阶段承接（starter base 落成
  // 后床入箱），此处只保证"有床"。
  if (input.shelterBuilt && pickaxeTier >= 1 && ![...inventory.keys()].some((name) => name === "bed" || name.endsWith("_bed"))) {
    needs.push(itemNeed("BED", 50, "bed", "shelter ready but no bed for a respawn point", 1, "white_wool"));
  }

  // ---- 钻石推进：铁镐之后的下一个台阶，先攒镐+剑的本钱再谈甲。
  const diamonds = inventory.get("diamond")?.count ?? 0;
  // 基地选址要求四件钻甲、镐和剑；生产用斧铲升级不阻塞选址。
  const hasFullDiamondSet =
    pickaxeTier >= 3 &&
    bestSwordTier >= 3 &&
    missingArmor("diamond") === undefined;
  if (pickaxeTier === 2 && diamonds < DIAMOND_PICKAXE_RESERVE) {
    needs.push(itemNeed("DIAMOND_PROGRESSION", 48, "diamond", `diamond reserve ${diamonds} < ${DIAMOND_PICKAXE_RESERVE} for a diamond pickaxe`, DIAMOND_PICKAXE_RESERVE, "diamond_ore"));
  }
  if (pickaxeTier >= 3) {
    const missingDiamondSlot = missingArmor("diamond");
    const missingDiamondArmor = missingDiamondSlot ? `diamond_${missingDiamondSlot[1]}` : null;
    if (missingDiamondArmor !== null) {
      // 钻甲优先于常规生产升级，仍服从食物、避难所和装备恢复。
      needs.push(itemNeed("DIAMOND_ARMOR", 50, missingDiamondArmor, `diamond age reached but ${missingDiamondArmor} missing`, 1, "diamond_ore"));
    }
    const missingDiamondTool = firstMissing([
      "diamond_axe",
      "diamond_shovel",
    ], inventory);
    if (missingDiamondTool !== null) {
      needs.push(itemNeed("DIAMOND_TOOLS", 39, missingDiamondTool, `optional production upgrade: ${missingDiamondTool} missing`, 1, "diamond_ore"));
    }
    if (bestSwordTier < 3) {
      needs.push(itemNeed("DIAMOND_WEAPON", 48, "diamond_sword", "diamond set incomplete: diamond_sword missing", 1, "diamond_ore"));
    }

    // ---- 基地选址+建造（用户产品方向 2026-09-04；Implementation Prompt V1
    // Phase 1 改为阶段门驱动）。全套钻装齐（甲+镐+剑）后，基地流水线由
    // basePhase 七门顺序放行：选址(47) → 主体(46) → 刷石机(45) → 农场(44)。
    // 阶段门判定在下方统一的 basePhase 块（函数级作用域）。
  }

  // ---- 基地阶段门（Implementation Prompt V1 · Phase 1）：
  // basePhase 未传入 = 阶段真值能力未接线 → 整段不触发（防幽灵需求，
  // 与旧 baseFacilities=null 语义一致）。传入后每门只在前序门就绪且
  // 自身未就绪时开口：不并发平级、不跳级。
  if (input.basePhase) {
    const phase = input.basePhase;
    // 选址：钻套齐 + 避难所就绪 + 尚未圈地（避难所未就绪时基地不抢位——
    // 避难所是更原始的生存需求，且 SHELTER(51) 分数本来就在本门之上）。
    if (hasFullDiamondSet && phase.SHELTER_MINIMAL_READY && !phase.BASE_SITE_RESERVED) {
      needs.push({
        key: "BASE_SITE_SELECTION",
        score: 47,
        reason: "full diamond set acquired, shelter ready, seeking permanent base site",
        title: "基地选址",
        operatorGoal: "向外探索新区域", // 复用探索游标：远离出生点找合适位置
        sourceBlock: null,
      });
    }
    // 主体：已圈地 + starter_base_v1 未建成。旧判据（hasBed && !shelterBuilt）
    // 是死代码：与选址前置 shelterBuilt 自相矛盾，永远不触发。
    if (phase.BASE_SITE_RESERVED && !phase.STARTER_BASE_ACTIVE) {
      needs.push({
        key: "BASE_MAIN_CONSTRUCTION",
        score: 46,
        reason: "site selected but starter base not built",
        title: "建造基地主体",
        operatorGoal: "使用蓝图文件 starter-base-v1 施工",
        sourceBlock: null,
      });
    }
    // 设施：主体就绪后刷石机先行（挖矿耗材自给），农场随后（食物自给）。
    if (phase.STARTER_BASE_ACTIVE) {
      if (!phase.COBBLE_FACILITY_ACTIVE) {
        needs.push({
          key: "BASE_FACILITY_COBBLE",
          score: 45,
          reason: "base established but no cobble generator",
          title: "建造刷石机",
          operatorGoal: "使用蓝图文件 cobble-generator 施工",
          sourceBlock: null,
        });
      }
      if (!phase.FOOD_FACILITY_ACTIVE) {
        needs.push({
          key: "BASE_FACILITY_FARM",
          score: 44,
          reason: "base established but no food farm",
          title: "建造农场",
          operatorGoal: "使用蓝图文件 carrot-farm-9x9 施工",
          sourceBlock: null,
        });
      }
    }
  }

  // ---- 煤/火把：照明与燃料的低权持续维护。
  const coalUnits = (inventory.get("coal")?.count ?? 0) + (inventory.get("charcoal")?.count ?? 0);
  if (pickaxeTier >= 1 && coalUnits < COAL_MINIMUM) {
    needs.push(itemNeed("COAL_RESERVE", 25, "coal", `coal reserve ${coalUnits} < minimum ${COAL_MINIMUM}`, COAL_MINIMUM, "coal_ore"));
  }
  if (pickaxeTier >= 1 && coalUnits >= 1 && (inventory.get("torch")?.count ?? 0) < TORCH_MINIMUM) {
    needs.push(itemNeed("TORCH", 20, "torch", `torches ${inventory.get("torch")?.count ?? 0} < minimum ${TORCH_MINIMUM}`, TORCH_MINIMUM, "coal_ore"));
  }

  // ---- 箱子：铁器时代后的储存基建（放箱子本身后续接入，先有物件）。
  if (pickaxeTier >= 2 && (inventory.get("chest")?.count ?? 0) === 0) {
    needs.push(itemNeed("CHEST", 18, "chest", "iron age reached without storage", 1, "oak_log"));
  }

  // ---- 侦察巡逻（R5-RECON）：与探索同级的"空闲行为"，同样被食物纪律
  // 约束（储备见底不许远行）。分数 6 略高于通用探索 5：巡逻产出情报，
  // 通用探索只产出地形。仅当 director 供给走廊时参与。
  if (input.reconPatrol?.goalText && safeFood >= FOOD_MINIMUM) {
    needs.push({
      key: "RECON_PATROL",
      score: 6,
      reason: input.reconPatrol.reason,
      title: "roof 侦察走廊扫描",
      operatorGoal: input.reconPatrol.goalText,
      sourceBlock: null,
    });
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
