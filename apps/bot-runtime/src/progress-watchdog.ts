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
  /**
   * 单调时钟毫秒（performance.now()）。提供时所有 elapsed/窗口/deadline 计算
   * 都用它（NTP/系统时间回拨不会伪造或吞掉 stuck 判定）；observedAtMs 仅作
   * wall-clock 展示。
   */
  monotonicMs?: number;
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

/** 滑动窗口诊断（有界数值；不进 fingerprint，供 Incident 的 actual/上下文解释）。 */
export type ProgressWindowDiagnostics = Readonly<{
  windowNetDisplacement: number;
  windowTargetDistanceDrop: number | null;
  windowPathLength: number;
  reversals: number;
  noMaterialProgressMs: number;
}>;

export type ProgressWatchdogEvent = Readonly<{
  kind: ProgressWatchdogEventKind;
  observedAtMs: number;
  ageMs: number;
  goalKey: string | null;
  recoverySuggested: "local-unstuck" | "local-replan" | "high-level-replan" | null;
  phaseKey?: string;
  diagnostics?: ProgressWindowDiagnostics;
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
  /** movement 契约窗口（净结果判定窗）。 */
  progressWindowMs: number;
  /** 窗口净位移 ≥ 此值才算 material progress。 */
  netDisplacementEpsilon: number;
  /** 窗口内到目标距离下降 ≥ 此值也算 material progress（慢速持续接近）。 */
  distanceDropEpsilon: number;
  /** 反向计数 ≥ 此值且窗口净位移在 [oscillationNetMin, oscillationNetMax] 且路径 ≥ 2×净 → oscillation。 */
  oscillationMinReversals: number;
  oscillationNetMin: number;
  oscillationNetMax: number;
  /** 两次 oscillation 之间的最小间隔（去重冷却）。 */
  oscillationCooldownMs: number;
}>;

/**
 * 生产默认阈值：慢速 STUCK 判定 35s、整体无进展 90s。
 * 不允许为了让测试通过而压到 5/8 秒 —— E2E 必须走显式 test-only profile。
 */
export const DEFAULT_PROGRESS_WATCHDOG_CONFIG: ProgressWatchdogConfig = Object.freeze({
  stuckAfterMs: 35_000,
  noProgressAfterMs: 90_000,
  movementEpsilon: 0.05,
  distanceEpsilon: 0.05,
  loopWindow: 8,
  repeatedGoalLimit: 4,
  pathResetLimit: 5,
  oscillationRadius: 2,
  progressWindowMs: 5_000,
  netDisplacementEpsilon: 2,
  distanceDropEpsilon: 1,
  oscillationMinReversals: 3,
  oscillationNetMin: 0.5,
  oscillationNetMax: 5,
  oscillationCooldownMs: 10_000,
});

/** E2E 显式 test-only profile（约 8 秒阈值；由 STUDIO_WATCHDOG_PROFILE=e2e 激活）。 */
export const E2E_PROGRESS_WATCHDOG_CONFIG: Partial<ProgressWatchdogConfig> = Object.freeze({
  stuckAfterMs: 8_000,
  noProgressAfterMs: 20_000,
});

export type WatchdogProfile = "production" | "e2e";

/**
 * 从环境解析 watchdog 配置。生产零配置 → production 阈值；仅当显式
 * STUDIO_WATCHDOG_PROFILE=e2e（test-only）才允许缩短阈值。任何其他值
 * fail closed（抛错），避免拼错的环境变量静默变成未知 profile。
 */
export function resolveWatchdogProfile(environment: Readonly<Record<string, string | undefined>> = process.env): WatchdogProfile {
  const value = environment.STUDIO_WATCHDOG_PROFILE?.trim();
  if (value === undefined || value === "") return "production";
  if (value === "e2e") return "e2e";
  throw new Error(`STUDIO_WATCHDOG_PROFILE 必须是 production|e2e（收到：${value}）`);
}

export function resolveProgressWatchdogConfig(environment: Readonly<Record<string, string | undefined>> = process.env): Partial<ProgressWatchdogConfig> {
  return resolveWatchdogProfile(environment) === "e2e" ? E2E_PROGRESS_WATCHDOG_CONFIG : {};
}

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
  /** movement 滑动窗口（净结果判定）；goal 切换即清空。 */
  private window: Array<{ atMs: number; x: number; y: number; z: number; targetDistance: number | null }> = [];
  private windowPathLength = 0;
  private lastWindowDiagnostics: ProgressWindowDiagnostics | null = null;
  /** 最后一次 material progress（窗口净结果）时间。 */
  private lastMaterialProgressAtMs: number | null = null;
  private lastOscillationAtMs = Number.NEGATIVE_INFINITY;
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
      !Number.isFinite(this.config.oscillationRadius) || this.config.oscillationRadius < 0 ||
      !Number.isSafeInteger(this.config.progressWindowMs) || this.config.progressWindowMs < 1_000 ||
      !Number.isFinite(this.config.netDisplacementEpsilon) || this.config.netDisplacementEpsilon <= 0 ||
      !Number.isFinite(this.config.distanceDropEpsilon) || this.config.distanceDropEpsilon <= 0 ||
      !Number.isSafeInteger(this.config.oscillationMinReversals) || this.config.oscillationMinReversals < 2 ||
      !Number.isFinite(this.config.oscillationNetMin) || !Number.isFinite(this.config.oscillationNetMax) ||
      this.config.oscillationNetMin >= this.config.oscillationNetMax ||
      !Number.isSafeInteger(this.config.oscillationCooldownMs) || this.config.oscillationCooldownMs < 1_000
    ) {
      throw new TypeError("Progress watchdog configuration is invalid.");
    }
  }

  observe(sample: ProgressSample): readonly ProgressWatchdogEvent[] {
    this.validateSample(sample);
    // 单调时钟优先：所有 elapsed/窗口/deadline 计算用它（防 NTP 回拨伪造/吞掉判定）
    const nowMs = sample.monotonicMs ?? sample.observedAtMs;
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
    if (this.lastProgressAtMs === null) this.lastProgressAtMs = nowMs;

    const moved = previous !== null && Math.hypot(
      sample.position.x - previous.position.x,
      sample.position.y - previous.position.y,
      sample.position.z - previous.position.z,
    ) > this.config.movementEpsilon;

    const inventoryChanged = previous !== null &&
      sample.inventoryFingerprint !== undefined &&
      sample.inventoryFingerprint !== previous.inventoryFingerprint;

    // goal 切换 = 新任务阶段：清窗口
    if (goalChanged) {
      this.window = [];
      this.windowPathLength = 0;
    }

    // ---- 滑动窗口净结果（Round 5：区分真实推进 vs 抖动/往返）----
    const lastWindowSample = this.window.at(-1);
    if (lastWindowSample) {
      this.windowPathLength += Math.hypot(
        sample.position.x - lastWindowSample.x,
        sample.position.y - lastWindowSample.y,
        sample.position.z - lastWindowSample.z,
      );
    }
    this.window.push({
      atMs: nowMs,
      x: sample.position.x, y: sample.position.y, z: sample.position.z,
      targetDistance: sample.targetDistance ?? null,
    });
    const windowCutoff = nowMs - this.config.progressWindowMs;
    while (this.window.length > 2 && this.window[0]!.atMs < windowCutoff) this.window.shift();
    const windowFirst = this.window[0]!;
    const windowLast = this.window.at(-1)!;
    const windowNetDisplacement = Math.hypot(
      windowLast.x - windowFirst.x, windowLast.y - windowFirst.y, windowLast.z - windowFirst.z,
    );
    const windowTargetDistanceDrop =
      windowFirst.targetDistance !== null && windowLast.targetDistance !== null
        ? windowFirst.targetDistance - windowLast.targetDistance
        : null;
    // 反向计数：相邻位移向量点积 < 0（180° 往返）
    let windowReversals = 0;
    for (let i = 2; i < this.window.length; i += 1) {
      const a = this.window[i - 2]!; const b = this.window[i - 1]!; const c = this.window[i]!;
      const dx1 = b.x - a.x, dy1 = b.y - a.y, dz1 = b.z - a.z;
      const dx2 = c.x - b.x, dy2 = c.y - b.y, dz2 = c.z - b.z;
      const l1 = Math.hypot(dx1, dy1, dz1); const l2 = Math.hypot(dx2, dy2, dz2);
      if (l1 > this.config.movementEpsilon && l2 > this.config.movementEpsilon &&
          dx1 * dx2 + dy1 * dy2 + dz1 * dz2 < 0) {
        windowReversals += 1;
      }
    }
    this.lastWindowDiagnostics = {
      windowNetDisplacement,
      windowTargetDistanceDrop,
      windowPathLength: this.windowPathLength,
      reversals: windowReversals,
      noMaterialProgressMs: Math.max(0, nowMs - (this.lastMaterialProgressAtMs ?? this.lastProgressAtMs ?? nowMs)),
    };
    const ageMs = Math.max(0, nowMs - (this.lastProgressAtMs ?? nowMs));

    // material progress = 窗口净结果（净位移 / 距离持续下降），不再是"有活动"
    const materialProgress = inventoryChanged ||
      windowNetDisplacement >= this.config.netDisplacementEpsilon ||
      (windowTargetDistanceDrop !== null && windowTargetDistanceDrop >= this.config.distanceDropEpsilon);
    const progress = previous === null || goalChanged || materialProgress;
    if (progress) {
      this.lastProgressAtMs = nowMs;
      this.stuckReported = false;
      this.noProgressReported = false;
      if (materialProgress) this.lastMaterialProgressAtMs = nowMs;
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

    // 震荡检测（两条互补规则，共用去重标志；证据消失才复位）：
    //   R1 半径规则：窗口内两两距离全 ≤ oscillationRadius 且在移动
    //   R2 反向规则：span≥3s、样本≥6、反向 ≥3、净位移 ∈ [netMin, netMax]、路径 ≥ 2×净
    if (!waitingStyle && this.lastWindowDiagnostics !== null) {
      const diag = this.lastWindowDiagnostics;
      const windowSamples = this.window.length;
      const windowSpan = windowSamples >= 2 ? windowLast.atMs - this.window[0]!.atMs : 0;
      let maxPairwise = 0;
      for (const a of this.window) {
        for (const b of this.window) {
          maxPairwise = Math.max(maxPairwise, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
        }
      }
      const radiusOscillation = maxPairwise <= this.config.oscillationRadius && moved && windowSamples >= 4;
      const reversalOscillation =
        windowSpan >= 3_000 &&
        windowSamples >= 6 &&
        diag.reversals >= this.config.oscillationMinReversals &&
        diag.windowNetDisplacement >= this.config.oscillationNetMin &&
        diag.windowNetDisplacement <= this.config.oscillationNetMax &&
        diag.windowPathLength >= 2 * Math.max(diag.windowNetDisplacement, 1);
      const evidenceGone =
        maxPairwise > this.config.oscillationRadius && windowSamples >= 4 &&
        (windowSpan < 3_000 || windowSamples < 6 || diag.reversals < this.config.oscillationMinReversals ||
         diag.windowNetDisplacement > this.config.oscillationNetMax);
      const cooldownElapsed = nowMs - this.lastOscillationAtMs >= this.config.oscillationCooldownMs;
      if ((radiusOscillation || reversalOscillation) && !this.oscillationReported && cooldownElapsed) {
        this.oscillationReported = true;
        this.oscillationCount += 1;
        this.lastOscillationAtMs = nowMs;
        events.push(Object.freeze({
          kind: "oscillation", observedAtMs: sample.observedAtMs, ageMs, goalKey,
          recoverySuggested: "local-replan", ...(sample.phaseKey ? { phaseKey: sample.phaseKey } : {}),
          ...(this.lastWindowDiagnostics ? { diagnostics: this.lastWindowDiagnostics } : {}),
        }));
      } else if (evidenceGone && cooldownElapsed) {
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
        this.phaseStart.push({ key: sample.phaseKey, startedAtMs: nowMs });
        this.deadlineReportedForKey = null;
        if (this.phaseStart.length > 8) this.phaseStart.shift();
      }
      const startedAt = this.phaseStart.find((entry) => entry.key === sample.phaseKey)!.startedAtMs;
      this.pendingContractDeadline = { key: sample.phaseKey, deadlineAtMs: startedAt + resolvedContract.deadlineMs };
    }
    // 等待型期待：静止正常；只看 deadline
    if (sample.phaseDeadlineMs !== undefined && sample.phaseKey) {
      const deadlinePassed = nowMs >= sample.phaseDeadlineMs;
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
      if (this.pendingContractDeadline.key === sample.phaseKey && nowMs >= this.pendingContractDeadline.deadlineAtMs && this.deadlineReportedForKey !== sample.phaseKey) {
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
          ...(this.lastWindowDiagnostics ? { diagnostics: this.lastWindowDiagnostics } : {}),
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
    if (this.previous !== null && sample.monotonicMs !== undefined && this.previous.monotonicMs !== undefined) {
      if (sample.monotonicMs < this.previous.monotonicMs) throw new TypeError("Watchdog sample time moved backwards.");
    } else if (this.previous !== null && sample.observedAtMs < this.previous.observedAtMs) {
      throw new TypeError("Watchdog sample time moved backwards.");
    }
  }
}
