/**
 * PredictionEngine —— 规划级（P，≤1000ms）确定性运动外推。零 AI。
 *
 * 用途只有一个：把"敌人现在在哪"变成"敌人下一刻大概在哪"，供瞄准提前量与
 * 水晶落点评分使用。**它不下决策**——不选目标、不决定打不打，只回答几何问题。
 *
 * 三条自我约束，避免这个模块变成"看起来很准"的幻觉来源：
 *   1. **样本不足就说不知道**。少于两帧无法估速度，返回 confidence "none"，
 *      调用方必须按当前位置打，不许拿外推值当真。
 *   2. **外推有时间上限**。超过 `maxHorizonMs` 的预测没有意义（对手会转向），
 *      直接钳到上限并把 confidence 降级。
 *   3. **跨服/跨维度样本一律丢弃**。世界记忆纪律同样适用于短期轨迹：
 *      serverProfileId 或 dimension 变了就是另一条轨迹，混算会得到荒谬速度。
 *
 * 所有时间戳由调用方给（快照自带 observedAtMs），本模块从不读时钟。
 */

import type { CombatVector3 } from "./threat-analyzer.js";

export type CombatMotionSample = Readonly<{
  observedAtMs: number;
  /** 必须与查询时的连接一致，否则样本被丢弃。 */
  serverProfileId: string;
  dimension: string;
  position: CombatVector3;
}>;

export type CombatPredictionConfidence = "none" | "low" | "high";

export type CombatPrediction = Readonly<{
  /** 预测位置；无样本时为 null。 */
  position: CombatVector3 | null;
  /** 每毫秒的速度向量；样本不足时为 null。 */
  velocityPerMs: CombatVector3 | null;
  /** 实际使用的外推时长，已被 maxHorizonMs 钳制。 */
  horizonMsUsed: number;
  confidence: CombatPredictionConfidence;
  /** 参与计算的样本数。 */
  samplesUsed: number;
}>;

export type CombatPredictionPolicy = Readonly<{
  /** 超过此时长的外推不可信，钳制并降级。 */
  maxHorizonMs: number;
  /** 早于最新样本此时长的样本视为过期，不参与估速。 */
  sampleStalenessMs: number;
  /** 每格/毫秒的速度上限，超过视为传送或坏数据。 */
  maxSpeedPerMs: number;
  /** 达到此样本数才给 high confidence。 */
  highConfidenceSamples: number;
}>;

export const DEFAULT_PREDICTION_POLICY: CombatPredictionPolicy = {
  maxHorizonMs: 500,
  sampleStalenessMs: 1_000,
  // 原版疾跑约 0.0056 格/ms；给到 0.05 足以覆盖鞘翅与击退，又能挡住传送。
  maxSpeedPerMs: 0.05,
  highConfidenceSamples: 3,
};

export class PredictionEngine {
  private readonly policy: CombatPredictionPolicy;

  constructor(policy: CombatPredictionPolicy = DEFAULT_PREDICTION_POLICY) {
    if (
      !Number.isFinite(policy.maxHorizonMs) ||
      policy.maxHorizonMs <= 0 ||
      !Number.isFinite(policy.sampleStalenessMs) ||
      policy.sampleStalenessMs <= 0 ||
      !Number.isFinite(policy.maxSpeedPerMs) ||
      policy.maxSpeedPerMs <= 0 ||
      !Number.isInteger(policy.highConfidenceSamples) ||
      policy.highConfidenceSamples < 2
    ) {
      throw new TypeError("预测策略越界，拒绝使用该策略。");
    }
    this.policy = policy;
  }

  /**
   * 纯函数。`samples` 可以任意顺序传入，内部按时间排序。
   * `serverProfileId` / `dimension` 是当前连接的事实，不匹配的样本直接丢。
   */
  predict(
    samples: readonly CombatMotionSample[],
    horizonMs: number,
    serverProfileId: string,
    dimension: string,
  ): CombatPrediction {
    if (!Number.isFinite(horizonMs) || horizonMs < 0) {
      throw new TypeError("horizonMs 必须是非负有限数。");
    }

    // 跨服/跨维度混算会得出荒谬速度，fail-closed 丢弃。
    const scoped = samples
      .filter(
        (sample) =>
          sample.serverProfileId === serverProfileId &&
          sample.dimension === dimension &&
          Number.isFinite(sample.observedAtMs),
      )
      .slice()
      .sort((left, right) => left.observedAtMs - right.observedAtMs);

    const latest = scoped.at(-1);
    if (!latest) {
      return {
        position: null,
        velocityPerMs: null,
        horizonMsUsed: 0,
        confidence: "none",
        samplesUsed: 0,
      };
    }

    const fresh = scoped.filter(
      (sample) =>
        latest.observedAtMs - sample.observedAtMs <= this.policy.sampleStalenessMs,
    );
    const earliest = fresh[0];
    const spanMs = earliest ? latest.observedAtMs - earliest.observedAtMs : 0;

    // 一帧或零时间跨度都估不出速度：如实说不知道，别外推。
    if (!earliest || fresh.length < 2 || spanMs <= 0) {
      return {
        position: latest.position,
        velocityPerMs: null,
        horizonMsUsed: 0,
        confidence: "none",
        samplesUsed: fresh.length,
      };
    }

    const velocity = {
      x: (latest.position.x - earliest.position.x) / spanMs,
      y: (latest.position.y - earliest.position.y) / spanMs,
      z: (latest.position.z - earliest.position.z) / spanMs,
    };
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (speed > this.policy.maxSpeedPerMs) {
      // 超速通常是传送/换维度残留：不外推，只报当前位置。
      return {
        position: latest.position,
        velocityPerMs: null,
        horizonMsUsed: 0,
        confidence: "none",
        samplesUsed: fresh.length,
      };
    }

    const horizonMsUsed = Math.min(horizonMs, this.policy.maxHorizonMs);
    const clamped = horizonMsUsed < horizonMs;
    return {
      position: {
        x: latest.position.x + velocity.x * horizonMsUsed,
        y: latest.position.y + velocity.y * horizonMsUsed,
        z: latest.position.z + velocity.z * horizonMsUsed,
      },
      velocityPerMs: velocity,
      horizonMsUsed,
      // 被钳制的外推一律降级，避免调用方把它当精确值。
      confidence:
        !clamped && fresh.length >= this.policy.highConfidenceSamples
          ? "high"
          : "low",
      samplesUsed: fresh.length,
    };
  }
}
