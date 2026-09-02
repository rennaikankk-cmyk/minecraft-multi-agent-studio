// ---------------------------------------------------------------------------
// tactics/profile.ts —— 战术效用权重与节奏参数的**版本化**容器。
//
// 纪律（docs/research/PVP_SYSTEM_RESEARCH.md §16/§19）：
//   1. 下面这些数值是**未校准的中性先验**，不是实测结论。整个战术核心在
//      生产由 feature flag 关闭（默认关），PvP Lab 校准 + canary 之后才允许默认开。
//   2. 逻辑代码里禁止出现这些数值——只能从 profile 读，否则校准/回滚失效。
//   3. schemaVersion 变更必须伴随回放兼容说明（DecisionEvidence 记录 profile 版本）。
// ---------------------------------------------------------------------------

export type RiskBudgetMode = "AGGRESSIVE" | "BALANCED" | "PRESERVATION" | "DESPERATION";

export type TacticalActionId =
  | "PRESS"
  | "KILL_SECURE"
  | "TRADE"
  | "RESET_DISTANCE"
  | "REPOSITION"
  | "TAKE_COVER"
  | "HEAL"
  | "SWITCH_WEAPON"
  | "SWITCH_OFFHAND"
  | "CRIT_CHAIN"
  | "W_TAP_PRESSURE"
  | "CRYSTAL_ATTACK"
  | "ANCHOR_ATTACK"
  | "PACKETMINE_ACTION"
  | "CHASE"
  | "DISENGAGE"
  | "CALL_SUPPORT"
  | "PROTECT_OBJECTIVE"
  | "RECOVER_DROPS"
  | "HOLD";

export const TACTICAL_ACTION_IDS: readonly TacticalActionId[] = Object.freeze([
  "PRESS", "KILL_SECURE", "TRADE", "RESET_DISTANCE", "REPOSITION", "TAKE_COVER",
  "HEAL", "SWITCH_WEAPON", "SWITCH_OFFHAND", "CRIT_CHAIN", "W_TAP_PRESSURE",
  "CRYSTAL_ATTACK", "ANCHOR_ATTACK", "PACKETMINE_ACTION", "CHASE", "DISENGAGE",
  "CALL_SUPPORT", "PROTECT_OBJECTIVE", "RECOVER_DROPS", "HOLD",
]);

/**
 * 风险预算四档 → 效用权重集。deathCostMultiplier 是档位的唯一杠杆：
 * AGGRESSIVE 折减死亡成本，PRESERVATION 放大，DESPERATION 只在逃生概率
 * 崩塌时由谓词触发（不允许 operator 常开——见 snapshot.ts deriveRiskBudget）。
 */
export type TacticsProfile = Readonly<{
  schemaVersion: string;

  /** 效用权重（和无需为 1；选择器按最高分取，不做跨动作概率化）。 */
  weights: Readonly<{
    kill: number;
    survive: number;
    objective: number;
    ally: number;
    death: number;
    damageTaken: number;
    resource: number;
    exposure: number;
    uncertainty: number;
  }>;

  /** 各档死亡的相对成本乘数（PRESERVATION 携带关键物资时数量级放大）。 */
  deathCostMultiplier: Readonly<Record<RiskBudgetMode, number>>;

  /** KILL_SECURE 候选谓词阈值（见 utility.ts evaluateKillSecureGate）。 */
  killSecure: Readonly<{
    pKillThreshold: number;        // P(敌 HP ≤ 本次净伤上界) 下限
    ttdMarginMs: number;           // 我方 TTD 下界 − 动作生效时间 的安全余量
    escapePThreshold: number;      // 高于它则撤退优于换命
    confidenceThreshold: number;   // belief 置信度下限
  }>;

  /** 动作选择器的滞回/承诺。 */
  selector: Readonly<{
    hysteresisDelta: number;       // 换动作需要超过的效用差
    minCommitMs: number;           // 普通动作最小承诺
    killSecureCommitMs: number;    // KILL_SECURE 冲刺的最小承诺（短：一击即走）
    healCommitMs: number;          // HEAL 承诺（进食 1.6s，仅 Reflex 可断）
    targetSwitchDelta: number;     // 换目标的效用差门槛
    staleSnapshotMs: number;       // belief/位置超龄 → 不可逆动作被 STALE_STATE 拦
  }>;

  /** belief 时间衰减。 */
  belief: Readonly<{
    decayStepMs: number;           // 每过这么久无证据 → 扩张一步
    widenPerStepHp: number;        // 每步向全宽扩张的半心数
    maxConfidenceAgeMs: number;    // 观察超过此龄 → confidence 线性下降
  }>;
}>;

/**
 * 未校准中性先验（v0）。特征：权重对称、四档 deathCost 只差 2x 量级、
 * KILL_SECURE 门槛明显偏保守（P≥0.75、置信度≥0.7）——冷启动宁可错失补刀
 * 也不错押换命（failed-kill-secure death 是最危险的错误方向，研究 §18.6）。
 */
export const DEFAULT_TACTICS_PROFILE: TacticsProfile = Object.freeze({
  schemaVersion: "tactics-v0-uncalibrated",
  weights: Object.freeze({
    kill: 1.0,
    survive: 1.0,
    objective: 0.6,
    ally: 0.4,
    death: 1.2,
    damageTaken: 0.5,
    resource: 0.2,
    exposure: 0.3,
    uncertainty: 0.4,
  }),
  deathCostMultiplier: Object.freeze({
    AGGRESSIVE: 0.6,
    BALANCED: 1.0,
    PRESERVATION: 3.0,
    DESPERATION: 0.5,
  }),
  killSecure: Object.freeze({
    pKillThreshold: 0.75,
    ttdMarginMs: 150,
    escapePThreshold: 0.6,
    confidenceThreshold: 0.7,
  }),
  selector: Object.freeze({
    hysteresisDelta: 0.15,
    minCommitMs: 400,
    killSecureCommitMs: 300,
    healCommitMs: 1_600,
    targetSwitchDelta: 0.2,
    staleSnapshotMs: 250,
  }),
  belief: Object.freeze({
    decayStepMs: 2_000,
    widenPerStepHp: 2,
    maxConfidenceAgeMs: 3_000,
  }),
});

export function validateTacticsProfile(profile: TacticsProfile): TacticsProfile {
  if (!/^[a-z0-9-]+$/.test(profile.schemaVersion)) {
    throw new TypeError(`tactics profile schemaVersion 非法: ${profile.schemaVersion}`);
  }
  const w = profile.weights;
  for (const value of [w.kill, w.survive, w.objective, w.ally, w.death, w.damageTaken, w.resource, w.exposure, w.uncertainty]) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError("tactics 权重必须是非负有限数");
  }
  const k = profile.killSecure;
  if (k.pKillThreshold <= 0 || k.pKillThreshold >= 1) throw new TypeError("pKillThreshold 必须在 (0,1)");
  if (k.confidenceThreshold <= 0 || k.confidenceThreshold >= 1) throw new TypeError("confidenceThreshold 必须在 (0,1)");
  if (k.ttdMarginMs < 0 || profile.selector.minCommitMs < 0) throw new TypeError("时序参数必须非负");
  if (profile.belief.decayStepMs <= 0 || profile.belief.widenPerStepHp <= 0) throw new TypeError("belief 衰减必须为正");
  return profile;
}
