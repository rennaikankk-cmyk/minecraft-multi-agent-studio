// ---------------------------------------------------------------------------
// tactics-shadow.ts —— 战术核心 advisory shadow 接线（feature flag，默认关）。
//
// 纪律（packages/combat/src/tactics/* 的产物只读消费）：
//   - STUDIO_TACTICS_CORE=1 才启用；任何其他非空值 fail-closed 抛错（与
//     STUDIO_WATCHDOG_PROFILE 同一模式），拼错的环境变量不允许静默变成开关。
//   - 只观测不裁决：每步战斗反应跑一遍 score→select→evidence，产出
//     `bot_tactics_decision` 事件（含确定性 evidence JSON），绝不驱动动作。
//   - 快照装配诚实分级：有来源的字段如实映射；没有来源的字段用保守缺省
//     并在事件里标 evidenceQuality="partial-wiring"——绝不编造观察。
// ---------------------------------------------------------------------------

import {
  DEFAULT_TACTICS_PROFILE,
  initialEnemyBelief,
  type CombatSnapshot,
  type EmergencySignal,
  type EnemyBeliefState,
  type EscapeRoute,
  type InventoryValueBand,
} from "@minecraft-studio/combat";

import type { BotClientSnapshot } from "./client.js";
import type { CombatDriverObservation } from "./combat-driver.js";

/**
 * 解析 STUDIO_TACTICS_CORE：未设/空 → false（默认关，零行为变化）；
 * "1" → true；其他值抛错（fail-closed，不把垃圾值读成任意开关态）。
 */
export function resolveTacticsCoreEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = environment.STUDIO_TACTICS_CORE?.trim();
  if (value === undefined || value === "") return false;
  if (value === "1") return true;
  throw new Error(
    `STUDIO_TACTICS_CORE 必须是 1 或留空（收到：${value}），拒绝以歧义值启动战术核心影子模式。`,
  );
}

/** 其他敌人的 belief 映射上限：装配成本有界，其余敌情只进 hostileCount。 */
const MAX_OTHER_ENEMY_BELIEFS = 4;

function dimensionOf(raw: string): "overworld" | "nether" | "end" {
  const name = raw.replace(/^minecraft:/u, "");
  if (name === "the_nether" || name === "nether") return "nether";
  if (name === "the_end" || name === "end") return "end";
  return "overworld";
}

function countInventoryItem(
  snapshot: BotClientSnapshot,
  itemName: string,
): number {
  let total = 0;
  for (const item of snapshot.inventory) {
    if (item.itemName === itemName) total += Math.max(0, item.count);
  }
  return total;
}

function finiteOr(raw: number | null | undefined, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

/** belief 从观察装配：位置/装备如实；血量只有非玩家实体才有服务器元数据。 */
function beliefFromObservation(
  entity: CombatDriverObservation["entities"][number],
  nowMonotonicMs: number,
): EnemyBeliefState {
  const belief = initialEnemyBelief({
    entityId: entity.entity.entityId,
    uuid: entity.entity.uuid,
    username: entity.entity.username ?? `entity-${entity.entity.entityId}`,
    classification: "HOSTILE",
    nowMonotonicMs,
    position: entity.position,
  });
  // 玩家的 health 元数据服务器不下发（这正是 belief 层存在的理由），保持
  // [8,20] 先验；怪物元数据带精确 health，如实收窄为零宽区间。
  if (
    entity.entity.kind !== "player" &&
    typeof entity.health === "number" &&
    Number.isFinite(entity.health)
  ) {
    const clamped = Math.max(0, Math.min(20, entity.health));
    return {
      ...belief,
      health: {
        ...belief.health,
        intervalHp: { lo: clamped, hi: clamped },
        lastUpdateEvidence: "TRUSTED_SOURCE",
      },
    };
  }
  return belief;
}

function emergencySignalFromObservation(
  observation: CombatDriverObservation,
): EmergencySignal | null {
  // 唯一有真实来源的紧急信号：目标图腾 pop（Entity Status 35 → punish 窗）。
  // RED_LINE_TRIP / NEW_ENEMY_IN_REACH 等需要几何与红线评估，wiring-pending。
  return observation.entities.some((entity) => entity.recentlyPopped === true)
    ? "TOTEM_POP_EVENT"
    : null;
}

export function buildTacticsShadowSnapshot(input: Readonly<{
  nowMonotonicMs: number;
  stepMs: number;
  observation: CombatDriverObservation;
  snapshot: BotClientSnapshot;
  gameplayProfile: "anarchy_first" | "standard";
  stance: "preserve-life" | "expendable" | "aggressive";
  /** ServerPolicy 生效档（compat 面）；未知传 baseline 名。 */
  compatMode: string;
  /** 近窗服务器拒绝/回拉信号数（compat observer 汇总）。 */
  serverRejectionSignals: number;
}>): CombatSnapshot {
  const { observation, snapshot } = input;
  const self = observation.self;

  // 武器取观察里基础伤害最高的一把；cooldownProgress 无实时来源 → 0
  // （冷却刚开始 = 最低杀伤估计：影子模式宁可低估我方杀伤，不夸大）。
  const bestWeapon = [...observation.weapons].sort(
    (left, right) => right.baseDamage - left.baseDamage,
  )[0];

  // 吸收/药水效果/最近挫折/目标上下文/背包估值/死亡回收可行性均无运行时
  // 来源（partial-wiring）：吸收 0、效果空、setbacks 0、估值 NORMAL、
  // 回收不可行（放大死亡成本，偏保守）。
  const inventoryValueBand: InventoryValueBand = "NORMAL";
  const escapeRoutes: readonly EscapeRoute[] = [];

  const entities = observation.entities;
  const target = entities.length > 0
    ? beliefFromObservation(entities[0] as CombatDriverObservation["entities"][number], input.nowMonotonicMs)
    : null;

  return {
    nowMonotonicMs: input.nowMonotonicMs,
    stepMs: input.stepMs,
    self: {
      health: finiteOr(self.health, 20),
      absorption: 0,
      food: finiteOr(snapshot.food?.level, 20),
      effects: [],
      armor: {
        points: finiteOr(snapshot.armorPoints, 0),
        toughness: 0,
        durabilityCritical: false,
      },
      weapon: {
        id: bestWeapon?.itemName ?? "unarmed",
        cooldownProgress: 0,
      },
      offhand: { item: null, totemReady: self.offhandIsTotem === true },
      totemsAvailable: Math.max(0, finiteOr(self.inventoryTotemCount, 0)),
      consumables: {
        goldenApples: countInventoryItem(snapshot, "golden_apple"),
        healingPotions: 0,
        shieldDurabilityOk: true,
      },
      crystalMaterials: {
        crystals: countInventoryItem(snapshot, "end_crystal"),
        obsidian: countInventoryItem(snapshot, "obsidian"),
        glowstone: countInventoryItem(snapshot, "glowstone"),
      },
      onGround: self.onGround === true,
      inWater: snapshot.safety?.inWater === true,
      position: self.position,
      nearestCover: { distanceBlocks: null },
      escapeRoutes,
      pingMs: finiteOr(snapshot.latencyMs, finiteOr(observation.latencyMs, 0)),
      rttEstimateMs: finiteOr(snapshot.latencyMs, finiteOr(observation.latencyMs, 0)),
      recentSetbacks: 0,
      goal: { criticalInventory: false, migrating: false },
      inventoryValueBand,
      deathRecoveryFeasible: false,
      stance: input.stance,
    },
    target,
    otherEnemies: entities
      .slice(1, 1 + MAX_OTHER_ENEMY_BELIEFS)
      .map((entity) => beliefFromObservation(entity, input.nowMonotonicMs)),
    // 多 bot 阵营身份在 runtime 内无来源（wiring-pending：需要 coordinator
    // 的队伍视图），空数组 = 无支援可用——utility 对 CALL_SUPPORT 诚实降权。
    allies: [],
    world: {
      dimension: dimensionOf(observation.dimension),
      crystalPlacementsAvailable: Array.isArray(observation.crystalCandidates)
        ? observation.crystalCandidates.length
        : 0,
      enemyCrystalThreat: entities.some((entity) => entity.crystalNearby),
      enemyAnchorThreat: entities.some((entity) => entity.anchorNearby),
      hostileCount: entities.length,
      reinforcementEtaMs: null,
    },
    policy: {
      gameplayProfile: input.gameplayProfile,
      compatMode: input.compatMode,
      // Round 7 兼容 feature gates 尚未在 runtime 内持有实例（wiring-pending），
      // 爆炸物/重生锚门按 fail-closed 关闭。
      explosiveCrystalGateOpen: false,
      respawnAnchorGateOpen: false,
      serverRejectionSignals: Math.max(0, Math.floor(input.serverRejectionSignals)),
    },
  };
}

export { emergencySignalFromObservation, DEFAULT_TACTICS_PROFILE as SHADOW_TACTICS_PROFILE };
