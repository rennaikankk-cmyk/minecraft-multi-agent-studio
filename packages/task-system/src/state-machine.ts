import { TaskSystemError } from "./errors.js";
import {
  taskLeaseAcquireCommandSchema,
  taskLeaseExpireCommandSchema,
  taskLeaseReleaseCommandSchema,
  taskLeaseRenewCommandSchema,
  taskRecordSchema,
  taskTransitionCommandSchema,
  type TaskLeaseAcquireCommand,
  type TaskLeaseExpireCommand,
  type TaskLeaseReleaseCommand,
  type TaskLeaseRenewCommand,
  type TaskRecord,
  type TaskStatus,
  type TaskTransitionCommand,
} from "./model.js";

const TERMINAL_STATUSES = new Set<TaskStatus>([
  "completed",
  "cancelled",
  "expired",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["blocked", "waiting", "paused", "cancelled", "expired"],
  assigned: [
    "running",
    "queued",
    "blocked",
    "waiting",
    "paused",
    "cancelled",
    "expired",
  ],
  running: [
    "completed",
    "failed",
    "blocked",
    "waiting",
    "paused",
    "cancelled",
    "expired",
  ],
  blocked: ["queued", "waiting", "paused", "cancelled", "expired"],
  waiting: ["queued", "blocked", "paused", "cancelled", "expired"],
  paused: ["queued", "cancelled", "expired"],
  failed: ["queued", "cancelled", "expired"],
  completed: [],
  cancelled: [],
  expired: [],
};

function validNow(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Task operation time is invalid.");
  }
  return now.toISOString();
}

function assertRevision(task: TaskRecord, expectedRevision: number): void {
  if (task.revision !== expectedRevision) {
    throw new TaskSystemError(
      "TASK_REVISION_CONFLICT",
      "Task revision does not match the expected value.",
    );
  }
}

function assertDeadline(task: TaskRecord, nowMs: number): void {
  if (task.deadline !== null && Date.parse(task.deadline) <= nowMs) {
    throw new TaskSystemError(
      "TASK_DEADLINE_EXPIRED",
      "Task deadline has already expired.",
    );
  }
}

function assertActiveLease(
  task: TaskRecord,
  leaseOwner: string | null,
  nowMs: number,
): void {
  if (task.leaseOwner === null || task.leaseExpiresAt === null) {
    throw new TaskSystemError(
      "TASK_LEASE_REQUIRED",
      "Task transition requires an active lease.",
    );
  }
  if (task.leaseOwner !== leaseOwner) {
    throw new TaskSystemError(
      "TASK_LEASE_OWNER_MISMATCH",
      "Task lease belongs to another owner.",
    );
  }
  if (Date.parse(task.leaseExpiresAt) <= nowMs) {
    throw new TaskSystemError(
      "TASK_LEASE_EXPIRED",
      "Task lease has expired.",
    );
  }
}

function validateTask(input: unknown): TaskRecord {
  return taskRecordSchema.parse(input);
}

export function transitionTask(
  taskInput: unknown,
  commandInput: unknown,
  now: Date,
): TaskRecord {
  const task = validateTask(taskInput);
  const command: TaskTransitionCommand =
    taskTransitionCommandSchema.parse(commandInput);
  const timestamp = validNow(now);
  const nowMs = Date.parse(timestamp);

  if (task.taskId !== command.taskId) {
    throw new TaskSystemError(
      "TASK_OPERATION_CONFLICT",
      "Task command targets a different task.",
    );
  }
  assertRevision(task, command.expectedRevision);
  if (TERMINAL_STATUSES.has(task.status)) {
    throw new TaskSystemError("TASK_TERMINAL", "Terminal task cannot change.");
  }
  if (!ALLOWED_TRANSITIONS[task.status].includes(command.to)) {
    throw new TaskSystemError(
      "TASK_TRANSITION_INVALID",
      "Task status transition is not allowed.",
    );
  }
  if (command.to === "assigned") {
    throw new TaskSystemError(
      "TASK_TRANSITION_INVALID",
      "Assignment must be performed through lease acquisition.",
    );
  }
  if (task.status === "assigned" && command.to === "running") {
    assertActiveLease(task, command.leaseOwner, nowMs);
  }
  if (task.status === "running") {
    assertActiveLease(task, command.leaseOwner, nowMs);
  }
  if (command.to !== "expired" && command.to !== "cancelled") {
    assertDeadline(task, nowMs);
  }
  if (command.to === "failed" && command.failureReason === null) {
    throw new TaskSystemError(
      "TASK_FAILURE_REASON_REQUIRED",
      "Failed task requires a stable failure reason.",
    );
  }
  if (task.status === "failed" && command.to === "queued") {
    if (task.retryCount >= task.maxRetries) {
      throw new TaskSystemError(
        "TASK_RETRY_EXHAUSTED",
        "Task retry budget is exhausted.",
      );
    }
  }

  const becomesTerminal = [
    "completed",
    "failed",
    "cancelled",
    "expired",
  ].includes(command.to);
  const releasesLease =
    task.status === "running" ||
    (task.status === "assigned" && command.to !== "running") ||
    becomesTerminal;
  const next = {
    ...task,
    status: command.to,
    revision: task.revision + 1,
    updatedAt: timestamp,
    startedAt:
      command.to === "running" ? (task.startedAt ?? timestamp) : task.startedAt,
    finishedAt: becomesTerminal ? timestamp : null,
    retryCount:
      task.status === "failed" && command.to === "queued"
        ? task.retryCount + 1
        : task.retryCount,
    failureReason:
      command.to === "failed"
        ? command.failureReason
        : command.to === "queued"
          ? null
          : task.failureReason,
    result: command.to === "completed" ? command.result : task.result,
    evidence:
      command.evidence.length > 0 ? command.evidence : task.evidence,
    ...(releasesLease
      ? {
          leaseOwner: null,
          leaseExpiresAt: null,
          assignedBotId: null,
        }
      : {}),
  };
  return taskRecordSchema.parse(next);
}

export function acquireTaskLease(
  taskInput: unknown,
  commandInput: unknown,
  options: Readonly<{ now: Date; dependenciesReady: boolean }>,
): TaskRecord {
  const task = validateTask(taskInput);
  const command: TaskLeaseAcquireCommand =
    taskLeaseAcquireCommandSchema.parse(commandInput);
  const timestamp = validNow(options.now);
  const nowMs = Date.parse(timestamp);

  if (task.taskId !== command.taskId) {
    throw new TaskSystemError(
      "TASK_OPERATION_CONFLICT",
      "Lease command targets a different task.",
    );
  }
  assertRevision(task, command.expectedRevision);
  assertDeadline(task, nowMs);
  if (task.riskLevel === "R3" || task.riskLevel === "R4") {
    throw new TaskSystemError(
      "TASK_RISK_APPROVAL_REQUIRED",
      "High-risk task leasing requires a future trusted approval boundary.",
    );
  }
  if (!options.dependenciesReady) {
    throw new TaskSystemError(
      "TASK_DEPENDENCIES_INCOMPLETE",
      "Task dependencies are not complete.",
    );
  }
  if (task.status !== "queued" && task.status !== "assigned") {
    throw new TaskSystemError(
      "TASK_TRANSITION_INVALID",
      "Only queued or expired-assignment tasks can be leased.",
    );
  }
  if (
    task.leaseExpiresAt !== null &&
    Date.parse(task.leaseExpiresAt) > nowMs
  ) {
    throw new TaskSystemError(
      "TASK_LEASE_CONFLICT",
      "Task already has an active lease.",
    );
  }

  return taskRecordSchema.parse({
    ...task,
    status: "assigned",
    assignedBotId: command.botId,
    leaseOwner: command.leaseOwner,
    leaseExpiresAt: new Date(
      nowMs + command.leaseDurationMs,
    ).toISOString(),
    updatedAt: timestamp,
    revision: task.revision + 1,
  });
}

export function renewTaskLease(
  taskInput: unknown,
  commandInput: unknown,
  now: Date,
): TaskRecord {
  const task = validateTask(taskInput);
  const command: TaskLeaseRenewCommand =
    taskLeaseRenewCommandSchema.parse(commandInput);
  const timestamp = validNow(now);
  const nowMs = Date.parse(timestamp);

  if (task.taskId !== command.taskId) {
    throw new TaskSystemError(
      "TASK_OPERATION_CONFLICT",
      "Lease command targets a different task.",
    );
  }
  assertRevision(task, command.expectedRevision);
  if (task.status !== "assigned" && task.status !== "running") {
    throw new TaskSystemError(
      "TASK_TRANSITION_INVALID",
      "Only assigned or running tasks can renew a lease.",
    );
  }
  assertActiveLease(task, command.leaseOwner, nowMs);
  assertDeadline(task, nowMs);

  return taskRecordSchema.parse({
    ...task,
    leaseExpiresAt: new Date(
      nowMs + command.leaseDurationMs,
    ).toISOString(),
    updatedAt: timestamp,
    revision: task.revision + 1,
  });
}

export function releaseTaskLease(
  taskInput: unknown,
  commandInput: unknown,
  now: Date,
): TaskRecord {
  const task = validateTask(taskInput);
  const command: TaskLeaseReleaseCommand =
    taskLeaseReleaseCommandSchema.parse(commandInput);
  const timestamp = validNow(now);
  const nowMs = Date.parse(timestamp);

  if (task.taskId !== command.taskId) {
    throw new TaskSystemError(
      "TASK_OPERATION_CONFLICT",
      "Lease command targets a different task.",
    );
  }
  assertRevision(task, command.expectedRevision);
  if (task.status !== "assigned") {
    throw new TaskSystemError(
      "TASK_TRANSITION_INVALID",
      "Running tasks must transition before releasing their lease.",
    );
  }
  assertActiveLease(task, command.leaseOwner, nowMs);

  return taskRecordSchema.parse({
    ...task,
    status: "queued",
    assignedBotId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: timestamp,
    revision: task.revision + 1,
  });
}

export function expireTaskLease(
  taskInput: unknown,
  commandInput: unknown,
  now: Date,
): TaskRecord {
  const task = validateTask(taskInput);
  const command: TaskLeaseExpireCommand =
    taskLeaseExpireCommandSchema.parse(commandInput);
  const timestamp = validNow(now);
  const nowMs = Date.parse(timestamp);

  if (task.taskId !== command.taskId) {
    throw new TaskSystemError(
      "TASK_OPERATION_CONFLICT",
      "Lease command targets a different task.",
    );
  }
  assertRevision(task, command.expectedRevision);
  if (
    task.leaseExpiresAt === null ||
    Date.parse(task.leaseExpiresAt) > nowMs
  ) {
    throw new TaskSystemError(
      "TASK_LEASE_CONFLICT",
      "Task lease has not expired.",
    );
  }
  if (task.status !== "assigned" && task.status !== "running") {
    throw new TaskSystemError(
      "TASK_TRANSITION_INVALID",
      "Only assigned or running tasks can expire a lease.",
    );
  }

  return taskRecordSchema.parse({
    ...task,
    status: task.status === "running" ? "failed" : "queued",
    assignedBotId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    failureReason:
      task.status === "running" ? "TASK_LEASE_EXPIRED" : task.failureReason,
    finishedAt: task.status === "running" ? timestamp : null,
    updatedAt: timestamp,
    revision: task.revision + 1,
  });
}
