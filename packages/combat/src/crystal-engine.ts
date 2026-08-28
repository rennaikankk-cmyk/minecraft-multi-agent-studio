/**
 * CrystalEngine —— 反射级（R，≤50ms）末影水晶放置评分与引爆时机。零 AI。
 *
 * tactics §2：给候选放置点打分，取**净收益最高且自伤低于阈值**的点，放置后同帧
 * 或下一帧引爆。评分是纯几何 + 伤害公式，天然属于确定性代码。
 *
 * **自保红线（不可协商）**：任何预估自伤会击穿"当前生命 − 图腾余量"的放置一律
 * 否决 —— 宁可不打这一下，也不能自杀。红线判定在评分之前，不是评分里的一个
 * 权重项；权重可以调，红线不能被任何权重换掉。
 *
 * 另外三条：
 *   1. **未过时序探针不得上真实对抗**（AGENTS.md §0.6）。`plan()` 可在探针之前
 *      实现并单测，`planForLiveCombat()` 未放行直接抛。本模块是 M3 时序测试的
 *      主要负载。
 *   2. 伤害计算统一走 `blast-model`。暴露度、难度与减伤由调用方注入；输出仍是
 *      估算，不是服务器承诺，调用方不得把它当伤害保证。
 *   3. **不读时钟**。`nowMs` 由调用方注入，引爆窗口逐帧可测。
 */

import {
  CombatReflexNotClearedError,
  type CombatReflexDecision,
} from "./reflex-clearance.js";
import {
  BLAST_POWER,
  blastDamage,
  entityRangeFor,
  redLineBreached,
} from "./blast-model.js";
import type { CombatVector3 } from "./threat-analyzer.js";

export type CombatCrystalCandidate = Readonly<{
  /** 水晶将占据的位置（承载方块之上）。 */
  position: CombatVector3;
  /** 承载方块是否合法（黑曜石/基岩）。 */
  hasValidBase: boolean;
  /** 放置空间是否被其他方块/实体占据。 */
  spaceObstructed: boolean;
  /**
   * 爆炸到目标之间的遮挡系数，[0, 1]。0 = 完全无遮挡，1 = 完全遮挡。
   * 由调用方按射线检测给出，本模块不做体素计算。
   */
  targetOcclusion: number;
  /** 爆炸到自己之间的遮挡系数，[0, 1]。 */
  selfOcclusion: number;
}>;

export type CombatCrystalPolicy = Readonly<{
  /** 爆炸最大作用半径（格），由水晶 power 派生，保留字段以兼容旧策略。 */
  blastRadius: number;
  /** 爆心处的基准伤害，由水晶 power 派生，保留字段以兼容旧策略。 */
  maxDamage: number;
  /** 自伤权重：净收益 = 对敌伤害 − 自伤 × 权重。 */
  selfDamageWeight: number;
  /** 自伤绝对上限；超过即淘汰该点（红线之外的额外保守约束）。 */
  selfDamageCeiling: number;
  /** 净收益低于此值不值得打。 */
  minimumNetGain: number;
  /** 放置到引爆的最大容许延迟（毫秒）；超过则重新评估。 */
  maxDetonateDelayMs: number;
}>;

export const DEFAULT_CRYSTAL_POLICY: CombatCrystalPolicy = {
  blastRadius: entityRangeFor(BLAST_POWER.crystal),
  maxDamage: 14 * BLAST_POWER.crystal + 1,
  // 自伤比对敌伤害更贵：存活即金钱（AGENTS.md §0.4）。
  selfDamageWeight: 1.5,
  selfDamageCeiling: 6,
  minimumNetGain: 1,
  // 一个 tick 内引爆；再晚容易被对方先炸。
  maxDetonateDelayMs: 50,
};

export type CombatCrystalRefusalCode =
  | "NO_CANDIDATES"
  | "ALL_UNPLACEABLE"
  | "SELF_DAMAGE_RED_LINE"
  | "SELF_DAMAGE_ABOVE_CEILING"
  | "NET_GAIN_TOO_LOW";

export type CombatCrystalScore = Readonly<{
  candidate: CombatCrystalCandidate;
  targetDamage: number;
  selfDamage: number;
  netGain: number;
}>;

export type CombatCrystalPlan = Readonly<{
  /** 选中的放置点；无可行点时为 null。 */
  chosen: CombatCrystalScore | null;
  /** 拒绝原因；有选中点时为 null。 */
  refusal: CombatCrystalRefusalCode | null;
  /** 被自保红线否决的候选数。用于遥测"我们放弃了多少次输出换存活"。 */
  redLineRejections: number;
  /** 通过全部硬约束、参与排序的候选数。 */
  viableCount: number;
  /** 生命 − 图腾余量，即本帧的自伤红线值。 */
  survivalMarginUsed: number;
}>;

export type CombatCrystalSelfState = Readonly<{
  position: CombatVector3;
  health: number;
  /**
   * 图腾余量折算的等效生命。副手有图腾时通常按一条命计。
   * 由调用方按 TotemManager 的余量给，本模块不猜。
   */
  totemMarginHealth: number;
  /** Verified mitigation only; missing is fail-closed zero. */
  explosionMitigation01?: number;
}>;

export type CombatCrystalDetonateDecision = Readonly<{
  shouldDetonate: boolean;
  reason: "DETONATE" | "WINDOW_EXPIRED" | "NOT_PLACED";
  delayMs: number;
}>;

export class CrystalEngine {
  private readonly policy: CombatCrystalPolicy;
  private placedAtMs: number | null = null;

  constructor(policy: CombatCrystalPolicy = DEFAULT_CRYSTAL_POLICY) {
    if (
      !Number.isFinite(policy.blastRadius) ||
      policy.blastRadius <= 0 ||
      !Number.isFinite(policy.maxDamage) ||
      policy.maxDamage <= 0 ||
      policy.blastRadius !== entityRangeFor(BLAST_POWER.crystal) ||
      policy.maxDamage !== 14 * BLAST_POWER.crystal + 1 ||
      !Number.isFinite(policy.selfDamageWeight) ||
      policy.selfDamageWeight < 1 ||
      !Number.isFinite(policy.selfDamageCeiling) ||
      policy.selfDamageCeiling <= 0 ||
      !Number.isFinite(policy.minimumNetGain) ||
      policy.minimumNetGain <= 0 ||
      !Number.isFinite(policy.maxDetonateDelayMs) ||
      policy.maxDetonateDelayMs <= 0
    ) {
      throw new TypeError("水晶策略越界，拒绝使用该策略。");
    }
    this.policy = policy;
  }

  /** 换服或重连后必须清掉放置记忆，否则会拿上一场的时间戳判引爆窗口。 */
  reset(): void {
    this.placedAtMs = null;
  }

  /**
   * 纯函数评分。**不足以授权真实对抗**——真实对抗走 `planForLiveCombat`。
   * 同净收益时取自伤更低的点；仍相同则按坐标字典序，保证结果可复现。
   */
  plan(
    candidates: readonly CombatCrystalCandidate[],
    targetPosition: CombatVector3,
    self: CombatCrystalSelfState,
  ): CombatCrystalPlan {
    validateSelfState(self);
    assertFinitePosition(targetPosition, "targetPosition");

    // 红线：击穿这个值就是自杀，任何权重都不能把它换掉。
    const survivalMargin = self.health + self.totemMarginHealth;

    if (candidates.length === 0) {
      return refuse("NO_CANDIDATES", 0, 0, survivalMargin);
    }

    let placeable = 0;
    let redLineRejections = 0;
    let ceilingRejections = 0;
    const viable: CombatCrystalScore[] = [];

    for (const candidate of candidates) {
      validateCandidate(candidate);
      if (!candidate.hasValidBase || candidate.spaceObstructed) continue;
      placeable += 1;

      const targetDamage = this.estimateDamage(
        candidate.position,
        targetPosition,
        candidate.targetOcclusion,
        0,
      );
      const selfDamage = this.estimateDamage(
        candidate.position,
        self.position,
        candidate.selfOcclusion,
        self.explosionMitigation01 ?? 0,
      );

      // 红线先判，早于任何评分比较。
      if (redLineBreached(selfDamage, self.health, self.totemMarginHealth)) {
        redLineRejections += 1;
        continue;
      }
      if (selfDamage > this.policy.selfDamageCeiling) {
        ceilingRejections += 1;
        continue;
      }

      viable.push({
        candidate,
        targetDamage,
        selfDamage,
        netGain: targetDamage - selfDamage * this.policy.selfDamageWeight,
      });
    }

    if (placeable === 0) {
      return refuse("ALL_UNPLACEABLE", redLineRejections, 0, survivalMargin);
    }
    if (viable.length === 0) {
      // 红线否决优先报告：它比"阈值偏保守"更值得运维看见。
      return refuse(
        redLineRejections > 0
          ? "SELF_DAMAGE_RED_LINE"
          : "SELF_DAMAGE_ABOVE_CEILING",
        redLineRejections,
        0,
        survivalMargin,
      );
    }

    viable.sort(compareScores);
    const best = viable[0];
    if (!best || best.netGain < this.policy.minimumNetGain) {
      return refuse(
        "NET_GAIN_TOO_LOW",
        redLineRejections,
        viable.length,
        survivalMargin,
      );
    }

    return {
      chosen: best,
      refusal: null,
      redLineRejections,
      viableCount: viable.length,
      survivalMarginUsed: survivalMargin,
    };
  }

  /** 真实对抗入口：时序未放行直接抛，不返回"看起来可用"的方案。 */
  planForLiveCombat(
    candidates: readonly CombatCrystalCandidate[],
    targetPosition: CombatVector3,
    self: CombatCrystalSelfState,
    clearance: CombatReflexDecision,
  ): CombatCrystalPlan {
    if (!clearance.cleared) {
      throw new CombatReflexNotClearedError(clearance.denial ?? "NO_PROBE_DATA");
    }
    return this.plan(candidates, targetPosition, self);
  }

  /** 记录一次实际放置。只有真的放下去才调用。 */
  recordPlacement(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("nowMs 必须是有限数。");
    }
    if (this.placedAtMs !== null && nowMs < this.placedAtMs) {
      throw new RangeError("放置时间早于上一次放置，拒绝记账。");
    }
    this.placedAtMs = nowMs;
  }

  /**
   * 引爆判定。窗口内立刻引爆；超窗说明这一帧已经被别的事占满，
   * 让调用方重新评估而不是引爆一个可能已经不划算的水晶。
   */
  evaluateDetonate(nowMs: number): CombatCrystalDetonateDecision {
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("nowMs 必须是有限数。");
    }
    if (this.placedAtMs === null) {
      return { shouldDetonate: false, reason: "NOT_PLACED", delayMs: 0 };
    }
    const delayMs = Math.max(0, nowMs - this.placedAtMs);
    if (delayMs > this.policy.maxDetonateDelayMs) {
      return { shouldDetonate: false, reason: "WINDOW_EXPIRED", delayMs };
    }
    return { shouldDetonate: true, reason: "DETONATE", delayMs };
  }

  /**
   * `targetOcclusion`/`selfOcclusion` are the legacy adapter contract. Convert
   * them to exposure and keep all explosion arithmetic in blast-model.
   */
  private estimateDamage(
    blastPosition: CombatVector3,
    victimPosition: CombatVector3,
    occlusion: number,
    mitigation01: number,
  ): number {
    return blastDamage({
      power: BLAST_POWER.crystal,
      blastCenter: blastPosition,
      victimPosition,
      victimEyeHeight: 0,
      exposure01: 1 - occlusion,
      difficulty: "normal",
      mitigation01,
    }).mitigatedDamage;
  }
}

/** 净收益降序；同收益取自伤更低；仍相同按坐标字典序，保证确定性。 */
function compareScores(
  left: CombatCrystalScore,
  right: CombatCrystalScore,
): number {
  if (right.netGain !== left.netGain) return right.netGain - left.netGain;
  if (left.selfDamage !== right.selfDamage) {
    return left.selfDamage - right.selfDamage;
  }
  const a = left.candidate.position;
  const b = right.candidate.position;
  return a.x - b.x || a.y - b.y || a.z - b.z;
}

function refuse(
  refusal: CombatCrystalRefusalCode,
  redLineRejections: number,
  viableCount: number,
  survivalMarginUsed: number,
): CombatCrystalPlan {
  return {
    chosen: null,
    refusal,
    redLineRejections,
    viableCount,
    survivalMarginUsed,
  };
}

function validateSelfState(self: CombatCrystalSelfState): void {
  if (!Number.isFinite(self.health) || self.health < 0) {
    throw new TypeError("self.health 必须是非负有限数。");
  }
  if (
    !Number.isFinite(self.totemMarginHealth) ||
    self.totemMarginHealth < 0
  ) {
    throw new TypeError("self.totemMarginHealth 必须是非负有限数。");
  }
  assertFinitePosition(self.position, "self.position");
  if (
    self.explosionMitigation01 !== undefined &&
    (!Number.isFinite(self.explosionMitigation01) ||
      self.explosionMitigation01 < 0 ||
      self.explosionMitigation01 > 1)
  ) {
    throw new TypeError("self.explosionMitigation01 必须落在 [0, 1]。");
  }
}

function validateCandidate(candidate: CombatCrystalCandidate): void {
  assertFinitePosition(candidate.position, "candidate.position");
  for (const [name, value] of [
    ["targetOcclusion", candidate.targetOcclusion],
    ["selfOcclusion", candidate.selfOcclusion],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`${name} 必须落在 [0, 1]。`);
    }
  }
}

function assertFinitePosition(position: CombatVector3, label: string): void {
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  ) {
    throw new TypeError(`${label} 必须是有限坐标。`);
  }
}
