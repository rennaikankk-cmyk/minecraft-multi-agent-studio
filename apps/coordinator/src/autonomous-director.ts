import { randomUUID } from "node:crypto";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  identifierSchema,
  type PublicBotDetailV1,
} from "@minecraft-studio/protocol";
import { scanBlocksOutputSchema } from "@minecraft-studio/skills";

import type {
  BotRegistry,
  BotRegistryRecord,
} from "./bot-registry.js";
import {
  CoordinatorLocalPlanner,
  LocalPlannerError,
} from "./local-planner.js";
import {
  assessSurvivalNeeds,
  type SurvivalNeed,
  type SurvivalNeedKey,
} from "./survival-needs.js";

type PublicTask = NonNullable<PublicBotDetailV1["currentTask"]>;
type TaskStatus = PublicTask["status"];

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  "queued",
  "assigned",
  "running",
  "blocked",
  "waiting",
  "paused",
]);

export type AutonomousTaskView = PublicTask;

export type AutonomousTaskListener = (botId: string) => void;

export type AutonomousTaskSource = Readonly<{
  getCurrentTask: (botId: string, at?: Date) => AutonomousTaskView | null;
  subscribe: (listener: AutonomousTaskListener) => () => void;
  requestManualControl?: (botId: string) => Promise<boolean>;
}>;

export type AutonomousDirectorOptions = Readonly<{
  registry: Pick<BotRegistry, "list" | "get" | "subscribe">;
  planner: Pick<CoordinatorLocalPlanner, "planAndDispatch">;
  intervalMs: number;
  goalTimeoutMs: number;
  failureCooldownMs: number;
  terminalRetentionMs: number;
  logger?: AppLogger;
  now?: () => Date;
  randomId?: () => string;
}>;

type InternalTask = PublicTask & {
  needKey: SurvivalNeedKey;
  goal: string;
  reason: string;
  terminalExpiresAtMs: number | null;
};

type ActiveRun = Readonly<{
  taskId: string;
  controller: AbortController;
  promise: Promise<void>;
}>;

type AutonomousPlanResult = Awaited<
  ReturnType<CoordinatorLocalPlanner["planAndDispatch"]>
>;

/**
 * 沿矿脉继续开掘比换区更优的源方块（与 collect.block 的楼梯回退配合）：
 * 地下矿脉目标换一个水平探索点等于丢掉已有的开掘进度。
 */
const DIRECTIONAL_SOURCE_BLOCKS = new Set([
  "iron_ore",
  "coal_ore",
  "diamond_ore",
]);

/**
 * These are failures where the deterministic Runtime has searched the local
 * area but did not prove a usable target. Repeating the same plan without
 * changing the Bot's observation or position is guaranteed to be noisy, so
 * autonomy gets one bounded scan/explore pass before trying the goal again.
 */
const RESOURCE_RECOVERY_FAILURE_CODES = new Set([
  "COLLECT_PATH_SEARCH_EXHAUSTED",
  "COLLECT_TARGET_UNREACHABLE",
  "COLLECT_BLOCKS_FAILED",
  "COLLECT_PICKUP_NOT_SETTLED",
]);

const AUTONOMOUS_SCAN_MAX_DISTANCE = 64;
const AUTONOMOUS_MAX_RESOURCE_CANDIDATES = 4;
const AUTONOMOUS_RECOVERY_TIMEOUT_MS = 30_000;
const AUTONOMOUS_EXPLORATION_COOLDOWN_MS = 60_000;
/** 探索半径逐次放大；坐标永远来自 Bot 真实位置的确定性偏移。 */
const AUTONOMOUS_EXPLORATION_RADII = Object.freeze([48, 96, 160, 224]);
const AUTONOMOUS_SHELTER_DIRECTIONS = Object.freeze([
  "north",
  "east",
  "south",
  "west",
] as const);
const AUTONOMOUS_SHELTER_MATERIALS = Object.freeze([
  "cobblestone",
  "dirt",
] as const);
/** 同一需求连续失败这么多次后，冷却窗口内不再选中它（livelock 防护）。 */
const AUTONOMOUS_NEED_FAILURE_LIMIT = 3;
const AUTONOMOUS_NEED_SUPPRESSION_MS = 120_000;

type ScannedResourcePosition = Readonly<{
  x: number;
  y: number;
  z: number;
  distance: number;
}>;

/**
 * Keeps every idle, healthy Runtime working on its own survival. The director
 * owns no Minecraft primitive: survival-needs turns Bot state into the next
 * need deterministically, and every need is served through the same
 * Coordinator planner used by the Dashboard, so all Skill and L0 gates stay
 * in one execution path. Spark is never in this loop — the needs ladder and
 * its goal templates are fully deterministic.
 */
export class AutonomousDirector implements AutonomousTaskSource {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly listeners = new Set<AutonomousTaskListener>();
  private readonly tasks = new Map<string, InternalTask>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly nextGoalAt = new Map<string, number>();
  private readonly shelterBuilt = new Set<string>();
  private readonly consecutiveNeedFailures = new Map<string, number>();
  private readonly needSuppressedUntil = new Map<string, number>();
  private readonly explorationCursor = new Map<string, number>();
  private readonly explorationRadiusStep = new Map<string, number>();
  private readonly nextExplorationAt = new Map<string, number>();
  private readonly shelterDirectionCursor = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeRegistry: (() => void) | null = null;
  private started = false;

  constructor(private readonly options: AutonomousDirectorOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    positiveInteger(options.intervalMs, "intervalMs");
    positiveInteger(options.goalTimeoutMs, "goalTimeoutMs");
    positiveInteger(options.failureCooldownMs, "failureCooldownMs");
    positiveInteger(options.terminalRetentionMs, "terminalRetentionMs");
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeRegistry = this.options.registry.subscribe((record) => {
      if (record.connectionState === "online") void this.kick(record.botId);
    });
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
    void this.tick();
    this.log("info", "coordinator_autonomous_director_started", {
      intervalMs: this.options.intervalMs,
      goalTimeoutMs: this.options.goalTimeoutMs,
    });
  }

  async stop(): Promise<void> {
    if (!this.started && this.active.size === 0) return;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    const active = [...this.active.values()];
    for (const run of active) run.controller.abort(new Error("director_shutdown"));
    await Promise.allSettled(active.map(({ promise }) => promise));
    this.log("info", "coordinator_autonomous_director_stopped", {});
  }

  subscribe(listener: AutonomousTaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Give a Dashboard goal priority over this Bot's internal work. The caller
   * waits for the planner to observe the abort and release its assignment
   * before acquiring the manual goal's lease.
   */
  async requestManualControl(botId: string): Promise<boolean> {
    const run = this.active.get(botId);
    if (!run) return false;
    run.controller.abort(new Error("manual_control_requested"));
    await Promise.allSettled([run.promise]);
    return true;
  }

  getCurrentTask(botId: string, at = this.now()): AutonomousTaskView | null {
    const now = validDate(at);
    const task = this.tasks.get(botId);
    if (!task) return null;
    if (
      task.terminalExpiresAtMs !== null &&
      task.terminalExpiresAtMs <= now.getTime()
    ) {
      this.tasks.delete(botId);
      return null;
    }
    return {
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      startedAt: task.startedAt,
    };
  }

  private async tick(): Promise<void> {
    if (!this.started) return;
    let records: readonly BotRegistryRecord[];
    try {
      records = this.options.registry.list(validDate(this.now()));
    } catch (cause) {
      this.log("warn", "coordinator_autonomous_registry_read_failed", {
        error: boundedError(cause),
      });
      return;
    }
    for (const record of records) this.maybeStart(record);
  }

  private async kick(botId: string): Promise<void> {
    if (!this.started) return;
    try {
      const record = this.options.registry.get(botId, validDate(this.now()));
      if (record) this.maybeStart(record);
    } catch (cause) {
      this.log("warn", "coordinator_autonomous_registry_read_failed", {
        botId,
        error: boundedError(cause),
      });
    }
  }

  private maybeStart(record: BotRegistryRecord): void {
    if (!this.started || !eligibleForAutonomy(record)) return;
    if (this.active.has(record.botId)) return;
    const existing = this.tasks.get(record.botId);
    const nowMs = validDate(this.now()).getTime();
    if (existing && isActiveTask(existing.status)) return;
    if (existing?.terminalExpiresAtMs !== null && existing) {
      if (existing.terminalExpiresAtMs > nowMs) return;
      this.tasks.delete(record.botId);
    }
    if ((this.nextGoalAt.get(record.botId) ?? 0) > nowMs) return;

    const goal = this.selectGoal(record, nowMs);
    if (goal === null) return;
    const taskId = identifierSchema.parse(this.randomId());
    const controller = new AbortController();
    const placeholder: ActiveRun = {
      taskId,
      controller,
      promise: Promise.resolve(),
    };
    this.active.set(record.botId, placeholder);
    const promise = this.runTask(record, taskId, goal, controller);
    this.active.set(record.botId, { taskId, controller, promise });
    void promise
      .finally(() => {
        const current = this.active.get(record.botId);
        if (current?.taskId === taskId) this.active.delete(record.botId);
      })
      .catch(() => undefined);
  }

  /**
   * Pure selection over the needs ladder: score-ordered needs from
   * survival-needs, minus suppressed ones, with exploration coordinates and
   * shelter direction bound from per-Bot cursors. The same Bot state always
   * selects the same need; state changes (task success, inventory delta,
   * respawn) re-assess on the next tick.
   */
  private selectGoal(
    record: BotRegistryRecord,
    nowMs: number,
  ): AutonomousGoal | null {
    const needs = assessSurvivalNeeds({
      record,
      shelterBuilt: this.shelterBuilt.has(record.botId),
    });
    const eligible = needs.filter(
      (need) =>
        (this.needSuppressedUntil.get(`${record.botId}:${need.key}`) ?? 0) <=
        nowMs,
    );
    const chosen = eligible[0];
    if (chosen === undefined) return null;
    return this.bindGoal(record, chosen, nowMs);
  }

  /** 把需求意图绑定成可下发的具体目标（方向/封口料/探索坐标）。 */
  private bindGoal(
    record: BotRegistryRecord,
    need: SurvivalNeed,
    nowMs: number,
  ): AutonomousGoal | null {
    if (need.key === "EXPLORATION") {
      if ((this.nextExplorationAt.get(record.botId) ?? 0) > nowMs) return null;
      const target = this.explorationTarget(record);
      if (target === null) return null;
      return {
        needKey: need.key,
        key: "exploration",
        title: `${need.title} (${target.blockName})`,
        operatorGoal: `移动到坐标 x=${target.x} y=${target.y} z=${target.z} 附近，继续观察 ${target.blockName} 方块`,
        reason: need.reason,
        blockName: target.blockName,
        directionalMining: false,
      };
    }
    if (need.key === "SHELTER") {
      const direction = this.nextShelterDirection(record.botId);
      const seal = shelterMaterial(record) ?? "dirt";
      return {
        needKey: need.key,
        key: "shelter",
        title: need.title,
        operatorGoal: `在当前维度向 ${direction} 挖一个 2 格深的安全避难所，并用 ${seal} 封口`,
        reason: need.reason,
        blockName: null,
        directionalMining: false,
      };
    }
    if (need.key === "FOOD_SECURITY") {
      return {
        needKey: need.key,
        key: "food",
        title: need.title,
        operatorGoal: need.operatorGoal,
        reason: need.reason,
        blockName: null,
        directionalMining: false,
      };
    }
    return {
      needKey: need.key,
      key: need.key,
      title: need.title,
      operatorGoal: need.operatorGoal,
      reason: need.reason,
      blockName: need.sourceBlock,
      directionalMining: need.sourceBlock !== null &&
        DIRECTIONAL_SOURCE_BLOCKS.has(need.sourceBlock),
    };
  }

  /** 扇区轮转 + 半径递增的确定性探索；多 Bot 天然错开起始扇区。 */
  private explorationTarget(
    record: BotRegistryRecord,
  ): { x: number; y: number; z: number; blockName: string } | null {
    const position = record.currentStatus?.position;
    if (!position) return null;
    const cursor = this.explorationCursor.get(record.botId) ?? 0;
    const step = this.explorationRadiusStep.get(record.botId) ?? 0;
    const radius = AUTONOMOUS_EXPLORATION_RADII[
      Math.min(step, AUTONOMOUS_EXPLORATION_RADII.length - 1)
    ]!;
    // 基于稳定 botId 哈希的扇区偏移：同批 Bot 各自从不同扇区开始扫。
    const sectorBase = stableSector(record.botId);
    const sector = (sectorBase + cursor) % 8;
    const angle = (sector / 8) * Math.PI * 2;
    const x = Math.floor(position.x + Math.cos(angle) * radius);
    const z = Math.floor(position.z + Math.sin(angle) * radius);
    this.explorationCursor.set(record.botId, cursor + 1);
    this.explorationRadiusStep.set(
      record.botId,
      Math.min(step + 1, AUTONOMOUS_EXPLORATION_RADII.length - 1),
    );
    return {
      x,
      y: Math.floor(position.y),
      z,
      blockName: explorationFocusBlock(record),
    };
  }

  private nextShelterDirection(botId: string): string {
    const index = this.shelterDirectionCursor.get(botId) ?? 0;
    this.shelterDirectionCursor.set(
      botId,
      (index + 1) % AUTONOMOUS_SHELTER_DIRECTIONS.length,
    );
    return AUTONOMOUS_SHELTER_DIRECTIONS[
      index % AUTONOMOUS_SHELTER_DIRECTIONS.length
    ]!;
  }

  private async runTask(
    record: BotRegistryRecord,
    taskId: string,
    goal: AutonomousGoal,
    controller: AbortController,
  ): Promise<void> {
    const startedAt = validDate(this.now()).toISOString();
    // 标题带"为什么"：Dashboard 里直接能看到 WOOD_RESERVE 3/16 这种依据，
    // 而不是一行 walking。
    const taskTitle = `自主任务: ${goal.title}（${goal.reason}）`;
    this.setTask(record.botId, {
      taskId,
      title: taskTitle,
      status: "running",
      startedAt,
      needKey: goal.needKey,
      goal: goal.operatorGoal,
      reason: goal.reason,
      terminalExpiresAtMs: null,
    });
    this.log("info", "coordinator_autonomous_need_selected", {
      botId: record.botId,
      taskId,
      needKey: goal.needKey,
      goal: goal.key,
      reason: goal.reason,
    });
    try {
      let result = await this.options.planner.planAndDispatch({
        requestId: taskId,
        traceId: taskId,
        taskId,
        botId: record.botId,
        operatorGoal: goal.operatorGoal,
        timeoutMs: this.options.goalTimeoutMs,
        signal: controller.signal,
      });
      let status = taskStatusFromPlanResult(result, controller.signal);
      let keepGoal = false;
      const failureCode = autonomousFailureCode(result);
      if (status === "failed" && failureCode !== null && !controller.signal.aborted) {
        const recovery = await this.recoverResourceGoal(
          record,
          taskId,
          goal,
          taskTitle,
          failureCode,
          controller,
        );
        keepGoal = recovery.keepGoal;
        if (recovery.retry !== null) {
          result = recovery.retry;
          status = taskStatusFromPlanResult(result, controller.signal);
        }
      }
      this.finishTask(record.botId, taskId, goal, status, keepGoal);
      this.log("info", "coordinator_autonomous_goal_finished", {
        botId: record.botId,
        taskId,
        needKey: goal.needKey,
        goal: goal.key,
        outcome: status,
        ...(keepGoal ? { recovery: "retry_same_goal" } : {}),
        ...(result.action === "noop" ? { reasonCode: result.reasonCode } : {}),
      });
    } catch (cause) {
      const status: TaskStatus = controller.signal.aborted ? "cancelled" : "failed";
      const failureCode = autonomousFailureCode(cause);
      let keepGoal = false;
      if (failureCode !== null && !controller.signal.aborted) {
        const recovery = await this.recoverResourceGoal(
          record,
          taskId,
          goal,
          taskTitle,
          failureCode,
          controller,
        );
        keepGoal = recovery.keepGoal;
      }
      this.finishTask(record.botId, taskId, goal, status, keepGoal);
      this.log("warn", "coordinator_autonomous_goal_failed", {
        botId: record.botId,
        taskId,
        needKey: goal.needKey,
        goal: goal.key,
        code: cause instanceof LocalPlannerError ? cause.code : "DIRECTOR_FAILED",
        error: boundedError(cause),
        ...(keepGoal ? { recovery: "retry_same_goal" } : {}),
      });
    }
  }

  /**
   * Move a resource goal forward after a local target-search failure. The
   * scan result is a Runtime observation; coordinates are never guessed from
   * the Bot's position. When no target is visible, a sector-rotating move
   * gives the next round a new loaded area while retaining the same need.
   */
  private async recoverResourceGoal(
    record: BotRegistryRecord,
    taskId: string,
    goal: AutonomousGoal,
    taskTitle: string,
    failureCode: string,
    controller: AbortController,
  ): Promise<ResourceRecoveryResult> {
    if (!RESOURCE_RECOVERY_FAILURE_CODES.has(failureCode)) {
      return { retry: null, keepGoal: false };
    }
    // This code means the block may already have been broken while the plugin
    // failed to close its dropped-entity wait. Moving to a new area would add
    // noise and can duplicate collection, so retain the need and let the
    // next inventory-aware plan re-observe it.
    if (failureCode === "COLLECT_PICKUP_NOT_SETTLED") {
      this.setRecoveryTask(record.botId, taskId, "自主恢复: 核对采集结果");
      return { retry: null, keepGoal: true };
    }
    const blockName = goal.blockName;
    if (!blockName || controller.signal.aborted) {
      return { retry: null, keepGoal: true };
    }

    // collect.block opens one bounded staircase toward the observed ore on
    // every attempt. A generic horizontal exploration move abandons that
    // progress and can strand the Bot underground, so keep mining from the
    // current endpoint on the next autonomous round.
    if (
      failureCode === "COLLECT_TARGET_UNREACHABLE" &&
      goal.directionalMining
    ) {
      this.setRecoveryTask(
        record.botId,
        taskId,
        `自主恢复: 继续定向开掘 ${blockName}`,
      );
      this.log("info", "coordinator_autonomous_recovery_mining_continues", {
        botId: record.botId,
        taskId,
        needKey: goal.needKey,
        blockName,
        failureCode,
      });
      return { retry: null, keepGoal: true };
    }

    this.setRecoveryTask(record.botId, taskId, `自主恢复: 搜索 ${blockName}`);
    this.log("info", "coordinator_autonomous_recovery_started", {
      botId: record.botId,
      taskId,
      needKey: goal.needKey,
      blockName,
      failureCode,
    });

    let scan: AutonomousPlanResult;
    try {
      scan = await this.dispatchInternal(
        record.botId,
        taskId,
        `读取当前区域的 ${blockName} 方块分布并给出扫描结果，只读`,
        controller,
      );
    } catch (cause) {
      this.logRecoveryFailure(record.botId, taskId, "scan", cause);
      return { retry: null, keepGoal: true };
    }

    const matches = scannedResourcePositions(scan, blockName);
    for (const match of matches.slice(0, AUTONOMOUS_MAX_RESOURCE_CANDIDATES)) {
      if (controller.signal.aborted) return { retry: null, keepGoal: true };
      const current = this.options.registry.get(
        record.botId,
        validDate(this.now()),
      );
      if (!current?.currentStatus?.position) continue;
      if (distanceTo(current.currentStatus.position, match) > AUTONOMOUS_SCAN_MAX_DISTANCE) {
        continue;
      }
      const moved = await this.dispatchInternal(
        record.botId,
        taskId,
        `移动到坐标 x=${match.x} y=${match.y} z=${match.z} 附近，继续观察 ${blockName} 方块`,
        controller,
      ).catch((cause) => {
        this.logRecoveryFailure(record.botId, taskId, "move-to-resource", cause);
        return null;
      });
      if (!planCompleted(moved)) continue;

      this.setRecoveryTask(record.botId, taskId, taskTitle);
      const retry = await this.dispatchInternal(
        record.botId,
        taskId,
        goal.operatorGoal,
        controller,
      ).catch((cause) => {
        this.logRecoveryFailure(record.botId, taskId, "goal-retry", cause);
        return null;
      });
      if (retry !== null && taskStatusFromPlanResult(retry, controller.signal) === "completed") {
        this.log("info", "coordinator_autonomous_recovery_succeeded", {
          botId: record.botId,
          taskId,
          needKey: goal.needKey,
          blockName,
        });
        return { retry, keepGoal: false };
      }
    }

    const nowMs = validDate(this.now()).getTime();
    const nextExplorationAt = this.nextExplorationAt.get(record.botId) ?? 0;
    if (nextExplorationAt > nowMs) {
      this.setRecoveryTask(record.botId, taskId, "自主恢复: 等待下一次资源扫描");
      this.log("info", "coordinator_autonomous_recovery_exploration_cooldown", {
        botId: record.botId,
        taskId,
        needKey: goal.needKey,
        blockName,
        retryAtMs: nextExplorationAt,
      });
      return { retry: null, keepGoal: true };
    }

    this.nextExplorationAt.set(
      record.botId,
      nowMs + AUTONOMOUS_EXPLORATION_COOLDOWN_MS,
    );
    const target = this.explorationTarget(record);
    const explorationGoal = target === null
      ? `继续观察 ${blockName} 方块所在区域`
      : `移动到坐标 x=${target.x} y=${target.y} z=${target.z} 附近，继续观察 ${blockName} 方块`;
    const moved = await this.dispatchInternal(
      record.botId,
      taskId,
      explorationGoal,
      controller,
    ).catch((cause) => {
      this.logRecoveryFailure(record.botId, taskId, "explore", cause);
      return null;
    });
    this.setRecoveryTask(record.botId, taskId, taskTitle);
    this.log("info", "coordinator_autonomous_recovery_explored", {
      botId: record.botId,
      taskId,
      needKey: goal.needKey,
      blockName,
      moved: planCompleted(moved),
    });
    return { retry: null, keepGoal: true };
  }

  private async dispatchInternal(
    botId: string,
    taskId: string,
    operatorGoal: string,
    controller: AbortController,
  ): Promise<AutonomousPlanResult> {
    const requestId = identifierSchema.parse(this.randomId());
    return this.options.planner.planAndDispatch({
      requestId,
      traceId: requestId,
      taskId,
      botId,
      operatorGoal,
      timeoutMs: Math.min(
        this.options.goalTimeoutMs,
        AUTONOMOUS_RECOVERY_TIMEOUT_MS,
      ),
      signal: controller.signal,
    });
  }

  private setRecoveryTask(botId: string, taskId: string, title: string): void {
    const current = this.tasks.get(botId);
    if (!current || current.taskId !== taskId || current.status !== "running") return;
    this.setTask(botId, { ...current, title });
  }

  private logRecoveryFailure(
    botId: string,
    taskId: string,
    phase: string,
    cause: unknown,
  ): void {
    this.log("warn", "coordinator_autonomous_recovery_failed", {
      botId,
      taskId,
      phase,
      error: boundedError(cause),
    });
  }

  private finishTask(
    botId: string,
    taskId: string,
    goal: AutonomousGoal,
    status: TaskStatus,
    keepGoal: boolean,
  ): void {
    const nowMs = validDate(this.now()).getTime();
    const failureKey = `${botId}:${goal.needKey}`;
    if (status === "completed") {
      this.consecutiveNeedFailures.set(failureKey, 0);
      if (goal.needKey === "SHELTER") this.shelterBuilt.add(botId);
    } else if (status === "failed") {
      const failures = (this.consecutiveNeedFailures.get(failureKey) ?? 0) + 1;
      this.consecutiveNeedFailures.set(failureKey, failures);
      if (failures >= AUTONOMOUS_NEED_FAILURE_LIMIT) {
        this.needSuppressedUntil.set(
          failureKey,
          nowMs + AUTONOMOUS_NEED_SUPPRESSION_MS,
        );
        this.consecutiveNeedFailures.set(failureKey, 0);
        this.log("warn", "coordinator_autonomous_need_suppressed", {
          botId,
          needKey: goal.needKey,
          failures,
          suppressedUntilMs: nowMs + AUTONOMOUS_NEED_SUPPRESSION_MS,
        });
      }
    }
    this.nextGoalAt.set(
      botId,
      nowMs + (status === "completed"
        ? this.options.intervalMs
        : this.options.failureCooldownMs),
    );
    const current = this.tasks.get(botId);
    if (!current || current.taskId !== taskId) return;
    this.setTask(botId, {
      ...current,
      status,
      terminalExpiresAtMs: nowMs + this.options.terminalRetentionMs,
    });
  }

  private setTask(botId: string, task: InternalTask): void {
    this.tasks.set(botId, task);
    for (const listener of this.listeners) {
      try {
        listener(botId);
      } catch {
        // Presentation subscribers cannot affect autonomous execution.
      }
    }
  }

  private log(
    level: "info" | "warn",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.options.logger?.[level](event, fields);
    } catch {
      // Diagnostics cannot change task dispatch.
    }
  }
}

type AutonomousGoal = Readonly<{
  needKey: SurvivalNeedKey;
  key: string;
  title: string;
  operatorGoal: string;
  reason: string;
  blockName: string | null;
  directionalMining: boolean;
}>;

type ResourceRecoveryResult = Readonly<{
  retry: AutonomousPlanResult | null;
  keepGoal: boolean;
}>;

function eligibleForAutonomy(record: BotRegistryRecord): boolean {
  if (record.connectionState !== "online") return false;
  const status = record.currentStatus;
  if (!status || status.connectionState !== "online") return false;
  if (
    !status.safety ||
    status.safety.mode !== "monitoring" ||
    status.safety.normalTasksPaused ||
    status.safety.activeRisks.length > 0
  ) {
    return false;
  }
  // Mineflayer can leave max_health unknown while current health is valid.
  // Do not block all autonomous work on an optional attribute.
  if (status.health.current <= 0 || status.food.level <= 0) {
    return false;
  }
  if (status.currentTask && isActiveTask(status.currentTask.status)) return false;
  return Boolean(
    record.skillCatalog?.skills.some(({ availability }) => availability === "available"),
  );
}

function isActiveTask(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.has(status);
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Autonomous director clock is invalid.");
  }
  return value;
}

function boundedError(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 300);
}

function autonomousFailureCode(
  value: AutonomousPlanResult | unknown,
): string | null {
  if (isPlanResult(value)) {
    if (value.action !== "skill_result" || value.result.payload.outcome === "completed") {
      return null;
    }
    return value.result.payload.errorCode;
  }
  if (value instanceof LocalPlannerError) {
    for (const code of RESOURCE_RECOVERY_FAILURE_CODES) {
      if (value.message.includes(code)) return code;
    }
  }
  return null;
}

function isPlanResult(value: unknown): value is AutonomousPlanResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "action" in value &&
      ((value as { action?: unknown }).action === "noop" ||
        (value as { action?: unknown }).action === "skill_result"),
  );
}

function taskStatusFromPlanResult(
  result: AutonomousPlanResult,
  signal: AbortSignal,
): TaskStatus {
  if (signal.aborted) return "cancelled";
  if (result.action === "noop") {
    return result.reasonCode === "ADVANCE_TASK" ? "completed" : "failed";
  }
  return result.result.payload.outcome === "completed"
    ? "completed"
    : result.result.payload.outcome === "cancelled"
      ? "cancelled"
      : result.result.payload.outcome === "timed_out"
        ? "expired"
        : "failed";
}

function planCompleted(result: AutonomousPlanResult | null): boolean {
  return result?.action === "skill_result" && result.result.payload.outcome === "completed";
}

function scannedResourcePositions(
  result: AutonomousPlanResult,
  blockName: string,
): readonly ScannedResourcePosition[] {
  if (
    result.action !== "skill_result" ||
    result.invocation.payload.skillId !== "world.scan" ||
    result.result.payload.outcome !== "completed"
  ) {
    return [];
  }
  const parsed = scanBlocksOutputSchema.safeParse(result.result.payload.output);
  if (!parsed.success || parsed.data.blockName !== blockName) return [];
  return [...parsed.data.matches]
    .filter((match) => Number.isFinite(match.distance))
    .sort((left, right) => left.distance - right.distance);
}

function shelterMaterial(record: BotRegistryRecord): string | null {
  const inventory = new Map(
    (record.currentStatus?.inventory ?? []).map(({ itemName, count }) => [
      itemName,
      count,
    ] as const),
  );
  return AUTONOMOUS_SHELTER_MATERIALS.find(
    (itemName) => (inventory.get(itemName) ?? 0) > 0,
  ) ?? null;
}

/** 探索焦点方块：按进度选最有价值的下一资源，而不是随机看。 */
function explorationFocusBlock(record: BotRegistryRecord): string {
  const inventory = new Map(
    (record.currentStatus?.inventory ?? []).map(({ itemName, count }) => [
      itemName,
      count,
    ] as const),
  );
  // 高档镐蕴含低档能力，按"最高档"判断而不是逐档存在性。
  if ((inventory.get("diamond_pickaxe") ?? 0) > 0) return "diamond_ore";
  if ((inventory.get("iron_pickaxe") ?? 0) > 0) return "diamond_ore";
  if ((inventory.get("stone_pickaxe") ?? 0) > 0) return "iron_ore";
  if ((inventory.get("wooden_pickaxe") ?? 0) > 0) return "stone";
  return "oak_log";
}

function distanceTo(
  position: Readonly<{ x: number; y: number; z: number }>,
  target: Readonly<{ x: number; y: number; z: number }>,
): number {
  return Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z);
}

/** 稳定的扇区基址（0–7）：同号 Bot 每次从同一扇区起步，不同号错开。 */
function stableSector(botId: string): number {
  let hash = 0;
  for (const char of botId) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  }
  return hash % 8;
}
