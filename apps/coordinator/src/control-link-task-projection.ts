import type { BotRegistryRecord } from "./bot-registry.js";
import type { GoalLifecycleSnapshot } from "./goal-lifecycle-store.js";import {
  COMPLETED_GOAL_TTL_MS,
  goalTaskActive,
  MAX_COMPLETED_GOALS,
  MAX_TRACKED_GOALS,
  type CompletedGoal,
  type TrackedGoalTask,
} from "./control-link-goal-domain.js";

/**
 * Control Link 的持久任务投影域（从 control-link-server.ts 拆出，
 * 2026-09-10 结构拆分专项）：trackedGoals / completedGoals 状态的唯一
 * 所有者及其记账规则。编排（执行/停车/恢复）仍归 ControlLinkServer；
 * 本类只做投影状态的写入与查询，不发起任何副作用——bot 任务状态推送
 * 经构造注入的回调回到 server 的会话广播。
 */
export class ControlLinkTaskProjection {
  private readonly trackedGoals = new Map<string, TrackedGoalTask>();
  private readonly completedGoals = new Map<string, CompletedGoal>();
  private trackedGoalOrder = 0;

  constructor(
    private readonly deps: {
      /** 投影状态变化时通知 server 广播该 bot 的任务态（不做任何逻辑）。 */
      onTaskStateChanged: (botId: string, now: Date) => void;
    },
  ) {}

  applyGoalSnapshots(
    snapshots: readonly GoalLifecycleSnapshot[],
    now: Date,
    registry: {
      get(botId: string, now: Date): BotRegistryRecord | null;
    },
  ): void {
    const nowMs = now.getTime();
    for (const state of snapshots) {
      const active = goalTaskActive(state.status);
      const expiresAtMs = active
        ? null
        : Date.parse(state.updatedAt) + COMPLETED_GOAL_TTL_MS;
      if (expiresAtMs !== null && expiresAtMs <= nowMs) {
        this.trackedGoals.delete(state.operationId);
        continue;
      }
      const existing = this.trackedGoals.get(state.operationId);
      const runtimeTask = registry.get(state.botId, now)
        ?.currentStatus?.currentTask ?? null;
      if (!existing) this.trackedGoalOrder += 1;
      const tracked: TrackedGoalTask = {
        operationId: state.operationId,
        taskId: state.taskId,
        botId: state.botId,
        title: state.title,
        status: state.status,
        startedAt: state.startedAt,
        order: existing?.order ?? this.trackedGoalOrder,
        expiresAtMs,
        baselineRuntimeTask:
          existing?.baselineRuntimeTask ??
          (runtimeTask
            ? { taskId: runtimeTask.taskId, startedAt: runtimeTask.startedAt }
            : null),
      };
      this.trackedGoals.set(state.operationId, tracked);
      if (!active && (state.result !== null || state.errorCode !== null)) {
        this.rememberCompletedGoal(state.operationId, {
          fingerprint: state.fingerprint,
          ...(state.result !== null
            ? { result: state.result }
            : {
                result: null,
                errorCode: state.errorCode ?? "CONTROL_LINK_INTERNAL_ERROR",
              }),
          expiresAtMs: expiresAtMs ?? nowMs + COMPLETED_GOAL_TTL_MS,
        });
      }
      if (
        !existing ||
        existing.status !== tracked.status ||
        existing.startedAt !== tracked.startedAt ||
        existing.title !== tracked.title
      ) {
        this.deps.onTaskStateChanged(state.botId, now);
      }
    }
    this.trimTrackedGoals();
  }

  rememberCompletedGoal(
    operationId: string,
    completed: CompletedGoal,
  ): void {
    this.completedGoals.delete(operationId);
    this.completedGoals.set(operationId, completed);
    while (this.completedGoals.size > MAX_COMPLETED_GOALS) {
      const oldest = this.completedGoals.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.completedGoals.delete(oldest);
    }
  }

  pruneCompletedGoals(nowMs: number): void {
    for (const [operationId, completed] of this.completedGoals) {
      if (completed.expiresAtMs <= nowMs) {
        this.completedGoals.delete(operationId);
      }
    }
  }

  completedGoal(operationId: string): CompletedGoal | undefined {
    return this.completedGoals.get(operationId);
  }

  currentTrackedGoal(botId: string): TrackedGoalTask | null {
    let selected: TrackedGoalTask | null = null;
    for (const tracked of this.trackedGoals.values()) {
      if (tracked.botId !== botId) continue;
      if (!selected) {
        selected = tracked;
        continue;
      }
      const trackedActive = goalTaskActive(tracked.status);
      const selectedActive = goalTaskActive(selected.status);
      if (
        (trackedActive && !selectedActive) ||
        (trackedActive === selectedActive && tracked.order > selected.order)
      ) {
        selected = tracked;
      }
    }
    return selected;
  }

  pruneTrackedGoals(nowMs: number): void {
    for (const [operationId, tracked] of this.trackedGoals) {
      if (tracked.expiresAtMs !== null && tracked.expiresAtMs <= nowMs) {
        this.trackedGoals.delete(operationId);
      }
    }
  }

  /** 持久快照里已不存在（且不在 in-flight 集合中）的 tracked 条目清除；返回被移除条目供广播。 */
  removeMissing(
    persistedOperationIds: ReadonlySet<string>,
    inFlight: (operationId: string) => boolean,
  ): readonly { botId: string }[] {
    const removed: { botId: string }[] = [];
    for (const [operationId, tracked] of this.trackedGoals) {
      if (persistedOperationIds.has(operationId) || inFlight(operationId)) {
        continue;
      }
      this.trackedGoals.delete(operationId);
      removed.push({ botId: tracked.botId });
    }
    return removed;
  }

  trimTrackedGoals(): void {
    while (this.trackedGoals.size > MAX_TRACKED_GOALS) {
      const oldestTerminal = [...this.trackedGoals.entries()].find(
        ([, tracked]) => !goalTaskActive(tracked.status),
      )?.[0];
      if (!oldestTerminal) break;
      this.trackedGoals.delete(oldestTerminal);
    }
  }

  clear(): void {
    this.trackedGoals.clear();
    this.completedGoals.clear();
  }
}
