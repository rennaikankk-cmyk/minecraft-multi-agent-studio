/**
 * ThreatAnalyzer —— 战术级（T，≤200ms）纯函数威胁评估。零 AI。
 *
 * 输入是注入的快照（自带 `observedAtMs`，本模块从不读时钟），输出是每个敌对
 * 实体的威胁分与整场战斗的态势判断。**只回答"有多危险"，不回答"打不打"**
 * ——是否交战由 TargetSelector / RetreatController 用这里的输出决定。
 *
 * 阵营判定全部委托给 CombatIdentityRegistry：本模块不重新实现敌我识别，
 * 也不接受调用方直接塞进来的 "hostile" 标签。
 */

import {
  type CombatAllegiance,
  type CombatEntity,
  type CombatIdentityRegistry,
} from "./identity.js";
import { BLAST_POWER, entityRangeFor } from "./blast-model.js";

export type CombatVector3 = Readonly<{ x: number; y: number; z: number }>;

export type CombatEntityObservation = Readonly<{
  entity: CombatEntity;
  position: CombatVector3;
  /** 每格/秒的速度分量；观测不到时为 null（按静止处理，不按最坏处理）。 */
  velocity: CombatVector3 | null;
  /** 目标当前生命，观测不到时为 null。 */
  health: number | null;
  /** 敌方护甲点数（0–20），观测不到时为 null。 */
  armorPoints: number | null;
  /** 敌方是否手持可造成高伤的物品（剑/斧/弩等）。观测不到按 false。 */
  wieldingWeapon: boolean;
  /** 视线内是否已有敌方放置的末影水晶。 */
  crystalNearby: boolean;
  /** 视线内是否已有敌方放置的重生锚；未知必须显式填 false。 */
  anchorNearby: boolean;
  /** 该实体是否刚触发图腾；只由服务端 entity_status 事件产生。 */
  recentlyPopped?: boolean;
}>;

export type CombatThreatSnapshot = Readonly<{
  observedAtMs: number;
  serverProfileId: string;
  selfPosition: CombatVector3;
  selfHealth: number;
  /** 副手图腾数 + 背包图腾数，决定能吃几次致命伤。 */
  totemCount: number;
  entities: readonly CombatEntityObservation[];
}>;

export type CombatThreatLevel = "none" | "low" | "elevated" | "critical";

export type CombatThreat = Readonly<{
  entityId: number;
  allegiance: CombatAllegiance;
  /** 0–100 的确定性威胁分，越高越危险。 */
  score: number;
  distance: number;
  /** 正数表示正在接近（格/秒），null 表示速度不可观测。 */
  closingSpeed: number | null;
  /** 触发加分的确定性原因码，便于日志与单测断言。 */
  reasons: readonly CombatThreatReason[];
}>;

export type CombatThreatReason =
  | "WITHIN_CRYSTAL_RANGE"
  | "WITHIN_MELEE_RANGE"
  | "CLOSING_FAST"
  | "CRYSTAL_PLACED"
  | "ANCHOR_PLACED"
  | "ARMED"
  | "HEAVILY_ARMORED"
  | "TARGET_RECENTLY_POPPED"
  | "IDENTITY_UNKNOWN";

export type CombatThreatAssessment = Readonly<{
  evaluatedAtMs: number;
  level: CombatThreatLevel;
  /** 按威胁分降序、同分按 entityId 升序，保证输出完全确定。 */
  threats: readonly CombatThreat[];
  hostileCount: number;
  /** 图腾余量为 0 时为 true —— §1 的失败降级信号。 */
  totemDepleted: boolean;
}>;

/** Keep threat range tied to the shared explosion power instead of a second magic number. */
const CRYSTAL_RANGE = entityRangeFor(BLAST_POWER.crystal);
const ANCHOR_RANGE = entityRangeFor(BLAST_POWER.anchor);
/** 近战可达距离，按原版 3 格判定（本模块只做威胁评估，不做 reach 校验）。 */
const MELEE_RANGE = 3;
const CLOSING_FAST_BLOCKS_PER_SECOND = 4;
const HEAVY_ARMOR_POINTS = 15;

// The entity range is now the real 12 blocks rather than the old 6-block
// approximation. Range alone is context, not an immediate retreat trigger;
// a placed crystal/weapon/closing speed must compound it into elevation.
const SCORE_WITHIN_CRYSTAL_RANGE = 15;
const SCORE_WITHIN_MELEE_RANGE = 25;
const SCORE_CLOSING_FAST = 15;
const SCORE_CRYSTAL_PLACED = 25;
const SCORE_ANCHOR_PLACED = 25;
const SCORE_ARMED = 10;
const SCORE_HEAVILY_ARMORED = 5;
// Large enough to reorder comparable targets, but an immediate crystal/melee
// threat can still outrank a distant POP target.
const SCORE_TARGET_RECENTLY_POPPED = 35;
const SCORE_IDENTITY_UNKNOWN = 5;

const CRITICAL_SCORE = 70;
const ELEVATED_SCORE = 40;

function distanceBetween(a: CombatVector3, b: CombatVector3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * 目标速度在"指向自己"方向上的投影。正数表示正在接近。
 * 距离为 0 时方向未定义，返回 null 而不是除以 0。
 */
function closingSpeedTowardSelf(
  observation: CombatEntityObservation,
  selfPosition: CombatVector3,
  distance: number,
): number | null {
  const velocity = observation.velocity;
  if (velocity === null || distance === 0) return null;
  const toSelf = {
    x: (selfPosition.x - observation.position.x) / distance,
    y: (selfPosition.y - observation.position.y) / distance,
    z: (selfPosition.z - observation.position.z) / distance,
  };
  return velocity.x * toSelf.x + velocity.y * toSelf.y + velocity.z * toSelf.z;
}

export class ThreatAnalyzer {
  constructor(private readonly identity: CombatIdentityRegistry) {}

  /**
   * 纯函数：同一份快照永远得到同一份评估，无内部可变状态。
   * 服号不匹配时 `classify` 抛 IDENTITY_SERVER_PROFILE_MISMATCH，不吞。
   */
  assess(snapshot: CombatThreatSnapshot): CombatThreatAssessment {
    validateThreatSnapshot(snapshot);
    const threats: CombatThreat[] = [];

    for (const observation of snapshot.entities) {
      const allegiance = this.identity.classify(
        observation.entity,
        snapshot.serverProfileId,
      );
      if (allegiance !== "hostile") continue;

      const distance = distanceBetween(
        observation.position,
        snapshot.selfPosition,
      );
      const closingSpeed = closingSpeedTowardSelf(
        observation,
        snapshot.selfPosition,
        distance,
      );
      const reasons: CombatThreatReason[] = [];
      let score = 0;

      if (distance <= CRYSTAL_RANGE) {
        reasons.push("WITHIN_CRYSTAL_RANGE");
        score += SCORE_WITHIN_CRYSTAL_RANGE;
      }
      if (distance <= MELEE_RANGE) {
        reasons.push("WITHIN_MELEE_RANGE");
        score += SCORE_WITHIN_MELEE_RANGE;
      }
      if (
        closingSpeed !== null &&
        closingSpeed >= CLOSING_FAST_BLOCKS_PER_SECOND
      ) {
        reasons.push("CLOSING_FAST");
        score += SCORE_CLOSING_FAST;
      }
      if (observation.crystalNearby) {
        reasons.push("CRYSTAL_PLACED");
        score += SCORE_CRYSTAL_PLACED;
      }
      if (distance <= ANCHOR_RANGE && observation.anchorNearby) {
        reasons.push("ANCHOR_PLACED");
        score += SCORE_ANCHOR_PLACED;
      }
      if (observation.wieldingWeapon) {
        reasons.push("ARMED");
        score += SCORE_ARMED;
      }
      if (
        observation.armorPoints !== null &&
        observation.armorPoints >= HEAVY_ARMOR_POINTS
      ) {
        reasons.push("HEAVILY_ARMORED");
        score += SCORE_HEAVILY_ARMORED;
      }
      if (observation.recentlyPopped === true) {
        reasons.push("TARGET_RECENTLY_POPPED");
        score += SCORE_TARGET_RECENTLY_POPPED;
      }
      // 认不出身份不是"没威胁"，是"信息缺失"，按略高处理。
      if (observation.entity.username === null && observation.entity.uuid === null) {
        reasons.push("IDENTITY_UNKNOWN");
        score += SCORE_IDENTITY_UNKNOWN;
      }

      threats.push({
        entityId: observation.entity.entityId,
        allegiance,
        score: Math.min(100, score),
        distance,
        closingSpeed,
        reasons,
      });
    }

    threats.sort((a, b) =>
      b.score - a.score || a.distance - b.distance || a.entityId - b.entityId,
    );

    const topScore = threats[0]?.score ?? 0;
    return {
      evaluatedAtMs: snapshot.observedAtMs,
      level: threats.length === 0
        ? "none"
        : topScore >= CRITICAL_SCORE
          ? "critical"
          : topScore >= ELEVATED_SCORE
            ? "elevated"
            : "low",
      threats,
      hostileCount: threats.length,
      totemDepleted: snapshot.totemCount === 0,
    };
  }
}

function validateThreatSnapshot(snapshot: CombatThreatSnapshot): void {
  if (snapshot.serverProfileId.trim().length === 0) {
    throw new TypeError("威胁快照必须携带 serverProfileId。");
  }
  finiteNumber(snapshot.observedAtMs, "observedAtMs");
  finiteNumber(snapshot.selfHealth, "selfHealth");
  if (!Number.isInteger(snapshot.totemCount) || snapshot.totemCount < 0) {
    throw new TypeError("totemCount 必须是非负整数。");
  }
  validateVector(snapshot.selfPosition, "selfPosition");
  for (const observation of snapshot.entities) {
    validateVector(observation.position, "entity.position");
    if (observation.velocity !== null) {
      validateVector(observation.velocity, "entity.velocity");
    }
    if (observation.health !== null) {
      finiteNumber(observation.health, "entity.health");
    }
    if (observation.armorPoints !== null) {
      finiteNumber(observation.armorPoints, "entity.armorPoints");
    }
    if (
      typeof observation.anchorNearby !== "boolean" ||
      observation.recentlyPopped !== undefined &&
      typeof observation.recentlyPopped !== "boolean"
    ) {
      throw new TypeError("entity.recentlyPopped 必须是布尔值。");
    }
  }
}

function validateVector(vector: CombatVector3, name: string): void {
  finiteNumber(vector.x, `${name}.x`);
  finiteNumber(vector.y, `${name}.y`);
  finiteNumber(vector.z, `${name}.z`);
}

function finiteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} 必须是有限数。`);
  }
}
