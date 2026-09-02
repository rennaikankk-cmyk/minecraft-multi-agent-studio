// ---------------------------------------------------------------------------
// tactics/evidence.ts —— Decision Evidence（研究 §17.1）。
//
// 每次裁决产出一段**确定性** JSON：同 snapshot + 同 profile + 同 previous
// 必然字节级复现。它同时是 PvP Lab 校准的离线回放输入与 dashboard 的解释面。
// 所有数值运行时由模型输入派生；示例数字不得成为默认值（研究 §16 纪律）。
// ---------------------------------------------------------------------------

import type { TacticalDecision } from "./selector.js";
import type { CombatSnapshot } from "./snapshot.js";
import type { UtilityVerdict } from "./utility.js";
import type { TacticsProfile } from "./profile.js";

export type DecisionEvidence = Readonly<{
  schemaVersion: 1;
  atMonotonicMs: number;
  stepMs: number;
  tacticsProfileVersion: string;
  decision: TacticalDecision["action"];
  previous: TacticalDecision["previousAction"];
  switched: TacticalDecision["switched"];
  switchReason: TacticalDecision["switchReason"];
  /** top-N 分数（hard-block 的动作也列，带原因——解释面诚实）。 */
  scores: readonly Readonly<{
    action: string;
    utility: number;
    hardBlockedBy: string | null;
  }>[];
  inputs: Readonly<{
    ourTtdMs: Readonly<{ best: number; worst: number }> | null;
    ourTtkMs: Readonly<{ best: number; worst: number }> | null;
    enemyHealthBeliefHp: Readonly<{ lo: number; hi: number }> | null;
    pEnemyDeadByNextHit: number;
    escapeP: number;
    confidence: number;
    totemState: "NO_TOTEM" | "TOTEM_READY";
    riskBudget: string;
    pingMs: number;
    compatMode: string;
    killSecureGate: Readonly<{ open: boolean; failedChecks: readonly string[] }>;
  }>;
  evidenceRefs: readonly string[];
}>;

const TOP_N = 8;

export function buildDecisionEvidence(input: {
  snapshot: CombatSnapshot;
  profile: TacticsProfile;
  verdict: UtilityVerdict;
  decision: TacticalDecision;
}): DecisionEvidence {
  const { snapshot, profile, verdict, decision } = input;
  const belief = snapshot.target;
  return Object.freeze({
    schemaVersion: 1,
    atMonotonicMs: snapshot.nowMonotonicMs,
    stepMs: snapshot.stepMs,
    tacticsProfileVersion: profile.schemaVersion,
    decision: decision.action,
    previous: decision.previousAction,
    switched: decision.switched,
    switchReason: decision.switchReason,
    scores: Object.freeze(
      [...verdict.scores]
        .sort((a, b) => b.utility - a.utility)
        .slice(0, TOP_N)
        .map((score) => Object.freeze({
          action: score.action,
          utility: Math.round(score.utility * 1000) / 1000,
          hardBlockedBy: score.hardBlockedBy,
        })),
    ),
    inputs: Object.freeze({
      ourTtdMs: verdict.derived.ourTtdMs,
      ourTtkMs: verdict.derived.ourTtkMs,
      enemyHealthBeliefHp: belief !== null ? belief.health.intervalHp : null,
      pEnemyDeadByNextHit: Math.round(verdict.derived.enemyPDeadByNextHit * 1000) / 1000,
      escapeP: Math.round(verdict.derived.escapeP * 1000) / 1000,
      confidence: belief !== null ? Math.round(belief.confidence * 1000) / 1000 : 0,
      totemState: snapshot.self.offhand.totemReady ? "TOTEM_READY" : "NO_TOTEM",
      riskBudget: verdict.riskBudget,
      pingMs: snapshot.self.pingMs,
      compatMode: snapshot.policy.compatMode,
      killSecureGate: verdict.derived.killSecureGate,
    }),
    evidenceRefs: belief !== null ? belief.evidenceRefs.slice(-5) : [],
  });
}
