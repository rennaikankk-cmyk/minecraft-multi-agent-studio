// ---------------------------------------------------------------------------
// tactics/belief.ts —— Enemy Belief State（区间血量 + 置信度，纯函数）。
//
// 三条铁律（docs/research/PVP_SYSTEM_RESEARCH.md §8.2）：
//   1. 未确认命中**绝不**扣减（whiff/被格挡/i-frame 吞伤都无法确认）。
//   2. i-frame 差值规则的扣减只在上一击伤害已知时才可算；否则只记证据。
//   3. 敌方精确血量不存在——一切输出是区间+分布+置信度；任何"看起来很残"
//      的直觉都禁止收窄区间。
// ---------------------------------------------------------------------------

import { TOTEM_POP, GOLDEN_APPLE, IFRAME_MS } from "./mechanics.js";
import type { TacticsProfile } from "./profile.js";

export type HealthDistribution = "UNIFORM" | "TRIANGULAR_PEAK_LO" | "POINT";

export type HealthBelief = Readonly<{
  /** 半心区间 [lo, hi]；lo≥0；hi≤20（吸收单列）。 */
  intervalHp: Readonly<{ lo: number; hi: number }>;
  /** 吸收层可能/确定存在（pop 窗口=确定 4HP；进食金苹果=可能）。 */
  absorption: Readonly<{ possible: boolean; certainHp: number }>;
  distribution: HealthDistribution;
  /** POINT 仅当操作员信任源（记分板）——否则恒为区间。 */
  pointSource: Readonly<{ kind: "SCOREBOARD" | null; trustedServer: boolean }>;
  lastUpdateEvidence:
    | "PRIOR"
    | "CONFIRMED_HIT"
    | "OBSERVED_HEAL"
    | "TOTEM_POP"
    | "DECAY"
    | "TRUSTED_SOURCE";
}>;

export type EnemyProfileTag = "UNPROFILED" | "UTILITY_CLIENT" | "LEGACY" | "NORMAL_PLAYER";

export type EnemyBeliefState = Readonly<{
  entityId: number;
  uuid: string | null;
  username: string;
  classification: "HOSTILE" | "UNKNOWN";

  lastObservedAtMs: number;
  position: Readonly<{ x: number; y: number; z: number }>;
  /** 由位置差分推断的速度区间（m/s 各轴）。 */
  velocityInterval: Readonly<{ min: Readonly<{ x: number; y: number; z: number }>; max: Readonly<{ x: number; y: number; z: number }> }>;
  lineOfSight: boolean | null;
  tracking: "IN_RANGE" | "EDGE" | "LOST";

  /** 可观察装备事实（Set Equipment 含 data components；剥除则 unknown）。 */
  equipment: Readonly<{
    heldItem: string | null;
    offhandItem: string | null; // offhand 图腾可直接观察
    armorPieces: readonly (string | null)[];
    componentsStripped: boolean;
  }>;
  blockingWithShield: boolean;
  usingItem: Readonly<{ kind: "EATING" | "DRINKING" | null; startedAtMs: number | null }>;

  health: HealthBelief;
  observedTotemPops: number;
  lastTotemPopAtMs: number | null;

  attackCadence: Readonly<{ samples: number; meanIntervalMs: number | null }>;
  critRate: Readonly<{ samples: number; rate: number | null }>;
  pingMs: number | null;
  opponentProfile: EnemyProfileTag;

  confidence: number;
  evidenceRefs: readonly string[];
}>;

/** 新目标先验：[8,20]（成年玩家可能已掉血），低置信，均匀分布。 */
export function initialEnemyBelief(input: {
  entityId: number;
  uuid: string | null;
  username: string;
  classification: "HOSTILE" | "UNKNOWN";
  nowMonotonicMs: number;
  position: Readonly<{ x: number; y: number; z: number }>;
}): EnemyBeliefState {
  return Object.freeze({
    entityId: input.entityId,
    uuid: input.uuid,
    username: input.username,
    classification: input.classification,
    lastObservedAtMs: input.nowMonotonicMs,
    position: input.position,
    velocityInterval: Object.freeze({
      min: Object.freeze({ x: -7.2, y: -7.2, z: -7.2 }),
      max: Object.freeze({ x: 7.2, y: 7.2, z: 7.2 }),
    }),
    lineOfSight: null,
    tracking: "IN_RANGE",
    equipment: Object.freeze({ heldItem: null, offhandItem: null, armorPieces: [], componentsStripped: false }),
    blockingWithShield: false,
    usingItem: Object.freeze({ kind: null, startedAtMs: null }),
    health: Object.freeze({
      intervalHp: Object.freeze({ lo: 8, hi: 20 }),
      absorption: Object.freeze({ possible: false, certainHp: 0 }),
      distribution: "UNIFORM",
      pointSource: Object.freeze({ kind: null, trustedServer: false }),
      lastUpdateEvidence: "PRIOR",
    }),
    observedTotemPops: 0,
    lastTotemPopAtMs: null,
    attackCadence: Object.freeze({ samples: 0, meanIntervalMs: null }),
    critRate: Object.freeze({ samples: 0, rate: null }),
    pingMs: null,
    opponentProfile: "UNPROFILED",
    confidence: 0.3,
    evidenceRefs: Object.freeze([`prior@${input.entityId}`]),
  });
}

function clampInterval(lo: number, hi: number): Readonly<{ lo: number; hi: number }> {
  return Object.freeze({ lo: Math.max(0, Math.min(lo, 20)), hi: Math.max(0, Math.min(hi, 20)) });
}

/**
 * 确认命中扣减。`netDamage` 是我方净伤害**区间** [lo, hi]（武器已知、敌甲
 * 材质可见、Protection 未知 → 区间算术保守向：hi 用 dmg_lo 收，lo 用 dmg_hi 收）。
 * `inIframeWindow`：命中落在敌方 0.5s 无敌帧内——除非 `previousHitDamage` 已知
 * （差值规则可算），否则只记证据不扣减（铁律 2）。
 */
export function applyConfirmedHit(
  belief: EnemyBeliefState,
  input: {
    netDamage: Readonly<{ lo: number; hi: number }>;
    inIframeWindow: boolean;
    previousHitDamage: Readonly<{ lo: number; hi: number }> | null;
    evidenceRef: string;
  },
): EnemyBeliefState {
  let effective = input.netDamage;
  if (input.inIframeWindow && input.previousHitDamage !== null) {
    // 差值规则（wiki Damage）：只结算超出部分；区间化 → 用对方下界减我方上界（保守）。
    const diffLo = Math.max(0, input.netDamage.lo - input.previousHitDamage.hi);
    const diffHi = Math.max(0, input.netDamage.hi - input.previousHitDamage.lo);
    effective = Object.freeze({ lo: diffLo, hi: diffHi });
  } else if (input.inIframeWindow) {
    return withEvidence(belief, input.evidenceRef, "CONFIRMED_HIT");
  }
  const { lo, hi } = belief.health.intervalHp;
  return withEvidence(
    {
      ...belief,
      health: {
        ...belief.health,
        intervalHp: clampInterval(lo - effective.hi, hi - effective.lo),
        distribution: belief.health.distribution === "POINT" ? "TRIANGULAR_PEAK_LO" : belief.health.distribution,
        pointSource: { kind: null, trustedServer: false },
        lastUpdateEvidence: "CONFIRMED_HIT",
      },
    },
    input.evidenceRef,
    "CONFIRMED_HIT",
  );
}

/** 观察到治疗：金苹果/药水。区间上界扩张，lo 不动（治疗不证明之前满血）。 */
export function applyObservedHeal(
  belief: EnemyBeliefState,
  input: { kind: "GOLDEN_APPLE" | "HEALING_POTION"; completedAtMs: number; evidenceRef: string },
): EnemyBeliefState {
  const gain = input.kind === "GOLDEN_APPLE"
    ? GOLDEN_APPLE.regenHp + GOLDEN_APPLE.absorptionHp
    : 8; // Instant Health II = 8HP（wiki Potion）
  const { lo, hi } = belief.health.intervalHp;
  return withEvidence(
    {
      ...belief,
      health: {
        ...belief.health,
        intervalHp: clampInterval(lo, hi + gain),
        absorption: { possible: input.kind === "GOLDEN_APPLE", certainHp: belief.health.absorption.certainHp },
        lastUpdateEvidence: "OBSERVED_HEAL",
      },
    },
    input.evidenceRef,
    "OBSERVED_HEAL",
  );
}

/**
 * 图腾 pop（Entity Status 35）：重置为 [1, 1+吸收上界]，pop 窗口开启。
 * 注意研究 §8.2 规则 4：再生爬升进 TTK 估计（utility），不进区间。
 */
export function applyTotemPop(
  belief: EnemyBeliefState,
  input: { nowMonotonicMs: number; evidenceRef: string },
): EnemyBeliefState {
  return withEvidence(
    {
      ...belief,
      health: {
        intervalHp: { lo: TOTEM_POP.healthAfter, hi: TOTEM_POP.healthAfter + TOTEM_POP.absorptionHp },
        absorption: { possible: false, certainHp: TOTEM_POP.absorptionHp },
        distribution: "TRIANGULAR_PEAK_LO",
        pointSource: { kind: null, trustedServer: false },
        lastUpdateEvidence: "TOTEM_POP",
      },
      observedTotemPops: belief.observedTotemPops + 1,
      lastTotemPopAtMs: input.nowMonotonicMs,
    },
    input.evidenceRef,
    "TOTEM_POP",
  );
}

/** 操作员信任服的记分板 health（含吸收）→ POINT（未信任服禁止调用）。 */
export function applyTrustedScoreboardHealth(
  belief: EnemyBeliefState,
  input: { hp: number; trustedServer: true; evidenceRef: string },
): EnemyBeliefState {
  if (!input.trustedServer) {
    throw new TypeError("记分板血量只允许在操作员显式信任的服务器上采信（插件可伪造）。");
  }
  return withEvidence(
    {
      ...belief,
      health: {
        intervalHp: clampInterval(input.hp, input.hp),
        absorption: { possible: false, certainHp: 0 },
        distribution: "POINT",
        pointSource: { kind: "SCOREBOARD", trustedServer: true },
        lastUpdateEvidence: "TRUSTED_SOURCE",
      },
    },
    input.evidenceRef,
    "TRUSTED_SOURCE",
  );
}

/**
 * 时间衰减：每 decayStepMs 无证据 → 区间向全宽扩张 widenPerStepHp、置信度按
 * 观察龄线性下降。治疗可能性随时间累积（敌人可能已吃过药）→ 上界同步扩张。
 */
export function applyDecay(
  belief: EnemyBeliefState,
  input: { nowMonotonicMs: number; profile: TacticsProfile },
): EnemyBeliefState {
  const age = input.nowMonotonicMs - belief.lastObservedAtMs;
  const steps = Math.floor(age / input.profile.belief.decayStepMs);
  if (steps <= 0) return belief;
  const widen = steps * input.profile.belief.widenPerStepHp;
  const { lo, hi } = belief.health.intervalHp;
  const confidence = Math.max(0.05, 1 - age / input.profile.belief.maxConfidenceAgeMs);
  return {
    ...belief,
    health: {
      ...belief.health,
      intervalHp: clampInterval(lo - widen, hi + widen),
      distribution: belief.health.distribution === "POINT" ? "UNIFORM" : belief.health.distribution,
      pointSource: { kind: null, trustedServer: false },
      lastUpdateEvidence: belief.health.lastUpdateEvidence === "PRIOR" ? "PRIOR" : "DECAY",
    },
    confidence: Math.min(belief.confidence, confidence),
  };
}

/** P(敌有效 HP ≤ x)。均匀分布按区间线性；三角分布向 lo 加权；POINT 阶跃。 */
export function probabilityHealthBelow(belief: EnemyBeliefState, x: number): number {
  const { lo, hi } = belief.health.intervalHp;
  const total = lo + belief.health.absorption.certainHp;
  if (x < total) return 0;
  if (belief.health.distribution === "POINT" || lo >= hi) return 1;
  if (x >= hi + belief.health.absorption.certainHp) return 1;
  const span = hi - lo;
  const t = (x - total) / span; // [0,1] 内
  if (belief.health.distribution === "TRIANGULAR_PEAK_LO") {
    // 峰在 lo 的三角：CDF = 1 - (1-t)^2（向低端集中）。
    return 1 - (1 - t) * (1 - t);
  }
  return t;
}

/** 击穿预算：打死敌人需要的净伤害下界（含确定吸收 + 概率为 1 时的图腾层由调用方另计）。 */
export function lethalDamageThreshold(belief: EnemyBeliefState): number {
  return belief.health.intervalHp.hi + belief.health.absorption.certainHp;
}

export function popWindowActive(belief: EnemyBeliefState, nowMonotonicMs: number): boolean {
  return (
    belief.lastTotemPopAtMs !== null &&
    nowMonotonicMs - belief.lastTotemPopAtMs < TOTEM_POP.absorptionMs
  );
}

export function enemyIframeActive(belief: EnemyBeliefState, nowMonotonicMs: number): boolean {
  // hit-window 观察由宿主喂给 evidenceRefs（见 HitWindowTracker）；这里用
  // 最近确认命中后的 IFRAME_MS 窗口近似——宿主应传 lastConfirmedHitAtMs。
  return nowMonotonicMs - lastConfirmedHitAt(belief) < IFRAME_MS;
}

function lastConfirmedHitAt(belief: EnemyBeliefState): number {
  const hit = belief.evidenceRefs.find((ref) => ref.startsWith("hit@"));
  if (hit === undefined) return Number.NEGATIVE_INFINITY;
  const at = Number(hit.slice(hit.indexOf("@") + 1));
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

function withEvidence(
  belief: EnemyBeliefState,
  ref: string,
  marker: string,
): EnemyBeliefState {
  return {
    ...belief,
    confidence: Math.min(1, belief.confidence + 0.1),
    evidenceRefs: [...belief.evidenceRefs.slice(-15), ref],
    health: belief.health,
    ...(marker === "CONFIRMED_HIT" ? {} : {}),
  };
}
