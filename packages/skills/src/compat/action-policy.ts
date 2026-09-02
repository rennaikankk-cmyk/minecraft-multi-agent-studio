// ---------------------------------------------------------------------------
// Round 7 —— Unified Adaptive Action Policy。
//
// 所有受控 capability 在发起动作前经 resolveEffectiveActionPolicy 取得本
// family 的节奏参数。数值不散落 Skill——单一 resolver 从
// ServerBehaviorProfile（mode→既有 baselineLimits）派生；未列出的 family
// 使用通用默认（无额外限速），行为语义不变，只加执行节奏。
//
// 拒绝语义：feature gate 关闭或降级到当前 family 被禁时返回
// { allowed: false, failureCode }——调用方必须走安全替代路径或如实上报，
// 不得死循环重试。
// ---------------------------------------------------------------------------

import { baselineLimits, type BaselineAntiCheatProfile } from "../policy/server-policy.js";
import {
  MODE_TO_BASELINE,
  type ActionFamily,
  type ActionRisk,
  type FeatureGate,
  type ServerBehaviorProfile,
} from "./server-behavior-profile.js";

export interface EffectiveActionPolicy {
  readonly family: ActionFamily;
  readonly minIntervalMs: number;
  readonly maxBurst: number;
  readonly timeoutMs: number;
  readonly retryBudget: number;
  readonly cooldownMs: number;
  readonly verificationDelayMs: number;
  readonly concurrency: number;
  readonly requiredObservationFreshnessMs: number;
  readonly riskCeiling: ActionRisk;
  /** 该 family 需要且当前关闭的 feature gate（空=不拦）。 */
  readonly blockingGates: readonly FeatureGate[];
  readonly baseline: BaselineAntiCheatProfile;
  readonly policyRevision: number;
}

export type PolicyResolution =
  | Readonly<{ allowed: true; policy: EffectiveActionPolicy }>
  | Readonly<{ allowed: false; failureCode: "FEATURE_GATE_DISABLED" | "FAMILY_RESTRICTED"; detail: string }>;

const FAMILY_RISK: Readonly<Record<ActionFamily, ActionRisk>> = Object.freeze({
  MOVEMENT: "LOW",
  ROTATION: "MEDIUM",
  DIGGING: "MEDIUM",
  PLACEMENT: "MEDIUM",
  INVENTORY: "LOW",
  CONTAINER: "MEDIUM",
  CRAFTING: "LOW",
  SMELTING: "LOW",
  MELEE_ATTACK: "HIGH",
  PROJECTILE: "HIGH",
  EXPLOSIVE_COMBAT: "CRITICAL",
  PACKET_INTENSIVE: "CRITICAL",
  CHAT_COMMAND: "MEDIUM",
});

/** 模式 → 每 family 的节奏倍率（保守模式更慢，ANARCHY 不额外加限）。 */
const MODE_PACING: Readonly<Record<BaselineAntiCheatProfile, number>> = Object.freeze({
  STRICT: 2,
  VANILLA_COMPATIBLE: 1.5,
  NORMAL: 1,
  ANARCHY: 1,
});

/** 高风险 family 在 RESTRICTED 语义（UNKNOWN/CONSERVIVE 基线）下直接禁用。 */
const HIGH_RISK_FAMILIES: ReadonlySet<ActionFamily> = new Set([
  "EXPLOSIVE_COMBAT",
  "PACKET_INTENSIVE",
]);

/** family → 依赖的 feature gate。 */
export const FAMILY_REQUIRED_GATES: Readonly<Partial<Record<ActionFamily, readonly FeatureGate["feature"][]>>> = Object.freeze({
  DIGGING: ["PACKET_MINE", "RAPID_DIG"],
  PLACEMENT: ["RAPID_PLACE", "NO_HUNGER"], // NO_HUNGER 不拦放置；见 resolveGateCheck 注释
  ROTATION: ["FAST_ROTATION"],
  MELEE_ATTACK: ["HIGH_RATE_MELEE"],
  EXPLOSIVE_COMBAT: ["EXPLOSIVE_CRYSTAL", "RESPAWN_ANCHOR_COMBAT"],
});

/**
 * 解析一个 family 的 effective policy。
 *
 * gate 语义：列出的是"该 family 里存在依赖此 gate 的强化形态"——只有
 * desiredState=true 的 gate 缺席才拦截（operator 没想要的强化不应阻止普通
 * 路径）；NO_HUNGER 这类生存 gate 永不拦普通动作（见下方过滤）。
 */
export function resolveEffectiveActionPolicy(
  profile: ServerBehaviorProfile,
  family: ActionFamily,
): PolicyResolution {
  const baseline = MODE_TO_BASELINE[profile.effectiveMode];
  const limits = baselineLimits(baseline);
  const pacing = MODE_PACING[baseline];
  const risk = FAMILY_RISK[family];

  // 高风险 family 在保守基线下禁用（fail-closed，返回稳定码）
  if (HIGH_RISK_FAMILIES.has(family) && baseline === "STRICT") {
    return {
      allowed: false,
      failureCode: "FAMILY_RESTRICTED",
      detail: `${family} is restricted under effectiveMode=${profile.effectiveMode} (baseline STRICT); operator must validate on a designated server profile`,
    };
  }

  // gate 检查：只拦"operator 想要但 compat 拒绝"的强化
  const required = FAMILY_REQUIRED_GATES[family] ?? [];
  const blocking = profile.featureGates.filter(
    (gate) =>
      required.includes(gate.feature) &&
      gate.desiredState === true &&
      gate.effectiveState === false &&
      // NO_HUNGER 只约束其自身强化路径，不拦 family 普通动作
      gate.feature !== "NO_HUNGER",
  );
  if (blocking.length > 0) {
    return {
      allowed: false,
      failureCode: "FEATURE_GATE_DISABLED",
      detail: blocking
        .map((gate) => `${gate.feature}: ${gate.disableReason ?? "compat-check refused"}`)
        .join("; "),
    };
  }

  // 节奏：以 baseline 限速为锚（maxAttacksPerSecond 等已是数值），倍率派生
  const baseIntervalMs = Math.round(1000 / Math.max(1, limits.maxAttacksPerSecond));
  return {
    allowed: true,
    policy: {
      family,
      minIntervalMs: Math.max(50, Math.round(baseIntervalMs * pacing)),
      maxBurst: Math.max(1, Math.floor(limits.maxAttacksPerSecond / pacing)),
      timeoutMs: 15_000,
      retryBudget: 3,
      cooldownMs: pacing * 250,
      verificationDelayMs: 150,
      concurrency: 1,
      requiredObservationFreshnessMs: 1_000,
      riskCeiling: risk,
      blockingGates: [],
      baseline,
      policyRevision: profile.revision,
    },
  };
}

/**
 * Feature gate 兼容检查：desired → effective。
 * CRITICAL gate 在保守基线一律关；operator 明确 desired 且基线允许时开。
 */
export function evaluateFeatureGates(
  profile: ServerBehaviorProfile,
): readonly FeatureGate[] {
  const baseline = MODE_TO_BASELINE[profile.effectiveMode];
  const conservative = baseline === "STRICT";
  const CRITICAL_GATES: ReadonlySet<FeatureGate["feature"]> = new Set([
    "PACKET_MINE",
    "EXPLOSIVE_CRYSTAL",
    "RESPAWN_ANCHOR_COMBAT",
    "RAPID_DIG",
    "RAPID_PLACE",
    "FAST_ROTATION",
    "HIGH_RATE_MELEE",
  ]);
  return profile.featureGates.map((gate) => {
    if (!gate.desiredState) {
      return { ...gate, effectiveState: false, source: "operator" as const, disableReason: "operator disabled" };
    }
    if (conservative && CRITICAL_GATES.has(gate.feature)) {
      return {
        ...gate,
        effectiveState: false,
        source: "compat-check" as const,
        disableReason: `effectiveMode=${profile.effectiveMode} maps to STRICT baseline; high-risk gates stay closed until validated on this server`,
      };
    }
    // desired + 基线允许 → 开（ANARCHY/EXPLICIT_UNRESTRICTED 或非 CRITICAL gate）
    return {
      ...gate,
      effectiveState: true,
      source: gate.source === "operator" ? ("operator" as const) : ("compat-check" as const),
      disableReason: null,
      lastValidatedAt: new Date().toISOString(),
    };
  });
}
