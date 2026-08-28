/** Deterministic local progress monitoring.  It never asks the planner what
 * to do; it only reports bounded recovery signals to the runtime. */

export type ProgressSample = Readonly<{
  observedAtMs: number;
  position: Readonly<{ x: number; y: number; z: number }>;
  /** Idle bots must not accumulate false stuck/no-progress alarms. */
  active?: boolean;
  /** Stuck requires expected movement; a long craft/smelt is not movement-stuck. */
  movementExpected?: boolean;
  inventoryFingerprint?: string;
  targetDistance?: number | null;
  goalKey?: string | null;
  pathResetCount?: number;
}>;

export type ProgressWatchdogEventKind =
  | "progress"
  | "stuck"
  | "no-progress"
  | "loop";

export type ProgressWatchdogEvent = Readonly<{
  kind: ProgressWatchdogEventKind;
  observedAtMs: number;
  ageMs: number;
  goalKey: string | null;
  recoverySuggested: "local-unstuck" | "local-replan" | "high-level-replan" | null;
}>;

export type ProgressWatchdogConfig = Readonly<{
  stuckAfterMs: number;
  noProgressAfterMs: number;
  movementEpsilon: number;
  distanceEpsilon: number;
  loopWindow: number;
  repeatedGoalLimit: number;
  pathResetLimit: number;
}>;

export const DEFAULT_PROGRESS_WATCHDOG_CONFIG: ProgressWatchdogConfig = Object.freeze({
  stuckAfterMs: 8_000,
  noProgressAfterMs: 20_000,
  movementEpsilon: 0.05,
  distanceEpsilon: 0.05,
  loopWindow: 8,
  repeatedGoalLimit: 4,
  pathResetLimit: 5,
});

export type ProgressWatchdogSnapshot = Readonly<{
  lastProgressAtMs: number | null;
  stuckCount: number;
  noProgressCount: number;
  loopCount: number;
  lastGoalKey: string | null;
  recentGoals: readonly string[];
}>;

export class ProgressWatchdog {
  private readonly config: ProgressWatchdogConfig;
  private previous: ProgressSample | null = null;
  private lastProgressAtMs: number | null = null;
  private lastGoalKey: string | null = null;
  private recentGoals: string[] = [];
  private stuckCount = 0;
  private noProgressCount = 0;
  private loopCount = 0;
  private stuckReported = false;
  private noProgressReported = false;
  private loopReported = false;
  private pathResetBaseline: number | null = null;

  constructor(config: Partial<ProgressWatchdogConfig> = {}) {
    this.config = Object.freeze({ ...DEFAULT_PROGRESS_WATCHDOG_CONFIG, ...config });
    if (
      !Number.isSafeInteger(this.config.stuckAfterMs) || this.config.stuckAfterMs < 500 ||
      !Number.isSafeInteger(this.config.noProgressAfterMs) || this.config.noProgressAfterMs < this.config.stuckAfterMs ||
      !Number.isFinite(this.config.movementEpsilon) || this.config.movementEpsilon < 0 ||
      !Number.isFinite(this.config.distanceEpsilon) || this.config.distanceEpsilon < 0 ||
      !Number.isSafeInteger(this.config.loopWindow) || this.config.loopWindow < 2 ||
      !Number.isSafeInteger(this.config.repeatedGoalLimit) || this.config.repeatedGoalLimit < 2 ||
      !Number.isSafeInteger(this.config.pathResetLimit) || this.config.pathResetLimit < 1
    ) {
      throw new TypeError("Progress watchdog configuration is invalid.");
    }
  }

  observe(sample: ProgressSample): readonly ProgressWatchdogEvent[] {
    this.validateSample(sample);
    if (sample.active === false) {
      this.reset();
      return Object.freeze([]);
    }
    const goalKey = sample.goalKey ?? null;
    const goalChanged = goalKey !== this.lastGoalKey;
    const previous = this.previous;
    const pathResetAdvanced =
      previous !== null &&
      sample.pathResetCount !== undefined &&
      previous.pathResetCount !== undefined &&
      sample.pathResetCount > previous.pathResetCount;
    if (goalKey !== null && (goalChanged || pathResetAdvanced)) {
      this.recentGoals.push(goalKey);
      if (this.recentGoals.length > this.config.loopWindow) this.recentGoals.shift();
    }
    if (goalChanged) {
      this.lastGoalKey = goalKey;
      this.loopReported = false;
      this.pathResetBaseline = sample.pathResetCount ?? null;
    }
    if (this.lastProgressAtMs === null) this.lastProgressAtMs = sample.observedAtMs;

    const moved = previous !== null && Math.hypot(
      sample.position.x - previous.position.x,
      sample.position.y - previous.position.y,
      sample.position.z - previous.position.z,
    ) > this.config.movementEpsilon;
    const distanceImproved = previous !== null &&
      sample.targetDistance != null && previous.targetDistance != null &&
      previous.targetDistance - sample.targetDistance > this.config.distanceEpsilon;
    const inventoryChanged = previous !== null &&
      sample.inventoryFingerprint !== undefined &&
      sample.inventoryFingerprint !== previous.inventoryFingerprint;
    const materialProgress = moved || distanceImproved || inventoryChanged;
    const progress = previous === null || goalChanged || materialProgress;
    if (progress) {
      this.lastProgressAtMs = sample.observedAtMs;
      this.stuckReported = false;
      this.noProgressReported = false;
      if (materialProgress) {
        this.loopReported = false;
        this.pathResetBaseline = sample.pathResetCount ?? null;
        this.recentGoals = goalKey === null ? [] : [goalKey];
      }
    }
    this.previous = sample;

    const ageMs = Math.max(0, sample.observedAtMs - (this.lastProgressAtMs ?? sample.observedAtMs));
    const events: ProgressWatchdogEvent[] = [];
    if (progress) {
      events.push(Object.freeze({ kind: "progress", observedAtMs: sample.observedAtMs, ageMs: 0, goalKey, recoverySuggested: null }));
    }
    const repeatedGoal = goalKey !== null &&
      this.recentGoals.filter((candidate) => candidate === goalKey).length >= this.config.repeatedGoalLimit;
    const alternatingLoop = this.recentGoals.length >= 4 &&
      this.recentGoals.at(-1) === this.recentGoals.at(-3) &&
      this.recentGoals.at(-2) === this.recentGoals.at(-4) &&
      this.recentGoals.at(-1) !== this.recentGoals.at(-2);
    const pathLoop =
      sample.pathResetCount !== undefined &&
      this.pathResetBaseline !== null &&
      sample.pathResetCount - this.pathResetBaseline >= this.config.pathResetLimit;
    if ((repeatedGoal || alternatingLoop || pathLoop) && !this.loopReported) {
      this.loopReported = true;
      this.loopCount += 1;
      events.push(Object.freeze({ kind: "loop", observedAtMs: sample.observedAtMs, ageMs, goalKey, recoverySuggested: "high-level-replan" }));
    }
    if (
      sample.movementExpected !== false &&
      ageMs >= this.config.stuckAfterMs &&
      !this.stuckReported
    ) {
      this.stuckReported = true;
      this.stuckCount += 1;
      events.push(Object.freeze({ kind: "stuck", observedAtMs: sample.observedAtMs, ageMs, goalKey, recoverySuggested: "local-unstuck" }));
    }
    if (ageMs >= this.config.noProgressAfterMs && !this.noProgressReported) {
      this.noProgressReported = true;
      this.noProgressCount += 1;
      events.push(Object.freeze({ kind: "no-progress", observedAtMs: sample.observedAtMs, ageMs, goalKey, recoverySuggested: "local-replan" }));
    }
    return Object.freeze(events);
  }

  reset(): void {
    this.previous = null;
    this.lastProgressAtMs = null;
    this.lastGoalKey = null;
    this.recentGoals = [];
    this.stuckReported = false;
    this.noProgressReported = false;
    this.loopReported = false;
    this.pathResetBaseline = null;
  }

  snapshot(): ProgressWatchdogSnapshot {
    return Object.freeze({
      lastProgressAtMs: this.lastProgressAtMs,
      stuckCount: this.stuckCount,
      noProgressCount: this.noProgressCount,
      loopCount: this.loopCount,
      lastGoalKey: this.lastGoalKey,
      recentGoals: Object.freeze([...this.recentGoals]),
    });
  }

  private validateSample(sample: ProgressSample): void {
    if (!Number.isFinite(sample.observedAtMs)) throw new TypeError("Watchdog sample time is invalid.");
    const position = sample.position;
    if (![position.x, position.y, position.z].every(Number.isFinite)) throw new TypeError("Watchdog sample position is invalid.");
    if (sample.targetDistance != null && (!Number.isFinite(sample.targetDistance) || sample.targetDistance < 0)) throw new TypeError("Watchdog target distance is invalid.");
    if (sample.pathResetCount !== undefined && (!Number.isSafeInteger(sample.pathResetCount) || sample.pathResetCount < 0)) throw new TypeError("Watchdog path reset count is invalid.");
    if (this.previous !== null && sample.observedAtMs < this.previous.observedAtMs) throw new TypeError("Watchdog sample time moved backwards.");
  }
}
