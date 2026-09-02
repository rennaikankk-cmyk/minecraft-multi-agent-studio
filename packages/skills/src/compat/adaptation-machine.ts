// ---------------------------------------------------------------------------
// Round 7 —— Deterministic Adaptation State Machine。
//
// 状态：UNKNOWN → BASELINING → STABLE → DEGRADED → RESTRICTED → RECOVERING
// 判据全部确定性（窗口计数+阈值），无"模型觉得像反作弊"。
// 滞回/冷却/单窗最大降一级、单窗最多升一级；EXPLICIT_UNRESTRICTED 的
// desired 不被观测降级为"更低 desired"——只降 effective，operator 语义保留。
// ---------------------------------------------------------------------------

import type { ActionFamily, ServerBehaviorProfile, ServerCompatibilityMode } from "./server-behavior-profile.js";
import type { FamilyWindowStats } from "./behavior-observer.js";

export const ADAPTATION_STATES = [
  "UNKNOWN",
  "BASELINING",
  "STABLE",
  "DEGRADED",
  "RESTRICTED",
  "RECOVERING",
] as const;
export type AdaptationState = (typeof ADAPTATION_STATES)[number];

export interface AdaptationThresholds {
  /** 窗口内同 family 拒绝+纠正达到该数 → 降一级。 */
  downgradeSignalCount: number;
  /** 降级后进入下一评估前的最小等待（ms）。 */
  downgradeCooldownMs: number;
  /** 连续多少个干净窗口后才允许升一级。 */
  recoveryCleanWindows: number;
  /** 升级评估间隔（ms）。 */
  recoveryIntervalMs: number;
  /** 进入 BASELINING 的最小样本量。 */
  minSamplesForBaseline: number;
  /** STABLE 所需最小样本量。 */
  minSamplesForStable: number;
}

export const DEFAULT_ADAPTATION_THRESHOLDS: Readonly<AdaptationThresholds> = Object.freeze({
  downgradeSignalCount: 3,
  downgradeCooldownMs: 30_000,
  recoveryCleanWindows: 3,
  recoveryIntervalMs: 60_000,
  minSamplesForBaseline: 10,
  minSamplesForStable: 50,
});

const MODE_ORDER: readonly ServerCompatibilityMode[] = Object.freeze([
  // 保守 → 高性能
  "UNKNOWN_FAIL_CLOSED",
  "CONSERVATIVE",
  "VANILLA",
  "ADAPTIVE",
  "EXPLICIT_UNRESTRICTED",
]);

export interface AdaptationDecision {
  readonly state: AdaptationState;
  readonly effectiveMode: ServerCompatibilityMode;
  readonly reason: string;
  /** 事件原因（降级触发 family），供 profile.downgradeReason。 */
  readonly triggeredBy?: ActionFamily | undefined;
  readonly confidence: number;
}

export interface AdaptationMachineInput {
  readonly state: AdaptationState;
  readonly effectiveMode: ServerCompatibilityMode;
  readonly desiredMode: ServerCompatibilityMode;
  /** 窗口内最差 family 的信号计数集合（由调用方从 observer 汇总）。 */
  readonly familyStats: Readonly<Record<string, FamilyWindowStats>>;
  readonly totalSamples: number;
  readonly nowMonotonicMs: number;
  readonly lastStateChangeMs: number;
  /** 自上次降级以来的连续干净窗口数。 */
  readonly cleanWindowsSinceDowngrade: number;
  readonly thresholds?: Partial<AdaptationThresholds>;
}

function stepDown(mode: ServerCompatibilityMode): ServerCompatibilityMode {
  const index = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[Math.max(0, index - 1)]!;
}

function stepUp(mode: ServerCompatibilityMode, ceiling: ServerCompatibilityMode): ServerCompatibilityMode {
  const index = MODE_ORDER.indexOf(mode);
  const ceilingIndex = MODE_ORDER.indexOf(ceiling);
  return MODE_ORDER[Math.min(ceilingIndex, index + 1)]!;
}

/** 纯函数状态机：同一输入永远同一输出（可回放）。 */
export function evaluateAdaptation(input: AdaptationMachineInput): AdaptationDecision {
  const thresholds: AdaptationThresholds = {
    ...DEFAULT_ADAPTATION_THRESHOLDS,
    ...(input.thresholds ?? {}),
  };

  // 1) 找最差 family（corrections+rejections+divergences 最大者）
  let worstFamily: ActionFamily | undefined;
  let worstSignals = 0;
  let worstTotal = 0;
  for (const [family, stats] of Object.entries(input.familyStats)) {
    const signals = stats.corrections + stats.rejections + stats.divergences;
    if (signals > worstSignals) {
      worstSignals = signals;
      worstFamily = family as ActionFamily;
      worstTotal = stats.total;
    }
  }

  // 2) 样本推进：UNKNOWN → BASELINING → STABLE
  if (input.state === "UNKNOWN") {
    if (input.totalSamples >= thresholds.minSamplesForBaseline) {
      return {
        state: "BASELINING",
        effectiveMode: input.effectiveMode,
        reason: `samples=${input.totalSamples} reached baseline threshold`,
        confidence: 0.3,
      };
    }
    return { state: "UNKNOWN", effectiveMode: input.effectiveMode, reason: "insufficient samples", confidence: 0 };
  }

  // 3) RESTRICTED 先判：已 DEGRADED 且持续高压（信号 >= 2x 阈值）——
  //    若不先判，下面的普通降级分支会先命中并再次返回 DEGRADED。
  const inDowngradeCooldown =
    input.nowMonotonicMs - input.lastStateChangeMs < thresholds.downgradeCooldownMs;
  if (
    input.state === "DEGRADED" &&
    worstSignals >= thresholds.downgradeSignalCount * 2 &&
    worstFamily !== undefined &&
    !inDowngradeCooldown
  ) {
    return {
      state: "RESTRICTED",
      effectiveMode: stepDown(input.effectiveMode),
      reason: `${worstFamily} sustained pressure signals=${worstSignals}`,
      triggeredBy: worstFamily,
      confidence: 0.8,
    };
  }

  // 4) 普通降级：窗口内最差 family 信号超阈 + 冷却已过
  const shouldDowngrade =
    worstSignals >= thresholds.downgradeSignalCount && !inDowngradeCooldown;
  if (shouldDowngrade && worstFamily !== undefined) {
    const nextMode = stepDown(input.effectiveMode);
    return {
      state: "DEGRADED",
      effectiveMode: nextMode,
      reason: `${worstFamily} signals=${worstSignals}/${worstTotal} over threshold ${thresholds.downgradeSignalCount}`,
      triggeredBy: worstFamily,
      confidence: Math.min(1, 0.4 + worstSignals / (thresholds.downgradeSignalCount * 4)),
    };
  }

  // 5) 恢复：连续干净窗口 + 间隔已过 + 最多升一级（不越过 desired）
  const inRecoveryInterval =
    input.nowMonotonicMs - input.lastStateChangeMs < thresholds.recoveryIntervalMs;
  const canRecover =
    (input.state === "DEGRADED" || input.state === "RESTRICTED" || input.state === "RECOVERING") &&
    input.cleanWindowsSinceDowngrade >= thresholds.recoveryCleanWindows &&
    !inRecoveryInterval &&
    input.effectiveMode !== input.desiredMode;
  if (canRecover) {
    return {
      state: "RECOVERING",
      effectiveMode: stepUp(input.effectiveMode, input.desiredMode),
      reason: `${input.cleanWindowsSinceDowngrade} clean windows`,
      confidence: 0.6,
    };
  }

  // 6) STABLE 推进
  if (
    (input.state === "BASELINING" || input.state === "RECOVERING") &&
    input.totalSamples >= thresholds.minSamplesForStable &&
    worstSignals === 0
  ) {
    return {
      state: "STABLE",
      effectiveMode: input.effectiveMode,
      reason: `stable with ${input.totalSamples} samples`,
      confidence: Math.min(1, input.totalSamples / (thresholds.minSamplesForStable * 4)),
    };
  }

  // 7) 稳态维持
  return {
    state: input.state === "RECOVERING" ? "RECOVERING" : input.state,
    effectiveMode: input.effectiveMode,
    reason: "no state change",
    confidence: Math.min(1, input.totalSamples / (thresholds.minSamplesForStable * 4)),
  };
}

/** 将决策写回 profile（不可变更新 + revision 递增）。 */
export function applyAdaptationDecision(
  profile: ServerBehaviorProfile,
  decision: AdaptationDecision,
  familyStats: Readonly<Record<string, { corrections: number; rejections: number; divergences: number }>>,
  nowIso?: string,
): ServerBehaviorProfile {
  const now = nowIso ?? new Date().toISOString();
  const changed = decision.effectiveMode !== profile.effectiveMode;
  return {
    ...profile,
    effectiveMode: decision.effectiveMode,
    confidence: decision.confidence,
    lastObservedAt: now,
    sampleCount: profile.sampleCount + Object.values(familyStats).reduce((s, f) => s + f.corrections + f.rejections + f.divergences, 0),
    actionFamilySignals: { ...familyStats },
    ...(decision.triggeredBy !== undefined
      ? { downgradeReason: `${decision.triggeredBy}: ${decision.reason}` }
      : {}),
    ...(decision.state === "RECOVERING" ? { recoveryReason: decision.reason } : {}),
    revision: changed ? profile.revision + 1 : profile.revision,
  };
}
