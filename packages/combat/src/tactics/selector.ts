// ---------------------------------------------------------------------------
// tactics/selector.ts —— 动作选择器：滞回 / 最小承诺 / 紧急中断（研究 §11.4）。
//
// 防 PRESS↔DISENGAGE 每 tick 抖动的机制化：
//   - 承诺期内只有紧急谓词可换动作；
//   - 承诺期满后换动作需要效用差超过 hysteresisDelta；
//   - evidence revision（pop/治疗/新敌入 reach/红线）是紧急级。
// 纯函数：输入 (verdict, previousDecision, snapshot) → 新裁决，可回放。
// ---------------------------------------------------------------------------

import type { TacticalActionId, TacticsProfile } from "./profile.js";
import type { ActionScore, UtilityVerdict } from "./utility.js";
import type { CombatSnapshot } from "./snapshot.js";

export type SwitchReason =
  | "INITIAL"
  | "COMMITMENT_EXPIRED"
  | "NEW_UTILITY_DELTA"
  | "EMERGENCY"
  | "STALE_INVALIDATION"
  | "PREVIOUS_UNAVAILABLE";

export type TacticalDecision = Readonly<{
  action: TacticalActionId;
  previousAction: TacticalActionId | null;
  switched: boolean;
  switchReason: SwitchReason | null;
  /** 当前动作的承诺截止（相对 nowMonotonicMs）；紧急中断可提前。 */
  commitUntilMs: number;
  chosenScore: ActionScore | null;
}>;

export type EmergencySignal =
  | "TOTEM_POP_EVENT"
  | "NEW_ENEMY_IN_REACH"
  | "RED_LINE_TRIP"
  | "REFLEX_INTERRUPT"
  | "ENEMY_HEAL_OBSERVED"
  | "SUPPORT_LOST";

function commitmentMs(action: TacticalActionId, profile: TacticsProfile, nowMs: number): number {
  const ms =
    action === "KILL_SECURE" ? profile.selector.killSecureCommitMs
    : action === "HEAL" ? profile.selector.healCommitMs
    : profile.selector.minCommitMs;
  return nowMs + ms;
}

/** 紧急判定：这些信号无条件打断承诺（研究 §11.4 evidence revision）。 */
export function isEmergency(input: {
  snapshot: CombatSnapshot;
  signal: EmergencySignal | null;
}): boolean {
  return input.signal !== null;
}

export function selectTacticalAction(input: {
  verdict: UtilityVerdict;
  snapshot: CombatSnapshot;
  profile: TacticsProfile;
  previous: TacticalDecision | null;
  emergencySignal: EmergencySignal | null;
}): TacticalDecision {
  const { verdict, snapshot, profile, previous, emergencySignal } = input;
  const now = snapshot.nowMonotonicMs;
  const best = verdict.best;

  if (best === null) {
    return Object.freeze({
      action: "HOLD",
      previousAction: previous?.action ?? null,
      switched: previous !== null && previous.action !== "HOLD",
      switchReason: previous === null ? null : "PREVIOUS_UNAVAILABLE",
      commitUntilMs: now + profile.selector.minCommitMs,
      chosenScore: null,
    });
  }

  if (previous === null) {
    return Object.freeze({
      action: best.action,
      previousAction: null,
      switched: false,
      switchReason: "INITIAL",
      commitUntilMs: commitmentMs(best.action, profile, now),
      chosenScore: best,
    });
  }

  const inCommitment = now < previous.commitUntilMs;
  const emergency = isEmergency({ snapshot, signal: emergencySignal });

  if (previous.action === best.action) {
    // 续期：同动作不换，但承诺窗重算（滑动）。
    return Object.freeze({
      action: previous.action,
      previousAction: previous.action,
      switched: false,
      switchReason: null,
      commitUntilMs: Math.max(previous.commitUntilMs, commitmentMs(previous.action, profile, now)),
      chosenScore: best,
    });
  }

  if (emergency) {
    return Object.freeze({
      action: best.action,
      previousAction: previous.action,
      switched: true,
      switchReason: "EMERGENCY",
      commitUntilMs: commitmentMs(best.action, profile, now),
      chosenScore: best,
    });
  }

  if (inCommitment) {
    // 承诺期内非紧急：维持原动作——即使新效用略高。
    const previousScore = verdict.scores.find((score) => score.action === previous.action);
    if (previousScore !== undefined && previousScore.hardBlockedBy === null) {
      return Object.freeze({
        action: previous.action,
        previousAction: previous.action,
        switched: false,
        switchReason: null,
        commitUntilMs: previous.commitUntilMs,
        chosenScore: previousScore,
      });
    }
    // 原动作被硬阻塞（门关了/目标没了）→ 承诺失效。
    return Object.freeze({
      action: best.action,
      previousAction: previous.action,
      switched: true,
      switchReason: "STALE_INVALIDATION",
      commitUntilMs: commitmentMs(best.action, profile, now),
      chosenScore: best,
    });
  }

  const previousScore = verdict.scores.find((score) => score.action === previous.action);
  const delta = previousScore !== undefined ? best.utility - previousScore.utility : Number.POSITIVE_INFINITY;
  if (delta < profile.selector.hysteresisDelta && previousScore?.hardBlockedBy === null) {
    return Object.freeze({
      action: previous.action,
      previousAction: previous.action,
      switched: false,
      switchReason: null,
      commitUntilMs: commitmentMs(previous.action, profile, now),
      chosenScore: previousScore,
    });
  }

  return Object.freeze({
    action: best.action,
    previousAction: previous.action,
    switched: true,
    switchReason: delta === Number.POSITIVE_INFINITY ? "COMMITMENT_EXPIRED" : "NEW_UTILITY_DELTA",
    commitUntilMs: commitmentMs(best.action, profile, now),
    chosenScore: best,
  });
}
