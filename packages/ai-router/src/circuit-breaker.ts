// ---------------------------------------------------------------------------
// AICircuitBreaker —— Local AI（Spark）推理连接的熔断器
//
// closed（正常）→ 连续失败 ≥ threshold（在 windowMs 内）→ open（快速失败，
// 不再打网络）；冷却 cooldownMs 后 → half-open（放行 maxProbes 个探测请求）；
// 探测成功 → closed，探测失败 → 重新 open。所有参数有界。
// 半开期间非探测请求快速失败（AI_CIRCUIT_OPEN）——上层按 AI_UNAVAILABLE 降级。
// ---------------------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** 连续失败阈值（open 触发条件）。 */
  readonly failureThreshold: number;
  /** 失败计数窗口（ms）：窗口外的旧失败不累计。 */
  readonly windowMs: number;
  /** open → half-open 冷却时间。 */
  readonly cooldownMs: number;
  /** half-open 期间允许的探测请求数。 */
  readonly maxProbes: number;
  readonly now?: () => number;
}

export interface CircuitBreakerSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly failureThreshold: number;
  readonly openedAt: number | null;
  readonly lastFailureAt: number | null;
  readonly lastFailureReason: string | null;
  readonly halfOpenProbes: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly rejectedCount: number;
}

export class CircuitOpenError extends Error {
  constructor(
    message: string,
    readonly snapshot: CircuitBreakerSnapshot,
  ) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

const DEFAULTS: Required<Omit<CircuitBreakerOptions, "now">> = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
  maxProbes: 1,
};

export class AICircuitBreaker {
  private readonly options: Required<CircuitBreakerOptions>;
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailureReason: string | null = null;
  private halfOpenProbes = 0;
  private successCount = 0;
  private failureCount = 0;
  private rejectedCount = 0;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = {
      failureThreshold: bounded(options.failureThreshold ?? DEFAULTS.failureThreshold, 1, 100, "failureThreshold"),
      windowMs: bounded(options.windowMs ?? DEFAULTS.windowMs, 1_000, 600_000, "windowMs"),
      cooldownMs: bounded(options.cooldownMs ?? DEFAULTS.cooldownMs, 500, 600_000, "cooldownMs"),
      maxProbes: bounded(options.maxProbes ?? DEFAULTS.maxProbes, 1, 10, "maxProbes"),
      now: options.now ?? (() => Date.now()),
    };
  }

  /** 请求通过前的准入检查：open/half-open 满员时快速失败（不打网络）。 */
  beforeCall(): void {
    const now = this.options.now();
    if (this.state === "open") {
      if (now - (this.openedAt ?? now) >= this.options.cooldownMs) {
        this.state = "half-open";
        this.halfOpenProbes = 0;
      } else {
        this.rejectedCount += 1;
        throw new CircuitOpenError(
          `AI circuit open (cooldown ${this.options.cooldownMs}ms, failures=${this.consecutiveFailures}); failing fast without network call`,
          this.snapshot(),
        );
      }
    }
    if (this.state === "half-open") {
      if (this.halfOpenProbes >= this.options.maxProbes) {
        this.rejectedCount += 1;
        throw new CircuitOpenError(
          `AI circuit half-open with ${this.halfOpenProbes}/${this.options.maxProbes} probes in flight; failing fast`,
          this.snapshot(),
        );
      }
      this.halfOpenProbes += 1;
      return;
    }
  }

  recordSuccess(): void {
    this.successCount += 1;
    this.consecutiveFailures = 0;
    this.halfOpenProbes = 0;
    if (this.state === "half-open") {
      this.state = "closed"; // 探测成功 → 恢复
      this.openedAt = null;
    }
  }

  /** Caller cancellation is not evidence of provider failure or recovery. */
  recordCancellation(): void {
    if (this.state === "half-open") this.halfOpenProbes = Math.max(0, this.halfOpenProbes - 1);
  }

  recordFailure(reason: string): void {
    const now = this.options.now();
    const previousFailureAt = this.lastFailureAt;
    this.failureCount += 1;
    this.lastFailureAt = now;
    this.lastFailureReason = reason.slice(0, 200);
    if (this.state === "closed") {
      // 失败计数窗口：上一次失败出窗后旧序列不再累计
      if (previousFailureAt !== null && now - previousFailureAt > this.options.windowMs) {
        this.consecutiveFailures = 0;
      }
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.options.failureThreshold) {
        this.state = "open";
        this.openedAt = now;
      }
    } else if (this.state === "half-open") {
      // 探测失败 → 重新 open（重新计时冷却）
      this.state = "open";
      this.openedAt = now;
      this.halfOpenProbes = 0;
    }
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.state === "open" ? this.consecutiveFailures : Math.min(this.consecutiveFailures, this.options.failureThreshold - 1),
      failureThreshold: this.options.failureThreshold,
      openedAt: this.openedAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureReason: this.lastFailureReason,
      halfOpenProbes: this.halfOpenProbes,
      successCount: this.successCount,
      failureCount: this.failureCount,
      rejectedCount: this.rejectedCount,
    };
  }
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer in [${minimum}, ${maximum}].`);
  }
  return value;
}
