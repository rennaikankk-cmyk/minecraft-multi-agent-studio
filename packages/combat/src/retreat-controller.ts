/**
 * RetreatController —— 战术级（T，≤200ms）确定性撤退裁决。零 AI。
 *
 * 这是战斗侧的"保命优先"落点。docs/combat-tactics-reference.md §1/§4 的两条
 * 纪律在这里成为硬规则：
 *   - **背包无图腾 → 立即撤退/断线**，不继续战斗（§1 失败降级）。被显式配置成
 *     `expendable` 的 bot 例外：对它们「没图腾」不是降级信号，见
 *     survival-stance.ts。生命、寡不敌众、水晶三条闸门对两种立场一律生效。
 *   - **撤退优先级高于 surround、高于进攻**（§4 与移动的冲突）。
 *
 * 与 L0SafetyController 的分工：L0 管非战斗生存（岩浆、溺水、饥饿），本模块管
 * **敌情驱动**的脱离。两者可能同时要求暂停普通任务，互不覆盖——本模块的输出
 * 是建议动作，真正执行仍要过 ServerPolicyGate。
 *
 * 撤退方向是纯几何：远离敌方威胁的加权质心。选不出方向（敌人正好同位）时
 * 返回 null 而不是瞎给一个向量。
 */

import type { CombatGearAssessment } from "./gear-assessor.js";
import {
  DEFAULT_SURVIVAL_STANCE,
  totemAbsenceForcesRetreat,
  validateSurvivalStance,
  type CombatSurvivalStance,
} from "./survival-stance.js";
import type { CombatThreatAssessment } from "./threat-analyzer.js";
import type { CombatVector3 } from "./threat-analyzer.js";

export type CombatRetreatUrgency = "none" | "withdraw" | "emergency";

export type CombatRetreatReason =
  | "TOTEM_DEPLETED"
  | "HEALTH_CRITICAL"
  | "HEALTH_LOW"
  | "OUTNUMBERED"
  | "MOB_PACK_AVOIDABLE"
  | "CRYSTAL_THREAT"
  | "ANCHOR_THREAT"
  | "GEAR_OUTCLASSED";

export type CombatRetreatAction =
  | "DISENGAGE_MOVE"
  | "BREAK_LINE_OF_SIGHT"
  | "DISCONNECT";

export type CombatRetreatPolicy = Readonly<{
  /** 生命低于此值视为危急，触发 emergency 撤退。 */
  emergencyHealth: number;
  /** 生命低于此值触发普通撤退。 */
  withdrawHealth: number;
  /** 敌人数量超过此值触发撤退。 */
  outnumberedAbove: number;
  /** 无图腾时是否允许断线保命。false 则只做移动脱离。 */
  allowDisconnect: boolean;
  /**
   * 存活立场。`expendable` 时图腾耗尽不再作为撤退原因参与判定 —— 既不进
   * `reasons`，也就不会升级成 emergency、不会压制进攻。血量与人数照旧。
   */
  stance: CombatSurvivalStance;
  /**
   * 是否让装备差参与撤退判定。true 时 `evaluate` 收到 `shouldAvoid` 的装备评估
   * 会记入 `GEAR_OUTCLASSED`（普通 withdraw 级别，不升级为 emergency）。
   */
  respectGearGap: boolean;
  /**
   * G1 实战（2026-09-03 luv）：出生点僵尸群下，engage 先行、<8HP 才撤的
   * 阈值让 bot 在击杀区里边打边耗。对纯 mob（无玩家参与）威胁，
   * preserve-life 应零血量门槛立即抑制进攻——裸装打僵尸不买任何东西，
   * 疾跑才是正确答案（用户产品方向：逃，不是战）。
   */
  avoidMeleeMobPacks: boolean;
}>;

export const DEFAULT_RETREAT_POLICY: CombatRetreatPolicy = {
  emergencyHealth: 6,
  withdrawHealth: 12,
  outnumberedAbove: 3,
  allowDisconnect: true,
  stance: DEFAULT_SURVIVAL_STANCE,
  respectGearGap: true,
  avoidMeleeMobPacks: false,
};

export type CombatRetreatDecision = Readonly<{
  evaluatedAtMs: number;
  urgency: CombatRetreatUrgency;
  /** 触发撤退的全部原因，按严重度固定排序。 */
  reasons: readonly CombatRetreatReason[];
  /** 建议动作，按执行顺序；urgency 为 none 时为空。 */
  actions: readonly CombatRetreatAction[];
  /** 单位撤退方向；无法确定时为 null。 */
  direction: CombatVector3 | null;
  /** 撤退期间必须压制进攻与 surround（§4：撤退优先级更高）。 */
  suppressOffense: boolean;
}>;

const REASON_ORDER: readonly CombatRetreatReason[] = [
  "TOTEM_DEPLETED",
  "HEALTH_CRITICAL",
  "OUTNUMBERED",
  "MOB_PACK_AVOIDABLE",
  "CRYSTAL_THREAT",
  "ANCHOR_THREAT",
  "GEAR_OUTCLASSED",
  "HEALTH_LOW",
];

const EMERGENCY_REASONS: ReadonlySet<CombatRetreatReason> = new Set([
  "TOTEM_DEPLETED",
  "HEALTH_CRITICAL",
]);

export class RetreatController {
  private readonly policy: CombatRetreatPolicy;

  constructor(policy: CombatRetreatPolicy = DEFAULT_RETREAT_POLICY) {
    if (
      !Number.isFinite(policy.emergencyHealth) ||
      !Number.isFinite(policy.withdrawHealth) ||
      policy.emergencyHealth < 1 ||
      policy.withdrawHealth < policy.emergencyHealth ||
      policy.withdrawHealth > 20 ||
      !Number.isInteger(policy.outnumberedAbove) ||
      policy.outnumberedAbove < 1 ||
      typeof policy.respectGearGap !== "boolean"
    ) {
      throw new TypeError("撤退策略越界，拒绝使用该策略。");
    }
    validateSurvivalStance(policy.stance);
    this.policy = policy;
  }

  /**
   * 纯函数。`selfPosition` 必须与 assessment 同源快照，否则撤退方向会指向
   * 一个已经不存在的战场布局。
   */
  evaluate(
    assessment: CombatThreatAssessment,
    selfHealth: number,
    selfPosition: CombatVector3,
    hostilePositions: ReadonlyMap<number, CombatVector3>,
    gear: CombatGearAssessment | null = null,
  ): CombatRetreatDecision {
    if (!Number.isFinite(selfHealth) || selfHealth < 0) {
      throw new TypeError("selfHealth 必须是非负有限数。");
    }

    const detected = new Set<CombatRetreatReason>();
    // 无图腾是最高优先级降级信号，与敌人多少无关 —— 但对可弃 bot 不成立。
    if (
      assessment.totemDepleted &&
      totemAbsenceForcesRetreat(this.policy.stance)
    ) {
      detected.add("TOTEM_DEPLETED");
    }
    if (selfHealth < this.policy.emergencyHealth) detected.add("HEALTH_CRITICAL");
    else if (selfHealth < this.policy.withdrawHealth) detected.add("HEALTH_LOW");
    if (assessment.hostileCount > this.policy.outnumberedAbove) {
      detected.add("OUTNUMBERED");
    }
    // G1 加固：纯 mob（无玩家参与）威胁 + 策略开启 → 立即撤，零血量门槛。
    // 出生点僵尸群场景：裸装疾跑脱离比交战便宜且安全。
    if (
      this.policy.avoidMeleeMobPacks &&
      assessment.hostileCount > 0 &&
      assessment.threats.length > 0 &&
      assessment.threats.every((threat) => threat.entityKind !== "player")
    ) {
      detected.add("MOB_PACK_AVOIDABLE");
    }
    if (
      assessment.threats.some(({ reasons }) => reasons.includes("CRYSTAL_PLACED"))
    ) {
      detected.add("CRYSTAL_THREAT");
    }
    if (
      assessment.threats.some(({ reasons }) => reasons.includes("ANCHOR_PLACED"))
    ) {
      detected.add("ANCHOR_THREAT");
    }
    // 装备被压制：普通撤退原因，不是 emergency —— 装备差是"这架不该打"，
    // 不是"下一击会死"。两者混同会让每次遇到满配玩家都触发断线。
    if (gear !== null && gear.shouldAvoid && this.policy.respectGearGap) {
      detected.add("GEAR_OUTCLASSED");
    }

    // 场上没有敌人时，图腾耗尽仍值得撤离补给，但不算紧急交战脱离。
    const engaged = assessment.hostileCount > 0;
    const reasons = REASON_ORDER.filter((reason) => detected.has(reason));
    if (reasons.length === 0) {
      return {
        evaluatedAtMs: assessment.evaluatedAtMs,
        urgency: "none",
        reasons: [],
        actions: [],
        direction: null,
        suppressOffense: false,
      };
    }

    const emergency =
      engaged && reasons.some((reason) => EMERGENCY_REASONS.has(reason));
    const actions: CombatRetreatAction[] = ["DISENGAGE_MOVE"];
    if (emergency) {
      actions.push("BREAK_LINE_OF_SIGHT");
      // 断线是最后手段：只有图腾耗尽且策略允许时才建议。
      if (detected.has("TOTEM_DEPLETED") && this.policy.allowDisconnect) {
        actions.push("DISCONNECT");
      }
    }

    return {
      evaluatedAtMs: assessment.evaluatedAtMs,
      urgency: emergency ? "emergency" : "withdraw",
      reasons,
      actions,
      direction: awayFromThreats(
        assessment,
        selfPosition,
        hostilePositions,
      ),
      // 一旦决定撤退就压制进攻与 surround，不留"边打边撤"的歧义。
      suppressOffense: true,
    };
  }
}

/**
 * 远离威胁的单位方向：以威胁分为权重的质心反向。
 * 只用有位置记录的敌人；质心与自己重合时返回 null。
 */
function awayFromThreats(
  assessment: CombatThreatAssessment,
  selfPosition: CombatVector3,
  hostilePositions: ReadonlyMap<number, CombatVector3>,
): CombatVector3 | null {
  let weightSum = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const threat of assessment.threats) {
    const position = hostilePositions.get(threat.entityId);
    if (!position) continue;
    // 权重下限 1，避免 score 为 0 的敌人被完全忽略。
    const weight = Math.max(1, threat.score);
    weightSum += weight;
    x += position.x * weight;
    y += position.y * weight;
    z += position.z * weight;
  }
  if (weightSum === 0) return null;

  const away = {
    x: selfPosition.x - x / weightSum,
    y: selfPosition.y - y / weightSum,
    z: selfPosition.z - z / weightSum,
  };
  const magnitude = Math.hypot(away.x, away.y, away.z);
  if (magnitude === 0) return null;
  return { x: away.x / magnitude, y: away.y / magnitude, z: away.z / magnitude };
}
