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

export const AUTONOMOUS_GOAL_SEQUENCE = Object.freeze([
  Object.freeze({
    key: "oak_log",
    title: "收集基础木材",
    operatorGoal: "获取 oak_log",
  }),
  Object.freeze({
    key: "crafting_table",
    title: "制作工作台",
    operatorGoal: "获取 crafting_table",
  }),
  Object.freeze({
    key: "wooden_pickaxe",
    title: "制作木镐",
    operatorGoal: "获取 wooden_pickaxe",
  }),
  Object.freeze({
    key: "cobblestone",
    title: "采集圆石",
    operatorGoal: "获取 cobblestone",
  }),
  Object.freeze({
    key: "stone_pickaxe",
    title: "制作石镐",
    operatorGoal: "获取 stone_pickaxe",
  }),
  Object.freeze({
    key: "furnace",
    title: "制作熔炉",
    operatorGoal: "获取 furnace",
  }),
  Object.freeze({
    key: "coal",
    title: "采集燃料",
    operatorGoal: "获取 coal",
  }),
  Object.freeze({
    key: "raw_iron",
    title: "采集铁矿",
    operatorGoal: "获取 raw_iron",
  }),
  Object.freeze({
    key: "iron_ingot",
    title: "完成铁锭熔炼",
    operatorGoal: "获取 iron_ingot",
  }),
  Object.freeze({
    key: "dirt",
    title: "准备避难所材料",
    operatorGoal: "获取 dirt",
  }),
  Object.freeze({
    key: "shelter",
    title: "建立安全避难所",
    operatorGoal: "在当前维度向 north 挖一个 2 格深的安全避难所，并用 dirt 封口",
  }),
] as const);

type AutonomousGoal = Readonly<{
  key: (typeof AUTONOMOUS_GOAL_SEQUENCE)[number]["key"];
  title: string;
  operatorGoal: string;
}>;

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
  goalKey: string;
  goal: string;
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

type ResourceRecoveryResult = Readonly<{
  retry: AutonomousPlanResult | null;
  keepGoal: boolean;
}>;

type ScannedResourcePosition = Readonly<{
  x: number;
  y: number;
  z: number;
  distance: number;
}>;

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

/** The first resource needed by each autonomous milestone. */
const AUTONOMOUS_RESOURCE_BLOCKS: Readonly<Record<string, string>> = Object.freeze({
  oak_log: "oak_log",
  crafting_table: "oak_log",
  wooden_pickaxe: "oak_log",
  cobblestone: "stone",
  stone_pickaxe: "stone",
  furnace: "stone",
  coal: "coal_ore",
  raw_iron: "iron_ore",
  iron_ingot: "iron_ore",
  dirt: "dirt",
  shelter: "dirt",
});

const AUTONOMOUS_DIRECTIONAL_MINING_GOALS = new Set([
  "coal",
  "raw_iron",
  "iron_ingot",
]);

const AUTONOMOUS_EXPLORATION_OFFSETS = Object.freeze([
  Object.freeze({ x: 12, z: 0 }),
  Object.freeze({ x: 0, z: 12 }),
  Object.freeze({ x: -12, z: 0 }),
  Object.freeze({ x: 0, z: -12 }),
]);
const AUTONOMOUS_SCAN_MAX_DISTANCE = 64;
const AUTONOMOUS_SCAN_MAX_COUNT = 16;
const AUTONOMOUS_RECOVERY_TIMEOUT_MS = 30_000;
const AUTONOMOUS_MAX_RESOURCE_CANDIDATES = 4;
const AUTONOMOUS_EXPLORATION_COOLDOWN_MS = 60_000;
const AUTONOMOUS_SHELTER_DIRECTIONS = Object.freeze([
  "north",
  "east",
  "south",
  "west",
] as const);
const AUTONOMOUS_SHELTER_MATERIALS = Object.freeze([
  "dirt",
  "cobblestone",
] as const);

/**
 * Gives every idle, healthy Runtime a bounded survival task. The director
 * owns no Minecraft primitive: it only supplies an internal goal to the same
 * Coordinator planner used by the Dashboard, so all Skill and L0 gates stay
 * in one execution path.
 */
export class AutonomousDirector implements AutonomousTaskSource {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly listeners = new Set<AutonomousTaskListener>();
  private readonly tasks = new Map<string, InternalTask>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly nextGoalAt = new Map<string, number>();
  private readonly goalCursor = new Map<string, number>();
  private readonly explorationCursor = new Map<string, number>();
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

    const goalIndex = nextAutonomousGoalIndex(
      record,
      this.goalCursor.get(record.botId) ?? 0,
    );
    this.goalCursor.set(record.botId, goalIndex);
    const baseGoal = AUTONOMOUS_GOAL_SEQUENCE[
      goalIndex % AUTONOMOUS_GOAL_SEQUENCE.length
    ]!;
    const goal = baseGoal.key === "shelter"
      ? {
          ...baseGoal,
          operatorGoal: this.nextShelterGoal(
            record.botId,
            shelterMaterial(record) ?? "dirt",
          ),
        }
      : baseGoal;
    const taskId = identifierSchema.parse(this.randomId());
    const controller = new AbortController();
    const placeholder: ActiveRun = {
      taskId,
      controller,
      promise: Promise.resolve(),
    };
    this.active.set(record.botId, placeholder);
    const promise = this.runTask(record, taskId, goal, goalIndex, controller);
    this.active.set(record.botId, { taskId, controller, promise });
    void promise
      .finally(() => {
        const current = this.active.get(record.botId);
        if (current?.taskId === taskId) this.active.delete(record.botId);
      })
      .catch(() => undefined);
  }

  private async runTask(
    record: BotRegistryRecord,
    taskId: string,
    goal: AutonomousGoal,
    goalIndex: number,
    controller: AbortController,
  ): Promise<void> {
    const startedAt = validDate(this.now()).toISOString();
    const taskTitle = `自主任务: ${goal.title}`;
    this.setTask(record.botId, {
      taskId,
      title: taskTitle,
      status: "running",
      startedAt,
      goalKey: goal.key,
      goal: goal.operatorGoal,
      terminalExpiresAtMs: null,
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
      this.finishTask(
        record.botId,
        taskId,
        goal,
        goalIndex,
        status,
        status === "completed" ||
          (status !== "cancelled" && !keepGoal),
      );
      this.log("info", "coordinator_autonomous_goal_finished", {
        botId: record.botId,
        taskId,
        goalKey: goal.key,
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
      this.finishTask(
        record.botId,
        taskId,
        goal,
        goalIndex,
        status,
        status !== "cancelled" && !keepGoal,
      );
      this.log("warn", "coordinator_autonomous_goal_failed", {
        botId: record.botId,
        taskId,
        goalKey: goal.key,
        code: cause instanceof LocalPlannerError ? cause.code : "DIRECTOR_FAILED",
        error: boundedError(cause),
        ...(keepGoal ? { recovery: "retry_same_goal" } : {}),
      });
    }
  }

  /**
   * Move a resource goal forward after a local target-search failure. The
   * scan result is a Runtime observation; coordinates are never guessed from
   * the Bot's position. When no target is visible, a small relative move gives
   * the next round a new loaded area while retaining the same milestone.
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
    // noise and can duplicate collection, so retain the milestone and let the
    // next inventory-aware plan re-observe it.
    if (failureCode === "COLLECT_PICKUP_NOT_SETTLED") {
      this.setRecoveryTask(record.botId, taskId, "自主恢复: 核对采集结果");
      return { retry: null, keepGoal: true };
    }
    const blockName = AUTONOMOUS_RESOURCE_BLOCKS[goal.key];
    if (!blockName || controller.signal.aborted) {
      return { retry: null, keepGoal: true };
    }

    // collect.block opens one bounded staircase toward the observed ore on
    // every attempt. A generic horizontal exploration move abandons that
    // progress and can strand the Bot underground, so keep mining from the
    // current endpoint on the next autonomous round.
    if (
      failureCode === "COLLECT_TARGET_UNREACHABLE" &&
      AUTONOMOUS_DIRECTIONAL_MINING_GOALS.has(goal.key)
    ) {
      this.setRecoveryTask(
        record.botId,
        taskId,
        `自主恢复: 继续定向开掘 ${blockName}`,
      );
      this.log("info", "coordinator_autonomous_recovery_mining_continues", {
        botId: record.botId,
        taskId,
        goalKey: goal.key,
        blockName,
        failureCode,
      });
      return { retry: null, keepGoal: true };
    }

    this.setRecoveryTask(record.botId, taskId, `自主恢复: 搜索 ${blockName}`);
    this.log("info", "coordinator_autonomous_recovery_started", {
      botId: record.botId,
      taskId,
      goalKey: goal.key,
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
        movementGoal(match, blockName),
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
          goalKey: goal.key,
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
        goalKey: goal.key,
        blockName,
        retryAtMs: nextExplorationAt,
      });
      return { retry: null, keepGoal: true };
    }

    this.setRecoveryTask(record.botId, taskId, `自主恢复: 探索 ${blockName}`);
    this.nextExplorationAt.set(
      record.botId,
      nowMs + AUTONOMOUS_EXPLORATION_COOLDOWN_MS,
    );
    const moved = await this.dispatchInternal(
      record.botId,
      taskId,
      this.explorationGoal(record.botId, blockName),
      controller,
    ).catch((cause) => {
      this.logRecoveryFailure(record.botId, taskId, "explore", cause);
      return null;
    });
    this.setRecoveryTask(record.botId, taskId, taskTitle);
    this.log("info", "coordinator_autonomous_recovery_explored", {
      botId: record.botId,
      taskId,
      goalKey: goal.key,
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

  private explorationGoal(botId: string, blockName: string): string {
    const current = this.options.registry.get(botId, validDate(this.now()));
    const position = current?.currentStatus?.position;
    if (!position) {
      return `继续观察 ${blockName} 方块所在区域`;
    }
    const index = this.explorationCursor.get(botId) ?? 0;
    this.explorationCursor.set(
      botId,
      (index + 1) % AUTONOMOUS_EXPLORATION_OFFSETS.length,
    );
    const offset = AUTONOMOUS_EXPLORATION_OFFSETS[index % AUTONOMOUS_EXPLORATION_OFFSETS.length]!;
    const x = Math.floor(position.x) + offset.x;
    const y = Math.floor(position.y);
    const z = Math.floor(position.z) + offset.z;
    return `移动到坐标 x=${x} y=${y} z=${z} 附近，继续观察 ${blockName} 方块`;
  }

  private nextShelterGoal(botId: string, sealItemName: string): string {
    const index = this.shelterDirectionCursor.get(botId) ?? 0;
    this.shelterDirectionCursor.set(
      botId,
      (index + 1) % AUTONOMOUS_SHELTER_DIRECTIONS.length,
    );
    const direction = AUTONOMOUS_SHELTER_DIRECTIONS[
      index % AUTONOMOUS_SHELTER_DIRECTIONS.length
    ]!;
    return `在当前维度向 ${direction} 挖一个 2 格深的安全避难所，并用 ${sealItemName} 封口`;
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
    goalIndex: number,
    status: TaskStatus,
    advanceGoal = true,
  ): void {
    const nowMs = validDate(this.now()).getTime();
    if (advanceGoal) {
      this.goalCursor.set(
        botId,
        (goalIndex + 1) % AUTONOMOUS_GOAL_SEQUENCE.length,
      );
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

function nextAutonomousGoalIndex(
  record: BotRegistryRecord,
  cursor: number,
): number {
  const inventory = new Map(
    (record.currentStatus?.inventory ?? []).map(({ itemName, count }) => [
      itemName,
      count,
    ] as const),
  );
  for (let offset = 0; offset < AUTONOMOUS_GOAL_SEQUENCE.length; offset += 1) {
    const index = cursor + offset;
    const goal = AUTONOMOUS_GOAL_SEQUENCE[index % AUTONOMOUS_GOAL_SEQUENCE.length]!;
    // Cobblestone is already guaranteed by the earlier tool/furnace loop and
    // is a valid shelter seal. Do not strand an underground Bot trying to
    // reach surface dirt when it already carries a safer building block.
    if (goal.key === "dirt" && shelterMaterialFromInventory(inventory) !== null) {
      continue;
    }
    if (goal.key === "shelter" || (inventory.get(goal.key) ?? 0) < 1) {
      return index;
    }
  }
  return cursor;
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

function movementGoal(
  match: ScannedResourcePosition,
  blockName: string,
): string {
  return `移动到坐标 x=${match.x} y=${match.y} z=${match.z} 附近，继续观察 ${blockName} 方块`;
}

function shelterMaterial(record: BotRegistryRecord): string | null {
  const inventory = new Map(
    (record.currentStatus?.inventory ?? []).map(({ itemName, count }) => [
      itemName,
      count,
    ] as const),
  );
  return shelterMaterialFromInventory(inventory);
}

function shelterMaterialFromInventory(
  inventory: ReadonlyMap<string, number>,
): string | null {
  return AUTONOMOUS_SHELTER_MATERIALS.find(
    (itemName) => (inventory.get(itemName) ?? 0) > 0,
  ) ?? null;
}

function distanceTo(
  position: Readonly<{ x: number; y: number; z: number }>,
  target: Readonly<{ x: number; y: number; z: number }>,
): number {
  return Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z);
}
