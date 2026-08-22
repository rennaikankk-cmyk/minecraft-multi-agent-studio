/**
 * TargetSelector —— 战术级（T，≤200ms）确定性目标选择。零 AI。
 *
 * 职责边界很窄：**在已判定为敌对的实体里挑一个打，或者判定现在谁都不该打。**
 * 敌我识别不在这里（CombatIdentityRegistry 已经做完，本模块只消费威胁评估的
 * 输出）；怎么撤退也不在这里（RetreatController 的事）。
 *
 * AGENTS.md §0.2：AI 只决定"是否交战/脱离"的**阈值**，交战阈值以参数形式注入
 * （`CombatEngagementPolicy`），本模块按参数做确定性算术。AI 不能在这里直接
 * 指定打谁——`select` 不接受任何"指定目标"入参。
 *
 * "打得过就打，打不过先保命"落在 `refusal` 上：血量、图腾余量、敌方数量、装备差
 * 四条硬闸门任意一条不过，就返回 null 目标 + 拒绝原因码，交由上层撤退。
 */

import type { CombatGearAssessment } from "./gear-assessor.js";
import {
  DEFAULT_SURVIVAL_STANCE,
  totemAbsenceForcesRetreat,
  validateSurvivalStance,
  type CombatSurvivalStance,
} from "./survival-stance.js";
import type { CombatThreat, CombatThreatAssessment } from "./threat-analyzer.js";

export type CombatEngagementPolicy = Readonly<{
  /** 生命低于此值一律不主动交战（保命优先）。 */
  minimumEngageHealth: number;
  /** 图腾余量低于此值一律不主动交战。0 表示不要求图腾。 */
  minimumTotemCount: number;
  /** 同时可交战的敌人上限；超过即视为寡不敌众。 */
  maximumHostileCount: number;
  /** 超过此距离不视为可交战目标（格）。 */
  maximumEngageDistance: number;
  /**
   * 存活立场。`expendable` 时跳过图腾余量闸门 —— 否则一个立场已经设成可弃、
   * 却忘了把 `minimumTotemCount` 改成 0 的 bot 仍然一枪都开不出来，这种"改了
   * 一半"的配置比直接报错更难查。血量与人数闸门不受立场影响。
   */
  stance: CombatSurvivalStance;
  /**
   * 是否让装备差参与交战判定。true 时 `select` 收到 `shouldAvoid` 的装备评估
   * 即拒绝交战。骚扰型/可弃 bot 可以关掉——它的目的不是打赢。
   */
  respectGearGap: boolean;
}>;

/** 有确定性数值边界的策略字段。`stance` 是枚举，单独校验。 */
type CombatEngagementPolicyNumericKey =
  | "minimumEngageHealth"
  | "minimumTotemCount"
  | "maximumHostileCount"
  | "maximumEngageDistance";

export type CombatTargetRefusalCode =
  | "NO_HOSTILE_IN_RANGE"
  | "HEALTH_BELOW_ENGAGE_FLOOR"
  | "TOTEM_RESERVE_INSUFFICIENT"
  | "OUTNUMBERED"
  | "GEAR_OUTCLASSED";

export type CombatTargetDecision = Readonly<{
  evaluatedAtMs: number;
  /** 选中的目标；不该打时为 null。 */
  target: CombatThreat | null;
  /** 未选中目标的确定性原因；选中时为 null。 */
  refusal: CombatTargetRefusalCode | null;
  /** 射程内的敌对数量，供撤退逻辑与日志使用。 */
  engageableCount: number;
}>;

/**
 * 交战策略的确定性边界。AI 给的阈值必须落在这个区间内，越界即拒绝——
 * 这是"AI 只能调阈值、不能取消保命"的运行时保障，而不是文档承诺。
 */
const POLICY_BOUNDS = {
  minimumEngageHealth: { minimum: 1, maximum: 20 },
  minimumTotemCount: { minimum: 0, maximum: 36 },
  maximumHostileCount: { minimum: 1, maximum: 32 },
  maximumEngageDistance: { minimum: 1, maximum: 64 },
} as const;

export const DEFAULT_ENGAGEMENT_POLICY: CombatEngagementPolicy = {
  minimumEngageHealth: 12,
  minimumTotemCount: 1,
  maximumHostileCount: 3,
  maximumEngageDistance: 24,
  stance: DEFAULT_SURVIVAL_STANCE,
  respectGearGap: true,
};

export class CombatPolicyError extends Error {
  readonly code = "ENGAGEMENT_POLICY_OUT_OF_BOUNDS";

  constructor(message: string) {
    super(message);
    this.name = "CombatPolicyError";
  }
}

export function validateEngagementPolicy(
  policy: CombatEngagementPolicy,
): CombatEngagementPolicy {
  for (const [key, bounds] of Object.entries(POLICY_BOUNDS)) {
    const value = policy[key as CombatEngagementPolicyNumericKey];
    if (
      !Number.isFinite(value) ||
      value < bounds.minimum ||
      value > bounds.maximum
    ) {
      throw new CombatPolicyError(
        `交战策略 ${key} 越界，拒绝使用该策略。`,
      );
    }
  }
  if (policy.stance !== "preserve-life" && policy.stance !== "expendable") {
    throw new CombatPolicyError("交战策略 stance 越界，拒绝使用该策略。");
  }
  if (typeof policy.respectGearGap !== "boolean") {
    throw new CombatPolicyError("交战策略 respectGearGap 必须是布尔值。");
  }
  validateSurvivalStance(policy.stance);
  return policy;
}

export class TargetSelector {
  private readonly policy: CombatEngagementPolicy;

  constructor(policy: CombatEngagementPolicy = DEFAULT_ENGAGEMENT_POLICY) {
    this.policy = validateEngagementPolicy(policy);
  }

  /**
   * 纯函数。`selfHealth` 与 `totemCount` 从威胁快照同源传入，避免本模块自己
   * 去读世界状态而与评估时刻脱节。
   */
  select(
    assessment: CombatThreatAssessment,
    selfHealth: number,
    totemCount: number,
    gear: CombatGearAssessment | null = null,
  ): CombatTargetDecision {
    if (!Number.isFinite(selfHealth) || selfHealth < 0) {
      throw new TypeError("selfHealth 必须是非负有限数。");
    }
    if (!Number.isInteger(totemCount) || totemCount < 0) {
      throw new TypeError("totemCount 必须是非负整数。");
    }

    const engageable = assessment.threats.filter(
      ({ distance }) => distance <= this.policy.maximumEngageDistance,
    );
    const decision = (
      target: CombatThreat | null,
      refusal: CombatTargetRefusalCode | null,
    ): CombatTargetDecision => ({
      evaluatedAtMs: assessment.evaluatedAtMs,
      target,
      refusal,
      engageableCount: engageable.length,
    });

    if (engageable.length === 0) return decision(null, "NO_HOSTILE_IN_RANGE");
    // 三条保命闸门的顺序是确定的：先看自己撑不撑得住，再看敌人多不多。
    if (selfHealth < this.policy.minimumEngageHealth) {
      return decision(null, "HEALTH_BELOW_ENGAGE_FLOOR");
    }
    if (
      totemAbsenceForcesRetreat(this.policy.stance) &&
      totemCount < this.policy.minimumTotemCount
    ) {
      return decision(null, "TOTEM_RESERVE_INSUFFICIENT");
    }
    if (engageable.length > this.policy.maximumHostileCount) {
      return decision(null, "OUTNUMBERED");
    }
    // 装备闸门放在最后：前面三条都过了才值得比装备。
    // 不传评估时不做判定 —— 不把"没看"当成"没差距"，由调用方决定是否观测。
    if (gear !== null && gear.shouldAvoid && this.policy.respectGearGap) {
      return decision(null, "GEAR_OUTCLASSED");
    }
    // 威胁评估已按 score → distance → entityId 排好序，取第一个即最高威胁。
    return decision(engageable[0] ?? null, null);
  }
}
