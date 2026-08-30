/** Deterministic local progress monitoring.  It never asks the planner what
 * to do; it only reports bounded recovery signals to the runtime. */

/**
 * Expected-progress contract（十一节）：
 *   movement            期待位移/target distance 推进（默认语义）
 *   inventory_change    期待背包变化（craft/collect；站立正常）
 *   world_state_change  期待方块/世界状态变化（place/break；站立正常）
 *   server_event        期待服务器事件（smelt output、chunk 等；站立正常）
 *   timer_wait          纯等待（熔炼计时等；静止即正常，只有 deadline 超时才报）
 *   external_completion 等待外部完成（LLM 回复等；同上）
 */
export type PhaseExpectation =
  | "movement"
  | "inventory_change"
  | "world_state_change"
  | "server_event"
  | "timer_wait"
  | "external_completion";

/**
 * FailureSignal —— watchdog 的唯一输出语义（第 3 节）。
 * Watchdog 只产生有界结构化信号；是否升级为 Incident 由
 * runtime/IncidentReporter 决定。Watchdog 自身不做 IO、不做上报。
 */
export type FailureSignal = ProgressWatchdogEvent;

/**
 * 按动作/阶段定义的进度契约（第 2 节：不按 Skill 名判断）。
 * 每个契约声明：期望信号类型、静止是否正常、默认 deadline（自 phase 开始）。
 * 新增 Skill 时映射到既有契约，而不是为每个 Skill 补防误报逻辑。
 */
export const PROGRESS_CONTRACTS = Object.freeze({
  MOVE_TO_TARGET: Object.freeze({ expectation: "movement" as const, stationaryOk: false, deadlineMs: 120_000 }),
  PLACE_AND_VERIFY: Object.freeze({ expectation: "world_state_change" as const, stationaryOk: true, deadlineMs: 45_000 }),
  SMELTING_WAIT: Object.freeze({ expectation: "server_event" as const, stationaryOk: true, deadlineMs: 60_000 }),
  WAITING_EXTERNAL: Object.freeze({ expectation: "timer_wait" as const, stationaryOk: true, deadlineMs: 45_000 }),
  /** 恢复阶段有独立超时——不能无限豁免 watchdog。 */
  RECOVERING: Object.freeze({ expectation: "timer_wait" as const, stationaryOk: true, deadlineMs: 30_000 }),
} as const);

export type ProgressContractName = keyof typeof PROGRESS_CONTRACTS;

/**
 * 动作名（skill id）→ 进度契约。集中一处；未列出的动作按 movement 归属推断。
 * movementOwner 存在时永远是 MOVE_TO_TARGET（寻路是唯一位移来源）。
 */
export function progressContractForAction(actionTitle: string | null | undefined, movementOwner: string | null | undefined): ProgressContractName | undefined {
  if (movementOwner !== null && movementOwner !== undefined) return "MOVE_TO_TARGET";
  if (!actionTitle) return undefined;
  const title = actionTitle.toLowerCase();
  if (title.includes("smelt")) return "SMELTING_WAIT";
  if (title.includes("place") || title.includes("build") || title.includes("blueprint")) return "PLACE_AND_VERIFY";
  if (title.includes("recover") || title.includes("unstuck") || title.includes("replan")) return "RECOVERING";
  if (title.includes("wait") || title.includes("observe") || title.includes("trade")) return "WAITING_EXTERNAL";
  return undefined;
}

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
  /** 当前 phase 的期望信号（缺省按 movementExpected 旧语义；contract 优先）。 */
  phaseExpectation?: PhaseExpectation;
  /** 动作/阶段契约名（PROGRESS_CONTRACTS 键；未知名直接抛错）。 */
  contract?: ProgressContractName | undefined;
  /** phase 标识（deadline-exceeded 去重键）。 */
  phaseKey?: string;
  /** phase 绝对截止时间；超过且无预期信号 → deadline-exceeded。 */
  phaseDeadlineMs?: number;
}>;

export type ProgressWatchdogEventKind =
  | "progress"
  | "stuck"
  | "no-progress"
  | "loop"
  | "oscillation"
  | "deadline-exceeded";

export type ProgressWatchdogEvent = Readonly<{
  kind: ProgressWatchdogEventKind;
  observedAtMs: number;
  ageMs: number;
  goalKey: string | null;
  recoverySuggested: "local-unstuck" | "local-replan" | "high-level-replan" | null;
  phaseKey?: string;
}>;

export type ProgressWatchdogConfig = Readonly<{
  stuckAfterMs: number;
  noProgressAfterMs: number;
  movementEpsilon: number;
  distanceEpsilon: number;
  loopWindow: number;
  repeatedGoalLimit: number;
  pathResetLimit: number;
  /** 震荡检测半径（格）；窗口内全部样本彼此距离 ≤ radius 且有移动 → oscillation。 */
  oscillationRadius: number;
}>;

export const DEFAULT_PROGRESS_WATCHDOG_CONFIG: ProgressWatchdogConfig = Object.freeze({
  stuckAfterMs: 8_000,
  noProgressAfterMs: 20_000,
  movementEpsilon: 0.05,
  distanceEpsilon: 0.05,
  loopWindow: 8,
  repeatedGoalLimit: 4,
  pathResetLimit: 5,
  oscillationRadius: 2,
});

export type ProgressWatchdogSnapshot = Readonly<{
  lastProgressAtMs: number | null;
  stuckCount: number;
  noProgressCount: number;
  loopCount: number;
  oscillationCount: number;
  deadlineCount: number;
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
  private oscillationCount = 0;
  private deadlineCount = 0;
  private stuckReported = false;
  private noProgressReported = false;
  private loopReported = false;
  private oscillationReported = false;
  private deadlineReportedForKey: string | null = null;
  private pathResetBaseline: number | null = null;
  private recentPositions: Array<Readonly<{ x: number; y: number; z: number }>> = [];
  private readonly phaseStart: Array<{ key: string; startedAtMs: number }> = [];
  private pendingContractDeadline: { key: string | undefined; deadlineAtMs: number } | null = null;

  constructor(config: Partial<ProgressWatchdogConfig> = {}) {
    this.config = Object.freeze({ ...DEFAULT_PROGRESS_WATCHDOG_CONFIG, ...config });
    if (
      !Number.isSafeInteger(this.config.stuckAfterMs) || this.config.stuckAfterMs < 500 ||
      !Number.isSafeInteger(this.config.noProgressAfterMs) || this.config.noProgressAfterMs < this.config.stuckAfterMs ||
      !Number.isFinite(this.config.movementEpsilon) || this.config.movementEpsilon < 0 ||
      !Number.isFinite(this.config.distanceEpsilon) || this.config.distanceEpsilon < 0 ||
      !Number.isSafeInteger(this.config.loopWindow) || this.config.loopWindow < 2 ||
      !Number.isSafeInteger(this.config.repeatedGoalLimit) || this.config.repeatedGoalLimit < 2 ||
      !Number.isSafeInteger(this.config.pathResetLimit) || this.config.pathResetLimit < 1 ||
      !Number.isFinite(this.config.oscillationRadius) || this.config.oscillationRadius < 0
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

    // 震荡窗口：仅 movement 期待下跟踪；逃出半径即复位
    if (moved) {
      this.recentPositions.push(sample.position);
      if (this.recentPositions.length > this.config.loopWindow) this.recentPositions.shift();
    }
    const ageMs = Math.max(0, sample.observedAtMs - (this.lastProgressAtMs ?? sample.observedAtMs));
    const events: ProgressWatchdogEvent[] = [];
    if (progress) {
      events.push(Object.freeze({ kind: "progress", observedAtMs: sample.observedAtMs, ageMs: 0, goalKey, recoverySuggested: null }));
    }

    // expected-progress contract 判定：contract 注册表 > 旧 phaseExpectation > movementExpected
    if (sample.contract !== undefined && !(sample.contract in PROGRESS_CONTRACTS)) {
      throw new TypeError(`Unknown progress contract: ${sample.contract}`);
    }
    const resolvedContract = sample.contract !== undefined ? PROGRESS_CONTRACTS[sample.contract] : null;
    const expectation = resolvedContract
      ? resolvedContract.expectation
      : (sample.phaseExpectation ?? (sample.movementExpected === false ? "timer_wait" : "movement"));
    const waitingStyle = expectation !== "movement";

    // 震荡检测：仅 movement 期待；窗口内两两距离全 ≤ 半径 → 报一次；逃出半径 → 复位
    if (!waitingStyle && this.recentPositions.length >= 4) {
      const window = this.recentPositions.slice(-this.config.loopWindow);
      let maxPairwise = 0;
      for (const a of window) {
        for (const b of window) {
          maxPairwise = Math.max(maxPairwise, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
        }
      }
      if (maxPairwise <= this.config.oscillationRadius) {
        if (!this.oscillationReported) {
          this.oscillationReported = true;
          this.oscillationCount += 1;
          events.push(Object.freeze({
            kind: "oscillation", observedAtMs: sample.observedAtMs, ageMs, goalKey,
            recoverySuggested: "local-replan", ...(sample.phaseKey ? { phaseKey: sample.phaseKey } : {}),
          }));
        }
      } else {
        this.oscillationReported = false;
      }
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

    // 契约默认 deadline：phaseKey 变化时记录起点，超 contract.deadlineMs 触发
    if (resolvedContract && sample.phaseKey && sample.phaseDeadlineMs === undefined) {
      if (this.phaseStart.at(-1)?.key !== sample.phaseKey) {
        this.phaseStart.push({ key: sample.phaseKey, startedAtMs: sample.observedAtMs });
        this.deadlineReportedForKey = null;
        if (this.phaseStart.length > 8) this.phaseStart.shift();
      }
      const startedAt = this.phaseStart.find((entry) => entry.key === sample.phaseKey)!.startedAtMs;
      this.pendingContractDeadline = { key: sample.phaseKey, deadlineAtMs: startedAt + resolvedContract.deadlineMs };
    }
    // 等待型期待：静止正常；只看 deadline
    if (sample.phaseDeadlineMs !== undefined && sample.phaseKey) {
      const deadlinePassed = sample.observedAtMs >= sample.phaseDeadlineMs;
      const phaseChanged = this.deadlineReportedForKey !== null && this.deadlineReportedForKey !== sample.phaseKey;
      if (deadlinePassed && !phaseChanged && this.deadlineReportedForKey !== sample.phaseKey) {
        this.deadlineReportedForKey = sample.phaseKey ?? null;
        this.deadlineCount += 1;
        events.push(Object.freeze({
          kind: "deadline-exceeded", observedAtMs: sample.observedAtMs, ageMs, goalKey,
          recoverySuggested: "high-level-replan",
          ...(sample.phaseKey === undefined ? {} : { phaseKey: sample.phaseKey }),
        }));
      }
    }

    // 契约默认 deadline 判定（sample 未显式给 phaseDeadlineMs 时）
    if (this.pendingContractDeadline && sample.phaseDeadlineMs === undefined) {
      if (this.pendingContractDeadline.key === sample.phaseKey && sample.observedAtMs >= this.pendingContractDeadline.deadlineAtMs && this.deadlineReportedForKey !== sample.phaseKey) {
        this.deadlineReportedForKey = sample.phaseKey ?? null;
        this.deadlineCount += 1;
        events.push(Object.freeze({
          kind: "deadline-exceeded", observedAtMs: sample.observedAtMs, ageMs, goalKey,
          recoverySuggested: "high-level-replan",
          ...(sample.phaseKey === undefined ? {} : { phaseKey: sample.phaseKey }),
        }));
      }
    }

    // stuck/no-progress 只适用于 movement 期待
    if (!waitingStyle) {
      if (ageMs >= this.config.stuckAfterMs && !this.stuckReported) {
        this.stuckReported = true;
        this.stuckCount += 1;
        events.push(Object.freeze({
          kind: "stuck", observedAtMs: sample.observedAtMs, ageMs, goalKey,
          recoverySuggested: "local-unstuck", ...(sample.phaseKey ? { phaseKey: sample.phaseKey } : {}),
        }));
      }
      if (ageMs >= this.config.noProgressAfterMs && !this.noProgressReported) {
        this.noProgressReported = true;
        this.noProgressCount += 1;
        events.push(Object.freeze({
          kind: "no-progress", observedAtMs: sample.observedAtMs, ageMs, goalKey,
          recoverySuggested: "local-replan", ...(sample.phaseKey ? { phaseKey: sample.phaseKey } : {}),
        }));
      }
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
    this.oscillationReported = false;
    this.deadlineReportedForKey = null;
    this.pathResetBaseline = null;
    this.recentPositions = [];
    this.phaseStart.length = 0;
    this.pendingContractDeadline = null;
  }

  snapshot(): ProgressWatchdogSnapshot {
    return Object.freeze({
      lastProgressAtMs: this.lastProgressAtMs,
      stuckCount: this.stuckCount,
      noProgressCount: this.noProgressCount,
      loopCount: this.loopCount,
      oscillationCount: this.oscillationCount,
      deadlineCount: this.deadlineCount,
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
