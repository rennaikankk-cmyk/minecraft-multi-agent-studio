import type {
  ControlLinkGoalErrorCode,
  ControlLinkGoalRequestV1,
  ControlLinkStopRequestV1,
  ControlLinkStateUpsertV1,
  GoalDispatchResultV1,
  PublicBotDetailV1,
} from "@minecraft-studio/protocol";
import type { WebSocket } from "ws";

import {
  durableGoalFingerprint,
  type GoalExecutionLease,
} from "./goal-lifecycle-store.js";
import type { ControlLinkClientConfig } from "./control-link-config.js";

/**
 * Control Link 的 goal/stop 域类型、常量与纯函数（从 control-link-server.ts
 * 拆出，2026-09-10 结构拆分专项）。编排仍归 ControlLinkServer；持久任务
 * 投影状态归 control-link-task-projection.ts 的 ControlLinkTaskProjection。
 */

export const STOP_TIMEOUT_MS = 15_000;
export const STOP_GRACE_PERIOD_MS = 5_000;
export const MAX_RESPONDERS_PER_STOP = 4;
export const MAX_RESPONDERS_PER_GOAL = 4;
export const MAX_COMPLETED_GOALS = 512;
export const MAX_TRACKED_GOALS = 1_000;
export const COMPLETED_GOAL_TTL_MS = 5 * 60_000;
export const GOAL_RECOVERY_INTERVAL_MS = 5_000;

export type ControlSession = {
  socket: WebSocket;
  challengeMessageId: string;
  challengeNonce: string;
  handshakeTimer: ReturnType<typeof setTimeout>;
  client: ControlLinkClientConfig | null;
  controlApiInstanceId: string | null;
  authenticated: boolean;
  closing: boolean;
  snapshotting: boolean;
  ready: boolean;
  alive: boolean;
  snapshotBaseSequence: number;
  pendingEvents: ControlLinkStateUpsertV1[];
};

export type StopResponder = {
  session: ControlSession;
  requestMessageId: string;
};

export type PendingStop = {
  fingerprint: string;
  request: ControlLinkStopRequestV1;
  responders: Map<string, StopResponder>;
};

export type GoalResponder = {
  session: ControlSession;
  requestMessageId: string;
};

export type PendingGoal = {
  fingerprint: string;
  request: ControlLinkGoalRequestV1;
  responders: Map<string, GoalResponder>;
  controller: AbortController;
  execution: Promise<void> | null;
};

export type WaitingGoalEntry = {
  pending: PendingGoal;
  lease: GoalExecutionLease;
  /** 停车死线（epoch ms）= park 时刻 + 剩余 timeout；到期诚实终态。 */
  deadlineMs: number;
  deadlineTimer: ReturnType<typeof setTimeout>;
};

export type CompletedGoal = Readonly<{
  fingerprint: string;
  expiresAtMs: number;
}> &
  (
    | Readonly<{ result: GoalDispatchResultV1; errorCode?: never }>
    | Readonly<{ result: null; errorCode: ControlLinkGoalErrorCode }>
  );

export type PublicCurrentTask = NonNullable<PublicBotDetailV1["currentTask"]>;

export type TrackedGoalTask = PublicCurrentTask & {
  operationId: string;
  botId: string;
  order: number;
  expiresAtMs: number | null;
  baselineRuntimeTask: Readonly<{
    taskId: string;
    startedAt: string | null;
  }> | null;
};

export function goalFingerprint(request: ControlLinkGoalRequestV1): string {
  return durableGoalFingerprint(request);
}

export function goalTaskStatus(
  result: GoalDispatchResultV1,
): PublicCurrentTask["status"] {
  if (result.action === "noop") return "failed";
  if (result.outcome === "completed") return "completed";
  if (result.outcome === "cancelled") return "cancelled";
  if (result.outcome === "timed_out") return "expired";
  return "failed";
}

export function goalTaskActive(status: PublicCurrentTask["status"]): boolean {
  return (
    status === "queued" ||
    status === "assigned" ||
    status === "running" ||
    status === "blocked" ||
    status === "waiting" ||
    status === "paused"
  );
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function selectCurrentTask(
  ...candidates: readonly (PublicCurrentTask | null)[]
): PublicCurrentTask | null {
  return (
    candidates.find(
      (candidate) => candidate !== null && goalTaskActive(candidate.status),
    ) ??
    candidates.find((candidate) => candidate !== null) ??
    null
  );
}

export function stopFingerprint(request: ControlLinkStopRequestV1): string {
  return JSON.stringify({
    coordinatorInstanceId: request.payload.coordinatorInstanceId,
    clientId: request.payload.clientId,
    controlApiInstanceId: request.payload.controlApiInstanceId,
    operationId: request.payload.operationId,
    botId: request.payload.botId,
    actorId: request.payload.actorId,
  });
}
