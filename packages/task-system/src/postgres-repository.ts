import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  identifierSchema,
  taskDispatchV1Schema,
  type TaskDispatchV1,
} from "@minecraft-studio/protocol";

import { TaskSystemError } from "./errors.js";
import {
  taskCancelCommandSchema,
  taskAssignmentAcquireCommandSchema,
  taskCreateCommandSchema,
  taskDispatchRetryCommandSchema,
  taskLeaseAcquireCommandSchema,
  taskLeaseExpireCommandSchema,
  taskLeaseReleaseCommandSchema,
  taskLeaseRenewCommandSchema,
  taskOutboxRecordSchema,
  taskCancellationRequestSchema,
  taskSubmitCommandSchema,
  taskRecordSchema,
  taskTransitionCommandSchema,
  type TaskCreateCommand,
  type TaskAssignmentAcquireCommand,
  type TaskDispatchRetryCommand,
  type TaskOutboxRecord,
  type TaskCancellationRequest,
  type TaskSubmitCommand,
  type TaskLeaseAcquireCommand,
  type TaskLeaseExpireCommand,
  type TaskLeaseReleaseCommand,
  type TaskLeaseRenewCommand,
  type TaskRecord,
  type TaskTransitionCommand,
} from "./model.js";
import {
  acquireTaskLease,
  expireTaskLease,
  releaseTaskLease,
  renewTaskLease,
  transitionTask,
} from "./state-machine.js";

type SqlRow = Record<string, unknown>;

const taskAssignmentLeaseCheckSchema = z
  .object({
    taskId: taskCreateCommandSchema.shape.taskId,
    botId: identifierSchema,
    leaseOwner: identifierSchema,
  })
  .strict();

export type SqlQueryResult<TRow extends SqlRow = SqlRow> = Readonly<{
  rows: readonly TRow[];
  rowCount: number | null;
}>;

export interface PostgresClientLike {
  query<TRow extends SqlRow = SqlRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>>;
  release(): void;
}

export interface PostgresPoolLike {
  connect(): Promise<PostgresClientLike>;
}

export type CreateTaskResult = Readonly<{
  task: TaskRecord;
  created: boolean;
}>;

export type SubmitTaskResult = Readonly<{
  task: TaskRecord;
  created: boolean;
  dispatch: TaskDispatchV1;
  outbox: TaskOutboxRecord;
}>;

export type PostgresTaskRepositoryOptions = Readonly<{
  dispatchSourceInstanceId?: string;
}>;

export type TaskLifecycleListOptions = Readonly<{
  taskType: string;
  terminalUpdatedAfter: string;
  limit?: number;
}>;

export type TaskHistoryListOptions = Readonly<{
  limit: number;
  status?: TaskRecord["status"] | null;
  botId?: string | null;
  before?: Readonly<{
    createdAt: string;
    taskId: string;
  }> | null;
}>;

export type TaskHistoryPage = Readonly<{
  tasks: readonly TaskRecord[];
  hasMore: boolean;
}>;

export type TaskOutboxClaimOptions = Readonly<{
  claimerId: string;
  limit?: number;
  leaseDurationMs?: number;
}>;

export type TaskOutboxAckOptions = Readonly<{
  messageId: string;
  claimerId: string;
}>;

export type TaskOutboxRetryOptions = Readonly<{
  messageId: string;
  claimerId: string;
  error: string;
  delayMs?: number;
}>;

export type RetryTaskDispatchResult = Readonly<{
  task: TaskRecord;
  dispatch: TaskDispatchV1;
  outbox: TaskOutboxRecord;
}>;

export type RecoverExpiredLeaseResult = Readonly<{
  task: TaskRecord;
  dispatch: TaskDispatchV1 | null;
  outbox: TaskOutboxRecord | null;
}>;

export type AcquireTaskAssignmentResult = Readonly<{
  task: TaskRecord;
  dispatch: TaskDispatchV1;
  outbox: TaskOutboxRecord;
}>;

/** A synchronous Coordinator execution lease has no queue delivery record. */
export type AcquireSynchronousAssignmentResult = TaskRecord;

export type TaskOutboxFailureRecord = Readonly<{
  messageId: string;
  taskId: string;
  expectedRevision: number;
  type: "task.dispatch.v1";
  payload: unknown;
  status: "failed";
  attemptCount: number;
  availableAt: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}>;

export type TaskCancellationRequestInput = Readonly<{
  operationId: string;
  taskId: string;
  actorId: string;
  reasonCode: string;
}>;

export type TaskCancellationAcknowledgeInput = Readonly<{
  taskId: string;
  acknowledgedBy: string;
  leaseOwner: string;
}>;

export type ResolveTaskCancellationInput = Readonly<{
  taskId: string;
  resolverId: string;
  leaseOwner: string | null;
}>;

export type ResolveTaskCancellationResult = Readonly<{
  request: TaskCancellationRequest;
  task: TaskRecord;
}>;

export const MAX_EXPIRED_LEASE_BATCH_SIZE = 100;
export const MAX_TASK_LIFECYCLE_BATCH_SIZE = 1_000;
export const MAX_TASK_HISTORY_BATCH_SIZE = 100;

const TRANSACTION_LOCK_TIMEOUT_SQL =
  "SET LOCAL lock_timeout = '3000ms'";
const TRANSACTION_STATEMENT_TIMEOUT_SQL =
  "SET LOCAL statement_timeout = '10000ms'";

const DEFAULT_DISPATCH_SOURCE_INSTANCE_ID = "coordinator-main";
const TASK_DISPATCH_RETRY_OPERATION_KIND = "task.dispatch-retry.v1";
export const MAX_TASK_OUTBOX_BATCH_SIZE = 100;
export const MAX_TASK_OUTBOX_ATTEMPTS = 1_000;
const DEFAULT_OUTBOX_CLAIM_MS = 30_000;
const MAX_OUTBOX_CLAIM_MS = 5 * 60_000;
const DEFAULT_OUTBOX_RETRY_MS = 1_000;
const MAX_OUTBOX_RETRY_MS = 5 * 60_000;
const OUTBOX_DELIVERY_RECHECK_MS = 30_000;

type OperationCommand = Readonly<{
  operationId: string;
  taskId: string;
  actorId: string;
}>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalCreateCommand(command: TaskCreateCommand): TaskCreateCommand {
  return {
    ...command,
    requiredSkills: [...command.requiredSkills].sort(
      (left, right) =>
        compareText(left.skillId, right.skillId) ||
        compareText(left.skillVersion, right.skillVersion),
    ),
    requiredItems: [...command.requiredItems].sort((left, right) =>
      compareText(left.itemName, right.itemName),
    ),
    dependencyIds: [...command.dependencyIds].sort(compareText),
  };
}

function canonicalSubmitCommand(command: TaskSubmitCommand): TaskSubmitCommand {
  const { dispatchBotId, ...createCommand } = command;
  return {
    ...canonicalCreateCommand(taskCreateCommandSchema.parse(createCommand)),
    dispatchBotId,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function taskOperationFingerprint(value: unknown): string {
  const parsedSubmitCommand = taskSubmitCommandSchema.safeParse(value);
  const parsedCreateCommand = taskCreateCommandSchema.safeParse(value);
  const fingerprintValue = parsedSubmitCommand.success
    ? canonicalSubmitCommand(parsedSubmitCommand.data)
    : parsedCreateCommand.success
      ? canonicalCreateCommand(parsedCreateCommand.data)
      : value;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(fingerprintValue)), "utf8")
    .digest("hex");
}

function createRequestFingerprint(command: TaskCreateCommand): string {
  const {
    operationId: _operationId,
    actorId: _actorId,
    ...semanticRequest
  } = command;
  return taskOperationFingerprint(semanticRequest);
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  throw new TaskSystemError(
    "TASK_PERSISTENCE_FAILED",
    "PostgreSQL returned an invalid task timestamp.",
  );
}

function integer(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new TaskSystemError(
      "TASK_PERSISTENCE_FAILED",
      "PostgreSQL returned an invalid task integer.",
    );
  }
  return parsed;
}

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new TaskSystemError(
      "TASK_PERSISTENCE_FAILED",
      "PostgreSQL returned an invalid task string.",
    );
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function mapTaskRow(
  row: SqlRow,
  dependencyIds: readonly string[],
): TaskRecord {
  return taskRecordSchema.parse({
    schemaVersion: row.schema_version,
    taskId: row.task_id,
    idempotencyScope: row.idempotency_scope,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    taskType: row.task_type,
    handlerVersion: row.handler_version,
    executionIdempotent: row.execution_idempotent,
    title: row.title,
    description: row.description,
    ...(row.task_input === null || row.task_input === undefined
      ? {}
      : { input: row.task_input }),
    priority: integer(row.priority),
    status: row.status,
    dispatchBotId: nullableText(row.dispatch_bot_id),
    assignedBotId: nullableText(row.assigned_bot_id),
    requiredSkills: row.required_skills,
    requiredItems: row.required_items,
    target: row.target ?? null,
    dependencyIds: [...dependencyIds],
    parentTaskId: nullableText(row.parent_task_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    deadline: iso(row.deadline),
    timeoutMs: integer(row.timeout_ms),
    retryCount: integer(row.retry_count),
    maxRetries: integer(row.max_retries),
    leaseOwner: nullableText(row.lease_owner),
    leaseExpiresAt: iso(row.lease_expires_at),
    riskLevel: row.risk_level,
    failureReason: nullableText(row.failure_reason),
    result: row.result ?? null,
    evidence: row.evidence,
    traceId: row.trace_id,
    revision: integer(row.revision),
  });
}

function createdTask(
  command: TaskCreateCommand,
  requestFingerprint: string,
  timestamp: string,
  dispatchBotId: string | null = null,
): TaskRecord {
  return taskRecordSchema.parse({
    schemaVersion: "1.0",
    taskId: command.taskId,
    idempotencyScope: command.idempotencyScope,
    idempotencyKey: command.idempotencyKey,
    requestFingerprint,
    taskType: command.taskType,
    handlerVersion: command.handlerVersion,
    executionIdempotent: command.executionIdempotent,
    title: command.title,
    description: command.description,
    ...(command.input === undefined ? {} : { input: command.input }),
    priority: command.priority,
    status: "queued",
    dispatchBotId,
    assignedBotId: null,
    requiredSkills: command.requiredSkills,
    requiredItems: command.requiredItems,
    target: command.target,
    dependencyIds: command.dependencyIds,
    parentTaskId: command.parentTaskId,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
    deadline: command.deadline,
    timeoutMs: command.timeoutMs,
    retryCount: 0,
    maxRetries: command.maxRetries,
    leaseOwner: null,
    leaseExpiresAt: null,
    riskLevel: command.riskLevel,
    failureReason: null,
    result: null,
    evidence: [],
    traceId: command.traceId,
    revision: 0,
  });
}

function mapOutboxRow(row: SqlRow): TaskOutboxRecord {
  return taskOutboxRecordSchema.parse({
    messageId: row.message_id,
    taskId: row.task_id,
    expectedRevision: integer(row.expected_revision),
    type: row.type,
    payload: row.payload,
    status: row.status,
    attemptCount: integer(row.attempt_count),
    availableAt: iso(row.available_at),
    claimedBy: nullableText(row.claimed_by),
    claimExpiresAt: iso(row.claim_expires_at),
    lastError: nullableText(row.last_error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deliveredAt: iso(row.delivered_at),
  });
}

function mapOutboxFailureRow(row: SqlRow): TaskOutboxFailureRecord {
  if (row.status !== "failed") {
    throw new TaskSystemError(
      "TASK_PERSISTENCE_FAILED",
      "PostgreSQL returned a non-failed outbox inspection record.",
    );
  }
  const availableAt = iso(row.available_at);
  const createdAt = iso(row.created_at);
  const updatedAt = iso(row.updated_at);
  if (availableAt === null || createdAt === null || updatedAt === null) {
    throw new TaskSystemError(
      "TASK_PERSISTENCE_FAILED",
      "PostgreSQL returned an incomplete outbox failure timestamp.",
    );
  }
  return {
    messageId: taskOutboxRecordSchema.shape.messageId.parse(row.message_id),
    taskId: taskOutboxRecordSchema.shape.taskId.parse(row.task_id),
    expectedRevision: integer(row.expected_revision),
    type: taskOutboxRecordSchema.shape.type.parse(row.type),
    payload: row.payload,
    status: "failed",
    attemptCount: integer(row.attempt_count),
    availableAt,
    lastError: text(row.last_error),
    createdAt,
    updatedAt,
    deliveredAt: iso(row.delivered_at),
  };
}

function outboxMatchesTaskContract(
  row: SqlRow,
  outbox: TaskOutboxRecord,
): boolean {
  const taskLeaseOwner = nullableText(row.task_lease_owner);
  const taskAssignedBotId = nullableText(row.task_assigned_bot_id);
  const dispatchLeaseOwner =
    outbox.payload.payload.assignmentLeaseOwner ?? null;
  return (
    nullableText(row.task_dispatch_bot_id) === outbox.payload.botId &&
    nullableText(row.task_type) === outbox.payload.payload.taskType &&
    nullableText(row.task_handler_version) ===
      outbox.payload.payload.handlerVersion &&
    row.task_execution_idempotent ===
      outbox.payload.payload.executionIdempotent &&
    nullableText(row.task_trace_id) === outbox.payload.traceId &&
    dispatchLeaseOwner ===
      (row.task_status === "assigned" ? taskLeaseOwner : null) &&
    (row.task_status !== "assigned" ||
      taskAssignedBotId === outbox.payload.botId)
  );
}

function mapCancellationRequestRow(row: SqlRow): TaskCancellationRequest {
  return taskCancellationRequestSchema.parse({
    requestId: row.request_id,
    operationId: row.operation_id,
    taskId: row.task_id,
    operationFingerprint: row.operation_fingerprint,
    actorId: row.actor_id,
    reasonCode: row.reason_code,
    requestedAt: iso(row.requested_at),
    acknowledgedAt: iso(row.acknowledged_at),
    acknowledgedBy: nullableText(row.acknowledged_by),
  });
}

function dispatchPayload(
  task: TaskRecord,
  sourceInstanceId: string,
  timestamp: string,
): TaskDispatchV1 {
  if (task.dispatchBotId === null) {
    throw new TaskSystemError(
      "TASK_PERSISTENCE_FAILED",
      "A submitted task must have a durable dispatch Bot target.",
    );
  }
  return taskDispatchV1Schema.parse({
    schemaVersion: "1.0",
    messageId: randomUUID(),
    traceId: task.traceId,
    timestamp,
    source: {
      service: "coordinator",
      instanceId: sourceInstanceId,
    },
    taskId: task.taskId,
    botId: task.dispatchBotId,
    type: "task.dispatch.v1",
    payload: {
      expectedRevision: task.revision,
      taskType: task.taskType,
      handlerVersion: task.handlerVersion,
      executionIdempotent: task.executionIdempotent,
      ...(task.status === "assigned" && task.leaseOwner !== null
        ? { assignmentLeaseOwner: task.leaseOwner }
        : {}),
    },
  });
}

export class PostgresTaskRepository {
  private readonly dispatchSourceInstanceId: string;

  constructor(
    private readonly pool: PostgresPoolLike,
    options: PostgresTaskRepositoryOptions = {},
  ) {
    this.dispatchSourceInstanceId = identifierSchema.parse(
      options.dispatchSourceInstanceId ?? DEFAULT_DISPATCH_SOURCE_INSTANCE_ID,
    );
  }

  async createTask(input: unknown): Promise<CreateTaskResult> {
    const command = canonicalCreateCommand(
      taskCreateCommandSchema.parse(input),
    );
    return await this.persistTaskCreate(
      command,
      null,
      createRequestFingerprint(command),
      taskOperationFingerprint(command),
    );
  }

  async submitTask(input: unknown): Promise<SubmitTaskResult> {
    const submitted = canonicalSubmitCommand(taskSubmitCommandSchema.parse(input));
    const { dispatchBotId, ...createInput } = submitted;
    const command = canonicalCreateCommand(
      taskCreateCommandSchema.parse(createInput),
    );
    const { operationId: _operationId, actorId: _actorId, ...semantic } =
      submitted;
    const requestFingerprint = taskOperationFingerprint(semantic);
    const operationFingerprint = taskOperationFingerprint(submitted);
    const result = await this.persistTaskCreate(
      command,
      dispatchBotId,
      requestFingerprint,
      operationFingerprint,
    );
    if (!("outbox" in result)) {
      throw new TaskSystemError(
        "TASK_PERSISTENCE_FAILED",
        "Submitted task did not produce a durable dispatch outbox row.",
      );
    }
    const outbox = result.outbox;
    return {
      task: result.task,
      created: result.created,
      dispatch: outbox.payload,
      outbox,
    };
  }

  private async persistTaskCreate(
    command: TaskCreateCommand,
    dispatchBotId: string | null,
    requestFingerprint: string,
    operationFingerprint: string,
  ): Promise<
    | CreateTaskResult
    | (CreateTaskResult & { outbox: TaskOutboxRecord })
  > {
    const client = await this.pool.connect();

    try {
      await this.beginTransaction(client);
      await this.lockOperation(client, command.operationId);
      const replay = await this.findOperationReplay(
        client,
        command,
        operationFingerprint,
      );
      if (replay) {
        const replayOutbox =
          dispatchBotId === null
            ? undefined
            : await this.ensureDispatchOutbox(
                client,
                replay,
                replay.updatedAt,
              );
        await client.query("COMMIT");
        if (replayOutbox) {
          return { task: replay, created: false, outbox: replayOutbox };
        }
        return { task: replay, created: false };
      }
      const now = await this.databaseNow(client);
      const timestamp = now.toISOString();
      if (
        command.deadline !== null &&
        Date.parse(command.deadline) <= now.getTime()
      ) {
        throw new TaskSystemError(
          "TASK_DEADLINE_EXPIRED",
          "Task deadline has already expired.",
        );
      }
      const proposed = createdTask(
        command,
        requestFingerprint,
        timestamp,
        dispatchBotId,
      );

      const inserted = await client.query(
        `INSERT INTO studio_tasks (
          task_id, schema_version, idempotency_scope, idempotency_key,
          request_fingerprint, task_type, handler_version,
          execution_idempotent, title, description, task_input, priority, status,
          dispatch_bot_id, assigned_bot_id, required_skills, required_items, target,
          parent_task_id, deadline, timeout_ms, retry_count, max_retries,
          lease_owner, lease_expires_at, risk_level, failure_reason, result,
          evidence, trace_id, revision, created_at, updated_at, started_at,
          finished_at
        ) VALUES (
          $1, '1.0', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued',
          $12, NULL, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18, 0, $19,
          NULL, NULL, $20, NULL, NULL, '[]'::jsonb, $21, 0, $22, $22, NULL,
          NULL
        )
        ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING
        RETURNING task_id`,
        [
          command.taskId,
          command.idempotencyScope,
          command.idempotencyKey,
          requestFingerprint,
          command.taskType,
          command.handlerVersion,
          command.executionIdempotent,
          command.title,
          command.description,
          command.input === undefined ? null : JSON.stringify(command.input),
          command.priority,
          dispatchBotId,
          JSON.stringify(command.requiredSkills),
          JSON.stringify(command.requiredItems),
          command.target === null ? null : JSON.stringify(command.target),
          command.parentTaskId,
          command.deadline,
          command.timeoutMs,
          command.maxRetries,
          command.riskLevel,
          command.traceId,
          timestamp,
        ],
      );

      let task: TaskRecord;
      let wasCreated = inserted.rowCount === 1;
      if (wasCreated) {
        for (const dependencyId of command.dependencyIds) {
          await client.query(
            `INSERT INTO studio_task_dependencies (
              task_id, dependency_task_id, created_at
            ) VALUES ($1, $2, $3)`,
            [command.taskId, dependencyId, timestamp],
          );
        }
        task = proposed;
      } else {
        const existing = await client.query<{
          task_id: unknown;
          request_fingerprint: unknown;
        }>(
          `SELECT task_id, request_fingerprint
           FROM studio_tasks
           WHERE idempotency_scope = $1 AND idempotency_key = $2
           FOR SHARE`,
          [command.idempotencyScope, command.idempotencyKey],
        );
        const row = existing.rows[0];
        if (!row) {
          throw new TaskSystemError(
            "TASK_PERSISTENCE_FAILED",
            "Idempotent task row disappeared during creation.",
          );
        }
        if (text(row.request_fingerprint) !== requestFingerprint) {
          throw new TaskSystemError(
            "TASK_IDEMPOTENCY_CONFLICT",
            "Idempotency key was reused with different task parameters.",
          );
        }
        const existingTask = await this.loadTask(
          client,
          text(row.task_id),
          false,
        );
        if (!existingTask) {
          throw new TaskSystemError(
            "TASK_PERSISTENCE_FAILED",
            "Idempotent task row could not be loaded.",
          );
        }
        task = existingTask;
        wasCreated = false;
      }

      await this.appendHistory(client, {
        command,
        operationFingerprint,
        eventType: wasCreated ? "task.created" : "task.create-replayed",
        fromStatus: null,
        toStatus: task.status,
        reasonCode: wasCreated ? "TASK_CREATED" : "TASK_CREATE_REPLAYED",
        task,
        timestamp,
      });
      let outbox: TaskOutboxRecord | undefined;
      if (dispatchBotId !== null) {
        outbox = await this.ensureDispatchOutbox(client, task, timestamp);
      }
      await client.query("COMMIT");
      if (outbox) return { task, created: wasCreated, outbox };
      return { task, created: wasCreated };
    } catch (error) {
      await this.rollback(client);
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  private async ensureDispatchOutbox(
    client: PostgresClientLike,
    task: TaskRecord,
    timestamp: string,
  ): Promise<TaskOutboxRecord> {
    const existing = await client.query(
      `SELECT *
       FROM studio_task_outbox
       WHERE task_id = $1
         AND expected_revision = $2
         AND type = 'task.dispatch.v1'
       FOR UPDATE`,
      [task.taskId, task.revision],
    );
    const existingRow = existing.rows[0];
    if (existingRow) {
      const outbox = mapOutboxRow(existingRow);
      this.assertOutboxMatchesTask(task, outbox);
      return outbox;
    }

    const payload = dispatchPayload(
      task,
      this.dispatchSourceInstanceId,
      timestamp,
    );
    const inserted = await client.query(
      `INSERT INTO studio_task_outbox (
        message_id, task_id, expected_revision, type, payload,
        status, attempt_count, available_at, claimed_by,
        claim_expires_at, last_error, created_at, updated_at, delivered_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, 'pending', 0, $6,
        NULL, NULL, NULL, $6, $6, NULL
      )
      ON CONFLICT (task_id, expected_revision, type) DO NOTHING`,
      [
        payload.messageId,
        payload.taskId,
        payload.payload.expectedRevision,
        payload.type,
        JSON.stringify(payload),
        timestamp,
      ],
    );
    if (inserted.rowCount !== 1) {
      const concurrent = await client.query(
        `SELECT *
         FROM studio_task_outbox
         WHERE task_id = $1
           AND expected_revision = $2
           AND type = 'task.dispatch.v1'
         FOR UPDATE`,
        [task.taskId, task.revision],
      );
      const concurrentRow = concurrent.rows[0];
      if (concurrentRow) {
        const outbox = mapOutboxRow(concurrentRow);
        this.assertOutboxMatchesTask(task, outbox);
        return outbox;
      }
      throw new TaskSystemError(
        "TASK_PERSISTENCE_FAILED",
        "Task dispatch outbox row disappeared after insertion.",
      );
    }
    return taskOutboxRecordSchema.parse({
      messageId: payload.messageId,
      taskId: payload.taskId,
      expectedRevision: payload.payload.expectedRevision,
      type: payload.type,
      payload,
      status: "pending",
      attemptCount: 0,
      availableAt: timestamp,
      claimedBy: null,
      claimExpiresAt: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deliveredAt: null,
    });
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const parsedId = taskCreateCommandSchema.shape.taskId.parse(taskId);
    const client = await this.pool.connect();
    try {
      return await this.loadTask(client, parsedId, false);
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  /**
   * Checks a pre-acquired execution lease at the PostgreSQL authority. The
   * planner uses this instead of treating a caller-supplied owner string as a
   * capability. The check is deliberately one-shot; subsequent mutations
   * still enforce the lease owner and revision transactionally.
   */
  async isTaskAssignmentLeaseActive(input: unknown): Promise<boolean> {
    const parsed = taskAssignmentLeaseCheckSchema.parse(input);
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT 1
         FROM studio_tasks
         WHERE task_id = $1
           AND dispatch_bot_id = $2
           AND assigned_bot_id = $2
           AND lease_owner = $3
           AND status IN ('assigned', 'running')
           AND lease_expires_at > clock_timestamp()
         LIMIT 1`,
        [parsed.taskId, parsed.botId, parsed.leaseOwner],
      );
      return result.rows.length === 1;
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  async getDatabaseTime(): Promise<Date> {
    const client = await this.pool.connect();
    try {
      return await this.databaseNow(client);
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  async verifyGoalLifecycleSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ready: unknown }>(
        `SELECT (
           to_regclass('studio_tasks') IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'studio_tasks'
               AND column_name = 'task_input'
               AND data_type = 'jsonb'
           )
           AND EXISTS (
             SELECT 1
             FROM pg_constraint
             WHERE conrelid = to_regclass('studio_tasks')
               AND conname = 'studio_tasks_input_size_check'
           )
           AND to_regclass('studio_tasks_type_status_updated_idx') IS NOT NULL
         ) AS ready`,
      );
      if (result.rows[0]?.ready !== true) {
        throw new TaskSystemError(
          "TASK_PERSISTENCE_FAILED",
          "PostgreSQL task schema does not support durable goal lifecycle input.",
        );
      }
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  async listTaskLifecycle(
    input: TaskLifecycleListOptions,
  ): Promise<readonly TaskRecord[]> {
    const taskType = taskCreateCommandSchema.shape.taskType.parse(input.taskType);
    const terminalUpdatedAfter = new Date(input.terminalUpdatedAfter);
    if (!Number.isFinite(terminalUpdatedAfter.getTime())) {
      throw new TypeError("Task lifecycle lower-bound timestamp is invalid.");
    }
    const limit = input.limit ?? MAX_TASK_LIFECYCLE_BATCH_SIZE;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_TASK_LIFECYCLE_BATCH_SIZE
    ) {
      throw new RangeError(
        `Task lifecycle batch limit must be between 1 and ${MAX_TASK_LIFECYCLE_BATCH_SIZE}.`,
      );
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT *
         FROM studio_tasks
         WHERE task_type = $1
           AND (
             status IN ('queued', 'assigned', 'running', 'blocked', 'waiting', 'paused')
             OR (status = 'failed' AND retry_count < max_retries)
             OR updated_at >= $2::timestamptz
           )
         ORDER BY
           CASE
             WHEN status IN ('queued', 'assigned', 'running', 'blocked', 'waiting', 'paused')
               OR (status = 'failed' AND retry_count < max_retries)
             THEN 0 ELSE 1
           END ASC,
           updated_at DESC,
           task_id ASC
         LIMIT $3`,
        [taskType, terminalUpdatedAfter.toISOString(), limit],
      );
      const tasks: TaskRecord[] = [];
      for (const row of result.rows) {
        const taskId = text(row.task_id);
        tasks.push(
          mapTaskRow(row, await this.loadDependencyIds(client, taskId)),
        );
      }
      return tasks;
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  async listTaskHistory(
    input: TaskHistoryListOptions,
  ): Promise<TaskHistoryPage> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_TASK_HISTORY_BATCH_SIZE
    ) {
      throw new RangeError(
        `Task history page size must be between 1 and ${MAX_TASK_HISTORY_BATCH_SIZE}.`,
      );
    }
    const status = input.status === null || input.status === undefined
      ? null
      : taskRecordSchema.shape.status.parse(input.status);
    const botId = input.botId === null || input.botId === undefined
      ? null
      : identifierSchema.parse(input.botId);
    const before = input.before ?? null;
    const beforeCreatedAt = before === null ? null : iso(before.createdAt);
    const beforeTaskId = before === null
      ? null
      : taskCreateCommandSchema.shape.taskId.parse(before.taskId);
    if (before !== null && beforeCreatedAt === null) {
      throw new TypeError("Task history cursor timestamp is invalid.");
    }

    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT task.*
         FROM studio_tasks AS task
         WHERE ($1::text IS NULL OR task.status = $1::text)
           AND (
             $2::text IS NULL
             OR task.dispatch_bot_id = $2::text
             OR task.assigned_bot_id = $2::text
             OR task.task_input ->> 'botId' = $2::text
           )
           AND (
             $3::timestamptz IS NULL
             OR (task.created_at, task.task_id) <
                ($3::timestamptz, $4::uuid)
           )
         ORDER BY task.created_at DESC, task.task_id DESC
         LIMIT $5`,
        [
          status,
          botId,
          beforeCreatedAt,
          beforeTaskId,
          input.limit + 1,
        ],
      );
      const rows = result.rows.slice(0, input.limit);
      const tasks: TaskRecord[] = [];
      for (const row of rows) {
        const taskId = text(row.task_id);
        tasks.push(
          mapTaskRow(row, await this.loadDependencyIds(client, taskId)),
        );
      }
      return { tasks, hasMore: result.rows.length > input.limit };
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  async listExpiredLeases(limit: number): Promise<readonly TaskRecord[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_EXPIRED_LEASE_BATCH_SIZE
    ) {
      throw new RangeError(
        `Expired lease batch limit must be between 1 and ${MAX_EXPIRED_LEASE_BATCH_SIZE}.`,
      );
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT *
         FROM studio_tasks
         WHERE status IN ('assigned', 'running')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= clock_timestamp()
         ORDER BY lease_expires_at ASC, task_id ASC
         LIMIT $1`,
        [limit],
      );
      const tasks: TaskRecord[] = [];
      for (const row of result.rows) {
        const taskId = text(row.task_id);
        tasks.push(
          mapTaskRow(row, await this.loadDependencyIds(client, taskId)),
        );
      }
      return tasks;
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  /**
   * Claims a bounded batch using PostgreSQL row locks. A delivered entry is
   * intentionally eligible again while its task is still queued at the same
   * revision: this lets reconciliation rebuild BullMQ jobs after Redis data
   * loss without generating a new protocol message. attempt_count is the
   * consecutive failure count since the last successful acknowledgement;
   * claims and successful reconciliation audits do not consume that budget.
   */
  async claimTaskOutbox(
    input: TaskOutboxClaimOptions,
  ): Promise<readonly TaskOutboxRecord[]> {
    const claimerId = identifierSchema.parse(input.claimerId);
    const limit = input.limit ?? MAX_TASK_OUTBOX_BATCH_SIZE;
    const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_OUTBOX_CLAIM_MS;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_TASK_OUTBOX_BATCH_SIZE
    ) {
      throw new RangeError(
        `Task outbox batch limit must be between 1 and ${MAX_TASK_OUTBOX_BATCH_SIZE}.`,
      );
    }
    if (
      !Number.isInteger(leaseDurationMs) ||
      leaseDurationMs < 1_000 ||
      leaseDurationMs > MAX_OUTBOX_CLAIM_MS
    ) {
      throw new RangeError(
        `Task outbox claim lease must be between 1000 and ${MAX_OUTBOX_CLAIM_MS} milliseconds.`,
      );
    }
    const client = await this.pool.connect();
    try {
      await this.beginTransaction(client);
      const result = await client.query(
        `WITH candidates AS (
          SELECT outbox.message_id
          FROM studio_task_outbox AS outbox
          JOIN studio_tasks AS task ON task.task_id = outbox.task_id
          WHERE (
            outbox.status IN ('pending', 'delivered')
            OR (
              outbox.status = 'claimed'
              AND outbox.claim_expires_at <= clock_timestamp()
            )
          )
            AND outbox.available_at <= clock_timestamp()
            AND task.revision = outbox.expected_revision
            AND (
              task.status = 'queued'
              OR (
                task.status = 'assigned'
                AND task.lease_expires_at > clock_timestamp()
                AND task.assigned_bot_id = (outbox.payload ->> 'botId')
                AND (outbox.payload -> 'payload' ->> 'assignmentLeaseOwner') =
                    task.lease_owner
              )
            )
          ORDER BY outbox.available_at ASC, outbox.created_at ASC,
                   outbox.message_id ASC
          LIMIT $1
          FOR UPDATE OF outbox, task SKIP LOCKED
        ), claimed AS (
          UPDATE studio_task_outbox AS outbox
          SET status = 'claimed',
              claimed_by = $2,
              claim_expires_at = clock_timestamp() +
                ($3 * interval '1 millisecond'),
              updated_at = clock_timestamp()
          FROM candidates
          WHERE outbox.message_id = candidates.message_id
          RETURNING outbox.*
        )
        SELECT claimed.*,
               task.dispatch_bot_id AS task_dispatch_bot_id,
               task.status AS task_status,
               task.lease_owner AS task_lease_owner,
               task.assigned_bot_id AS task_assigned_bot_id,
               task.task_type,
               task.handler_version AS task_handler_version,
               task.execution_idempotent AS task_execution_idempotent,
               task.trace_id AS task_trace_id
        FROM claimed
        JOIN studio_tasks AS task ON task.task_id = claimed.task_id`,
        [limit, claimerId, leaseDurationMs],
      );
      const entries: TaskOutboxRecord[] = [];
      for (const row of result.rows) {
        let failureReason: string | null = null;
        try {
          const entry = mapOutboxRow(row);
          if (outboxMatchesTaskContract(row, entry)) {
            entries.push(entry);
          } else {
            failureReason = "TASK_OUTBOX_TASK_CONTRACT_MISMATCH";
          }
        } catch {
          failureReason = "TASK_OUTBOX_RECORD_INVALID";
        }
        if (failureReason !== null) {
          const quarantined = await client.query(
            `UPDATE studio_task_outbox
             SET status = 'failed',
                 claimed_by = NULL,
                 claim_expires_at = NULL,
                 last_error = $3,
                 updated_at = clock_timestamp()
             WHERE message_id = $1
               AND status = 'claimed'
               AND claimed_by = $2`,
            [text(row.message_id), claimerId, failureReason],
          );
          if (quarantined.rowCount !== 1) {
            throw new TaskSystemError(
              "TASK_PERSISTENCE_FAILED",
              "Invalid task outbox record could not be quarantined.",
            );
          }
          await this.blockTaskAfterOutboxFailure(client, {
            messageId: text(row.message_id),
            taskId: text(row.task_id),
            expectedRevision: integer(row.expected_revision),
            actorId: claimerId,
            reasonCode: failureReason,
          });
        }
      }
      await client.query("COMMIT");
      return entries;
    } catch (error) {
      await this.rollback(client);
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  claimOutbox(input: TaskOutboxClaimOptions): Promise<readonly TaskOutboxRecord[]> {
    return this.claimTaskOutbox(input);
  }

  async getTaskOutbox(
    taskId: string,
    expectedRevision: number,
  ): Promise<TaskOutboxRecord | null> {
    const parsedTaskId = taskCreateCommandSchema.shape.taskId.parse(taskId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new RangeError("Task outbox revision must be a nonnegative integer.");
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT *
         FROM studio_task_outbox
         WHERE task_id = $1
           AND expected_revision = $2
           AND type = 'task.dispatch.v1'`,
        [parsedTaskId, expectedRevision],
      );
      const row = result.rows[0];
      if (!row) return null;
      try {
        return mapOutboxRow(row);
      } catch (error) {
        if (row.status === "failed") return null;
        throw error;
      }
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  async getTaskOutboxFailure(
    taskId: string,
    expectedRevision: number,
  ): Promise<TaskOutboxFailureRecord | null> {
    const parsedTaskId = taskCreateCommandSchema.shape.taskId.parse(taskId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new RangeError("Task outbox revision must be a nonnegative integer.");
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT *
         FROM studio_task_outbox
         WHERE task_id = $1
           AND expected_revision = $2
           AND type = 'task.dispatch.v1'
           AND status = 'failed'`,
        [parsedTaskId, expectedRevision],
      );
      const row = result.rows[0];
      return row ? mapOutboxFailureRow(row) : null;
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  async markTaskOutboxDelivered(
    input: TaskOutboxAckOptions,
  ): Promise<boolean> {
    const messageId = taskOutboxRecordSchema.shape.messageId.parse(
      input.messageId,
    );
    const claimerId = identifierSchema.parse(input.claimerId);
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `UPDATE studio_task_outbox
         SET status = 'delivered',
             attempt_count = 0,
             claimed_by = NULL,
             claim_expires_at = NULL,
             last_error = NULL,
             available_at = clock_timestamp() +
               ($3 * interval '1 millisecond'),
             delivered_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE message_id = $1
           AND status = 'claimed'
           AND claimed_by = $2`,
        [messageId, claimerId, OUTBOX_DELIVERY_RECHECK_MS],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  markOutboxDelivered(input: TaskOutboxAckOptions): Promise<boolean> {
    return this.markTaskOutboxDelivered(input);
  }

  async retryTaskOutbox(input: TaskOutboxRetryOptions): Promise<boolean> {
    const messageId = taskOutboxRecordSchema.shape.messageId.parse(
      input.messageId,
    );
    const claimerId = identifierSchema.parse(input.claimerId);
    const errorMessage = input.error.trim();
    if (errorMessage.length < 1 || errorMessage.length > 4_000) {
      throw new RangeError("Task outbox retry error must be 1-4000 characters.");
    }
    const delayMs = input.delayMs ?? DEFAULT_OUTBOX_RETRY_MS;
    if (
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > MAX_OUTBOX_RETRY_MS
    ) {
      throw new RangeError(
        `Task outbox retry delay must be between 0 and ${MAX_OUTBOX_RETRY_MS} milliseconds.`,
      );
    }
    const client = await this.pool.connect();
    try {
      await this.beginTransaction(client);
      const result = await client.query(
        `UPDATE studio_task_outbox
         SET status = CASE
               WHEN delivered_at IS NULL AND attempt_count + 1 >= $5
                 THEN 'failed'
               ELSE 'pending'
             END,
             attempt_count = LEAST(attempt_count + 1, $5),
             claimed_by = NULL,
             claim_expires_at = NULL,
             last_error = $3,
             available_at = CASE
               WHEN delivered_at IS NULL AND attempt_count + 1 >= $5
                 THEN clock_timestamp()
               ELSE clock_timestamp() + ($4 * interval '1 millisecond')
             END,
             updated_at = clock_timestamp()
         WHERE message_id = $1
           AND status = 'claimed'
           AND claimed_by = $2
         RETURNING task_id, expected_revision, status`,
        [
          messageId,
          claimerId,
          errorMessage,
          delayMs,
          MAX_TASK_OUTBOX_ATTEMPTS,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return false;
      }
      if (row.status === "failed") {
        await this.blockTaskAfterOutboxFailure(client, {
          messageId,
          taskId: text(row.task_id),
          expectedRevision: integer(row.expected_revision),
          actorId: claimerId,
          reasonCode: "TASK_OUTBOX_DELIVERY_EXHAUSTED",
        });
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await this.rollback(client);
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  retryOutbox(input: TaskOutboxRetryOptions): Promise<boolean> {
    return this.retryTaskOutbox(input);
  }

  /**
   * Atomically binds a deterministic Coordinator Bot choice to the durable
   * task lease and its next-revision dispatch outbox entry. The worker can
   * therefore consume the assignment lease after a Coordinator restart
   * without performing a second competing lease claim.
   */
  acquireTaskAssignment(input: unknown): Promise<AcquireTaskAssignmentResult> {
    const command: TaskAssignmentAcquireCommand =
      taskAssignmentAcquireCommandSchema.parse(input);
    return this.mutate(
      command,
      "task.assignment-acquired",
      "TASK_ASSIGNMENT_ACQUIRED",
      async (task, now, client) => {
        await this.assertBotAssignmentAvailable(client, command.botId, task.taskId);
        this.assertAssignmentServerContext(task, command);
        if (await this.hasTaskCancellationRequest(client, task.taskId)) {
          throw new TaskSystemError(
            "TASK_CANCELLATION_PENDING",
            "Task cancellation must resolve before assignment.",
          );
        }
        if (
          task.dispatchBotId !== null &&
          task.dispatchBotId !== command.botId &&
          task.revision === 0
        ) {
          throw new TaskSystemError(
            "TASK_OPERATION_CONFLICT",
            "Initial task dispatch target belongs to another Bot.",
          );
        }
        if (
          task.dispatchBotId !== null &&
          task.dispatchBotId !== command.botId
        ) {
          await this.supersedeDispatchOutbox(client, task);
        }
        const {
          serverProfileId: _serverProfileId,
          dimension: _dimension,
          ...leaseCommand
        } = command;
        const leased = acquireTaskLease(task, leaseCommand, {
          now,
          dependenciesReady: await this.dependenciesReady(
            client,
            command.taskId,
          ),
        });
        return taskRecordSchema.parse({
          ...leased,
          dispatchBotId: command.botId,
        });
      },
      async (task, client) => {
        if (task.status !== "assigned" || task.dispatchBotId === null) {
          throw new TaskSystemError(
            "TASK_PERSISTENCE_FAILED",
            "Assignment replay did not retain an active durable dispatch target.",
          );
        }
        const outbox = await this.ensureDispatchOutbox(
          client,
          task,
          task.updatedAt,
        );
        return { task, dispatch: outbox.payload, outbox };
      },
      true,
    );
  }

  assignTask(input: unknown): Promise<AcquireTaskAssignmentResult> {
    return this.acquireTaskAssignment(input);
  }

  acquireAssignmentLease(input: unknown): Promise<AcquireTaskAssignmentResult> {
    return this.acquireTaskAssignment(input);
  }

  /**
   * Persists a Coordinator-owned execution lease without creating a BullMQ
   * dispatch. This is for synchronous, already-connected control paths (the
   * guarded Local Planner); a queued task must use acquireTaskAssignment so
   * its durable outbox cannot be omitted.
   */
  acquireSynchronousAssignment(
    input: unknown,
  ): Promise<AcquireSynchronousAssignmentResult> {
    const command: TaskAssignmentAcquireCommand =
      taskAssignmentAcquireCommandSchema.parse(input);
    return this.mutate(
      command,
      "task.assignment-acquired",
      "TASK_ASSIGNMENT_ACQUIRED",
      async (task, now, client) => {
        if (task.dispatchBotId !== null) {
          throw new TaskSystemError(
            "TASK_OPERATION_CONFLICT",
            "Synchronous assignment cannot replace a durable dispatch target.",
          );
        }
        await this.assertBotAssignmentAvailable(client, command.botId, task.taskId);
        // A legacy or manually repaired row may have lost its dispatch target
        // while retaining the same-revision outbox.  Treat that state as
        // ambiguous instead of leasing it synchronously and orphaning the
        // durable delivery record.
        const outbox = await client.query(
          `SELECT 1
           FROM studio_task_outbox
           WHERE task_id = $1
             AND expected_revision = $2
             AND type = 'task.dispatch.v1'
           LIMIT 1
           FOR UPDATE`,
          [task.taskId, task.revision],
        );
        if (outbox.rows.length > 0) {
          throw new TaskSystemError(
            "TASK_OPERATION_CONFLICT",
            "Synchronous assignment cannot claim a task with a durable dispatch outbox.",
          );
        }
        this.assertAssignmentServerContext(task, command);
        if (await this.hasTaskCancellationRequest(client, task.taskId)) {
          throw new TaskSystemError(
            "TASK_CANCELLATION_PENDING",
            "Task cancellation must resolve before assignment.",
          );
        }
        const {
          serverProfileId: _serverProfileId,
          dimension: _dimension,
          ...leaseCommand
        } = command;
        const leased = acquireTaskLease(task, leaseCommand, {
          now,
          dependenciesReady: await this.dependenciesReady(
            client,
            command.taskId,
          ),
        });
        return taskRecordSchema.parse({
          ...leased,
          dispatchBotId: command.botId,
        });
      },
      undefined,
      true,
    );
  }

  async retryTaskDispatch(input: unknown): Promise<RetryTaskDispatchResult> {
    const command: TaskDispatchRetryCommand =
      taskDispatchRetryCommandSchema.parse(input);
    const operationFingerprint = taskOperationFingerprint({
      kind: TASK_DISPATCH_RETRY_OPERATION_KIND,
      command,
    });
    const client = await this.pool.connect();
    try {
      await this.beginTransaction(client);
      await this.lockOperation(client, command.operationId);
      const replay = await this.findOperationReplay(
        client,
        command,
        operationFingerprint,
      );
      if (replay) {
        if (
          replay.status !== "queued" ||
          replay.revision !== command.expectedRevision + 1
        ) {
          throw new TaskSystemError(
            "TASK_PERSISTENCE_FAILED",
            "Task dispatch retry history contains an invalid snapshot.",
          );
        }
        const outbox = await this.ensureDispatchOutbox(
          client,
          replay,
          replay.updatedAt,
        );
        await client.query("COMMIT");
        return { task: replay, dispatch: outbox.payload, outbox };
      }

      const current = await this.loadTask(client, command.taskId, true);
      if (!current) {
        throw new TaskSystemError("TASK_NOT_FOUND", "Task does not exist.");
      }
      if (current.status !== "blocked") {
        throw new TaskSystemError(
          "TASK_TRANSITION_INVALID",
          "Only a blocked task can retry durable dispatch.",
        );
      }
      if (await this.hasTaskCancellationRequest(client, current.taskId)) {
        throw new TaskSystemError(
          "TASK_CANCELLATION_PENDING",
          "Task cancellation must resolve before dispatch retry.",
        );
      }
      const now = await this.databaseNow(client);
      if (
        current.deadline !== null &&
        Date.parse(current.deadline) <= now.getTime()
      ) {
        throw new TaskSystemError(
          "TASK_DEADLINE_EXPIRED",
          "Task deadline has already expired.",
        );
      }
      const transitionCommand = taskTransitionCommandSchema.parse({
        ...command,
        to: "queued",
        leaseOwner: null,
        failureReason: null,
        result: null,
        evidence: [],
      });
      const next = transitionTask(current, transitionCommand, now);
      const updated = await client.query(
        `UPDATE studio_tasks SET
          status = $2,
          assigned_bot_id = $3,
          retry_count = $4,
          lease_owner = $5,
          lease_expires_at = $6,
          failure_reason = $7,
          result = $8::jsonb,
          evidence = $9::jsonb,
          revision = $10,
          updated_at = $11,
          started_at = $12,
          finished_at = $13
        WHERE task_id = $1 AND revision = $14`,
        [
          next.taskId,
          next.status,
          next.assignedBotId,
          next.retryCount,
          next.leaseOwner,
          next.leaseExpiresAt,
          next.failureReason,
          next.result === null ? null : JSON.stringify(next.result),
          JSON.stringify(next.evidence),
          next.revision,
          next.updatedAt,
          next.startedAt,
          next.finishedAt,
          current.revision,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new TaskSystemError(
          "TASK_REVISION_CONFLICT",
          "Task changed while retrying durable dispatch.",
        );
      }
      await this.appendHistory(client, {
        command,
        operationFingerprint,
        eventType: "task.dispatch-retried",
        fromStatus: current.status,
        toStatus: next.status,
        reasonCode: command.reasonCode,
        task: next,
        timestamp: next.updatedAt,
      });
      const outbox = await this.ensureDispatchOutbox(
        client,
        next,
        next.updatedAt,
      );
      await client.query("COMMIT");
      return { task: next, dispatch: outbox.payload, outbox };
    } catch (error) {
      await this.rollback(client);
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  async requestTaskCancellation(
    input: TaskCancellationRequestInput,
  ): Promise<TaskCancellationRequest> {
    const operationId = taskCancelCommandSchema.shape.operationId.parse(
      input.operationId,
    );
    const taskId = taskCancelCommandSchema.shape.taskId.parse(input.taskId);
    const actorId = identifierSchema.parse(input.actorId);
    const reasonCode = taskCancelCommandSchema.shape.reasonCode.parse(
      input.reasonCode,
    );
    const operationFingerprint = taskOperationFingerprint({
      schemaVersion: "1.0",
      operationId,
      taskId,
      actorId,
      leaseOwner: null,
      reasonCode,
    });
    const client = await this.pool.connect();
    try {
      await this.beginTransaction(client);
      await this.lockOperation(client, operationId);
      const operationResult = await client.query(
        `SELECT *
         FROM studio_task_cancellation_requests
         WHERE operation_id = $1
         FOR UPDATE`,
        [operationId],
      );
      const operationRow = operationResult.rows[0];
      if (operationRow) {
        const existing = mapCancellationRequestRow(operationRow);
        if (
          existing.operationFingerprint !== operationFingerprint ||
          existing.taskId !== taskId
        ) {
          throw new TaskSystemError(
            "TASK_OPERATION_CONFLICT",
            "Cancellation operation ID was reused with different parameters.",
          );
        }
        await client.query("COMMIT");
        return existing;
      }
      const task = await this.loadTask(client, taskId, true);
      if (!task) {
        throw new TaskSystemError("TASK_NOT_FOUND", "Task does not exist.");
      }
      if (
        task.status === "completed" ||
        task.status === "expired" ||
        task.status === "cancelled"
      ) {
        throw new TaskSystemError(
          "TASK_TERMINAL",
          "Terminal task cannot accept a new cancellation request.",
        );
      }
      const requestedAt = (await this.databaseNow(client)).toISOString();
      const requestId = randomUUID();
      await client.query(
        `INSERT INTO studio_task_cancellation_requests (
          request_id, operation_id, task_id, operation_fingerprint, actor_id,
          reason_code, requested_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (task_id) DO NOTHING`,
        [
          requestId,
          operationId,
          taskId,
          operationFingerprint,
          actorId,
          reasonCode,
          requestedAt,
        ],
      );
      const stored = await client.query(
        `SELECT *
         FROM studio_task_cancellation_requests
         WHERE task_id = $1
         FOR UPDATE`,
        [taskId],
      );
      const row = stored.rows[0];
      if (!row) {
        throw new TaskSystemError(
          "TASK_PERSISTENCE_FAILED",
          "Cancellation request disappeared after insertion.",
        );
      }
      const request = mapCancellationRequestRow(row);
      if (
        request.operationId !== operationId ||
        request.operationFingerprint !== operationFingerprint
      ) {
        throw new TaskSystemError(
          "TASK_OPERATION_CONFLICT",
          "Task already has a cancellation request for a different operation.",
        );
      }
      await client.query("COMMIT");
      return request;
    } catch (error) {
      await this.rollback(client);
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  async acknowledgeTaskCancellation(
    input: TaskCancellationAcknowledgeInput,
  ): Promise<boolean> {
    const taskId = taskCancelCommandSchema.shape.taskId.parse(input.taskId);
    const acknowledgedBy = identifierSchema.parse(input.acknowledgedBy);
    const leaseOwner = identifierSchema.parse(input.leaseOwner);
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `UPDATE studio_task_cancellation_requests AS request
         SET acknowledged_at = clock_timestamp(), acknowledged_by = $2
         FROM studio_tasks AS task
         WHERE request.task_id = $1
           AND request.acknowledged_at IS NULL
           AND task.task_id = request.task_id
           AND task.status IN ('assigned', 'running')
           AND task.lease_owner = $3`,
        [taskId, acknowledgedBy, leaseOwner],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  async getTaskCancellationRequest(
    taskId: string,
  ): Promise<TaskCancellationRequest | null> {
    const parsedTaskId = taskCancelCommandSchema.shape.taskId.parse(taskId);
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT *
         FROM studio_task_cancellation_requests
         WHERE task_id = $1`,
        [parsedTaskId],
      );
      const row = result.rows[0];
      return row ? mapCancellationRequestRow(row) : null;
    } catch (error) {
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  async resolveTaskCancellation(
    input: ResolveTaskCancellationInput,
  ): Promise<ResolveTaskCancellationResult | null> {
    const taskId = taskCancelCommandSchema.shape.taskId.parse(input.taskId);
    const resolverId = identifierSchema.parse(input.resolverId);
    const leaseOwner = identifierSchema.nullable().parse(input.leaseOwner);
    const client = await this.pool.connect();
    try {
      await this.beginTransaction(client);
      const visibleRequest = await client.query(
        `SELECT *
         FROM studio_task_cancellation_requests
         WHERE task_id = $1`,
        [taskId],
      );
      const visibleRow = visibleRequest.rows[0];
      if (!visibleRow) {
        await client.query("COMMIT");
        return null;
      }
      const visible = mapCancellationRequestRow(visibleRow);
      await this.lockOperation(client, visible.operationId);
      const task = await this.loadTask(client, taskId, true);
      if (!task) {
        throw new TaskSystemError("TASK_NOT_FOUND", "Task does not exist.");
      }
      const lockedRequest = await client.query(
        `SELECT *
         FROM studio_task_cancellation_requests
         WHERE task_id = $1
         FOR UPDATE`,
        [taskId],
      );
      const lockedRow = lockedRequest.rows[0];
      if (!lockedRow) {
        throw new TaskSystemError(
          "TASK_PERSISTENCE_FAILED",
          "Cancellation request disappeared while being resolved.",
        );
      }
      const request = mapCancellationRequestRow(lockedRow);
      if (request.operationId !== visible.operationId) {
        throw new TaskSystemError(
          "TASK_OPERATION_CONFLICT",
          "Cancellation request identity changed while being resolved.",
        );
      }
      const now = await this.databaseNow(client);
      if (task.status === "completed" || task.status === "expired") {
        throw new TaskSystemError(
          "TASK_TERMINAL",
          "Task reached a non-cancellation terminal state.",
        );
      }

      let resolvedTask = task;
      if (task.status !== "cancelled") {
        const active = task.status === "assigned" || task.status === "running";
        if (active) {
          if (task.leaseOwner === null || task.leaseExpiresAt === null) {
            throw new TaskSystemError(
              "TASK_LEASE_REQUIRED",
              "Active task cancellation requires a durable lease.",
            );
          }
          if (leaseOwner === null) {
            if (Date.parse(task.leaseExpiresAt) > now.getTime()) {
              throw new TaskSystemError(
                "TASK_LEASE_OWNER_MISMATCH",
                "Live task cancellation must be resolved by its lease owner.",
              );
            }
          } else if (task.leaseOwner !== leaseOwner) {
            throw new TaskSystemError(
              "TASK_LEASE_OWNER_MISMATCH",
              "Task cancellation resolver does not own the durable lease.",
            );
          }
        } else if (leaseOwner !== null) {
          throw new TaskSystemError(
            "TASK_LEASE_OWNER_MISMATCH",
            "Inactive task cancellation cannot claim a lease owner.",
          );
        }

        const timestamp = now.toISOString();
        resolvedTask = taskRecordSchema.parse({
          ...task,
          status: "cancelled",
          assignedBotId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          revision: task.revision + 1,
          updatedAt: timestamp,
          finishedAt: timestamp,
        });
        const updated = await client.query(
          `UPDATE studio_tasks SET
            status = 'cancelled',
            assigned_bot_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            revision = $2,
            updated_at = $3,
            finished_at = $3
          WHERE task_id = $1 AND revision = $4`,
          [task.taskId, resolvedTask.revision, timestamp, task.revision],
        );
        if (updated.rowCount !== 1) {
          throw new TaskSystemError(
            "TASK_REVISION_CONFLICT",
            "Task changed while resolving cancellation.",
          );
        }
        const command = taskCancelCommandSchema.parse({
          schemaVersion: "1.0",
          operationId: request.operationId,
          taskId: request.taskId,
          actorId: request.actorId,
          leaseOwner: null,
          reasonCode: request.reasonCode,
        });
        await this.appendHistory(client, {
          command,
          operationFingerprint: request.operationFingerprint,
          eventType: "task.cancelled",
          fromStatus: task.status,
          toStatus: resolvedTask.status,
          reasonCode: request.reasonCode,
          task: resolvedTask,
          timestamp,
        });
      }

      const acknowledged = await client.query(
        `UPDATE studio_task_cancellation_requests
         SET acknowledged_at = COALESCE(acknowledged_at, $3),
             acknowledged_by = COALESCE(acknowledged_by, $2)
         WHERE task_id = $1
         RETURNING *`,
        [taskId, resolverId, now.toISOString()],
      );
      const acknowledgedRow = acknowledged.rows[0];
      if (!acknowledgedRow) {
        throw new TaskSystemError(
          "TASK_PERSISTENCE_FAILED",
          "Resolved cancellation could not be acknowledged.",
        );
      }
      const resolvedRequest = mapCancellationRequestRow(acknowledgedRow);
      await client.query("COMMIT");
      return { request: resolvedRequest, task: resolvedTask };
    } catch (error) {
      await this.rollback(client);
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  transition(input: unknown): Promise<TaskRecord> {
    const command = taskTransitionCommandSchema.parse(input);
    return this.mutate(
      command,
      "task.transitioned",
      command.reasonCode,
      async (task, now, client) => {
        if (
          command.to !== "cancelled" &&
          (await this.hasTaskCancellationRequest(client, task.taskId))
        ) {
          throw new TaskSystemError(
            "TASK_CANCELLATION_PENDING",
            "Task has a durable cancellation request pending.",
          );
        }
        return transitionTask(task, command, now);
      },
    );
  }

  cancelTask(input: unknown): Promise<TaskRecord> {
    const command = taskCancelCommandSchema.parse(input);
    return this.mutate(
      command,
      "task.cancelled",
      command.reasonCode,
      (task, now) =>
        transitionTask(
          task,
          {
            schemaVersion: "1.0",
            operationId: command.operationId,
            taskId: command.taskId,
            expectedRevision: task.revision,
            actorId: command.actorId,
            to: "cancelled",
            reasonCode: command.reasonCode,
            leaseOwner: command.leaseOwner,
            failureReason: null,
            result: null,
            evidence: [],
          },
          now,
        ),
    );
  }

  acquireLease(input: unknown): Promise<TaskRecord> {
    const command = taskLeaseAcquireCommandSchema.parse(input);
    return this.mutate(
      command,
      "task.lease-acquired",
      "TASK_LEASE_ACQUIRED",
      async (task, now, client) => {
        await this.assertBotAssignmentAvailable(client, command.botId, task.taskId);
        if (await this.hasTaskCancellationRequest(client, task.taskId)) {
          throw new TaskSystemError(
            "TASK_CANCELLATION_PENDING",
            "Task cancellation must resolve before lease acquisition.",
          );
        }
        return acquireTaskLease(task, command, {
          now,
          dependenciesReady: await this.dependenciesReady(
            client,
            command.taskId,
          ),
        });
      },
    );
  }

  renewLease(input: unknown): Promise<TaskRecord> {
    const command = taskLeaseRenewCommandSchema.parse(input);
    return this.mutate(
      command,
      "task.lease-renewed",
      "TASK_LEASE_RENEWED",
      (task, now) => renewTaskLease(task, command, now),
    );
  }

  releaseLease(input: unknown): Promise<TaskRecord> {
    const command = taskLeaseReleaseCommandSchema.parse(input);
    return this.mutate(
      command,
      "task.lease-released",
      command.reasonCode,
      (task, now) => releaseTaskLease(task, command, now),
    );
  }

  expireLease(input: unknown): Promise<TaskRecord> {
    const command = taskLeaseExpireCommandSchema.parse(input);
    return this.mutate(
      command,
      "task.lease-expired",
      command.reasonCode,
      async (task, now, client) => {
        if (await this.hasTaskCancellationRequest(client, task.taskId)) {
          throw new TaskSystemError(
            "TASK_CANCELLATION_PENDING",
            "Task cancellation must resolve before lease expiry.",
          );
        }
        return expireTaskLease(task, command, now);
      },
    );
  }

  /**
   * Coordinator recovery boundary. Expiring an assigned lease creates the
   * next revision's durable dispatch outbox in the same PostgreSQL
   * transaction. A running task becomes terminal and therefore produces no
   * dispatch. Replaying the same operation returns the same task snapshot and
   * outbox record.
   */
  recoverExpiredLease(input: unknown): Promise<RecoverExpiredLeaseResult> {
    const command = taskLeaseExpireCommandSchema.parse(input);
    return this.mutate(
      command,
      "task.lease-expired",
      command.reasonCode,
      async (task, now, client) => {
        if (await this.hasTaskCancellationRequest(client, task.taskId)) {
          throw new TaskSystemError(
            "TASK_CANCELLATION_PENDING",
            "Task cancellation must resolve before lease recovery.",
          );
        }
        return expireTaskLease(task, command, now);
      },
      async (task, client) => {
        if (task.status !== "queued") {
          return { task, dispatch: null, outbox: null };
        }
        const outbox = await this.ensureDispatchOutbox(
          client,
          task,
          task.updatedAt,
        );
        return { task, dispatch: outbox.payload, outbox };
      },
    );
  }

  private async blockTaskAfterOutboxFailure(
    client: PostgresClientLike,
    input: Readonly<{
      messageId: string;
      taskId: string;
      expectedRevision: number;
      actorId: string;
      reasonCode: string;
    }>,
  ): Promise<void> {
    const current = await this.loadTask(client, input.taskId, true);
    if (!current) {
      throw new TaskSystemError(
        "TASK_NOT_FOUND",
        "Outbox failure references a task that does not exist.",
      );
    }
    if (
      current.status !== "queued" ||
      current.revision !== input.expectedRevision
    ) {
      return;
    }
    if (await this.hasTaskCancellationRequest(client, current.taskId)) {
      throw new TaskSystemError(
        "TASK_CANCELLATION_PENDING",
        "Task cancellation must resolve before outbox failure handling.",
      );
    }
    const now = await this.databaseNow(client);
    const targetStatus =
      current.deadline !== null && Date.parse(current.deadline) <= now.getTime()
        ? "expired"
        : "blocked";
    const command = taskTransitionCommandSchema.parse({
      schemaVersion: "1.0",
      operationId: input.messageId,
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      actorId: input.actorId,
      to: targetStatus,
      reasonCode: input.reasonCode,
      leaseOwner: null,
      failureReason: input.reasonCode,
      result: null,
      evidence: [],
    });
    const next = taskRecordSchema.parse({
      ...transitionTask(current, command, now),
      failureReason: input.reasonCode,
    });
    const updated = await client.query(
      `UPDATE studio_tasks SET
        status = $2,
        assigned_bot_id = $3,
        retry_count = $4,
        lease_owner = $5,
        lease_expires_at = $6,
        failure_reason = $7,
        result = $8::jsonb,
        evidence = $9::jsonb,
        revision = $10,
        updated_at = $11,
        started_at = $12,
        finished_at = $13
      WHERE task_id = $1 AND revision = $14`,
      [
        next.taskId,
        next.status,
        next.assignedBotId,
        next.retryCount,
        next.leaseOwner,
        next.leaseExpiresAt,
        next.failureReason,
        next.result === null ? null : JSON.stringify(next.result),
        JSON.stringify(next.evidence),
        next.revision,
        next.updatedAt,
        next.startedAt,
        next.finishedAt,
        current.revision,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new TaskSystemError(
        "TASK_REVISION_CONFLICT",
        "Task changed while recording an outbox failure.",
      );
    }
    await this.appendHistory(client, {
      command,
      operationFingerprint: taskOperationFingerprint(command),
      eventType:
        targetStatus === "expired"
          ? "task.dispatch-expired"
          : "task.dispatch-blocked",
      fromStatus: current.status,
      toStatus: next.status,
      reasonCode: input.reasonCode,
      task: next,
      timestamp: next.updatedAt,
    });
  }

  private assertOutboxMatchesTask(
    task: TaskRecord,
    outbox: TaskOutboxRecord,
  ): void {
    if (
      outbox.taskId !== task.taskId ||
      outbox.expectedRevision !== task.revision ||
      outbox.payload.traceId !== task.traceId ||
      outbox.payload.botId !== task.dispatchBotId ||
      outbox.payload.payload.taskType !== task.taskType ||
      outbox.payload.payload.handlerVersion !== task.handlerVersion ||
      outbox.payload.payload.executionIdempotent !== task.executionIdempotent
      || outbox.payload.payload.assignmentLeaseOwner !==
        (task.status === "assigned" ? task.leaseOwner ?? undefined : undefined)
    ) {
      throw new TaskSystemError(
        "TASK_OPERATION_CONFLICT",
        "Task dispatch outbox payload conflicts with the task record.",
      );
    }
  }

  private async supersedeDispatchOutbox(
    client: PostgresClientLike,
    task: TaskRecord,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE studio_task_outbox
       SET status = 'failed',
           claimed_by = NULL,
           claim_expires_at = NULL,
           last_error = 'TASK_DISPATCH_SUPERSEDED',
           updated_at = clock_timestamp()
       WHERE task_id = $1
         AND expected_revision = $2
         AND type = 'task.dispatch.v1'
         AND status <> 'failed'`,
      [task.taskId, task.revision],
    );
    if (result.rowCount !== null && result.rowCount > 1) {
      throw new TaskSystemError(
        "TASK_PERSISTENCE_FAILED",
        "More than one dispatch outbox exists for a task revision.",
      );
    }
  }

  private async mutate<
    TCommand extends OperationCommand,
    TResult = TaskRecord,
  >(
    command: TCommand,
    eventType: string,
    reasonCode: string,
    planner: (
      task: TaskRecord,
      now: Date,
      client: PostgresClientLike,
    ) => TaskRecord | Promise<TaskRecord>,
    resultBuilder?: (
      task: TaskRecord,
      client: PostgresClientLike,
    ) => TResult | Promise<TResult>,
    persistDispatchBotId = false,
  ): Promise<TResult> {
    const operationFingerprint = taskOperationFingerprint(command);
    const client = await this.pool.connect();
    try {
      await this.beginTransaction(client);
      await this.lockOperation(client, command.operationId);
      const replay = await this.findOperationReplay(
        client,
        command,
        operationFingerprint,
      );
      if (replay) {
        const result = resultBuilder
          ? await resultBuilder(replay, client)
          : (replay as TResult);
        await client.query("COMMIT");
        return result;
      }
      const current = await this.loadTask(client, command.taskId, true);
      if (!current) {
        throw new TaskSystemError("TASK_NOT_FOUND", "Task does not exist.");
      }
      const now = await this.databaseNow(client);
      const next = await planner(current, now, client);
      const updated = await client.query(
        persistDispatchBotId
          ? `UPDATE studio_tasks SET
              status = $2,
              dispatch_bot_id = $3,
              assigned_bot_id = $4,
              retry_count = $5,
              lease_owner = $6,
              lease_expires_at = $7,
              failure_reason = $8,
              result = $9::jsonb,
              evidence = $10::jsonb,
              revision = $11,
              updated_at = $12,
              started_at = $13,
              finished_at = $14
            WHERE task_id = $1 AND revision = $15`
          : `UPDATE studio_tasks SET
              status = $2,
              assigned_bot_id = $3,
              retry_count = $4,
              lease_owner = $5,
              lease_expires_at = $6,
              failure_reason = $7,
              result = $8::jsonb,
              evidence = $9::jsonb,
              revision = $10,
              updated_at = $11,
              started_at = $12,
              finished_at = $13
            WHERE task_id = $1 AND revision = $14`,
        persistDispatchBotId
          ? [
              next.taskId,
              next.status,
              next.dispatchBotId,
              next.assignedBotId,
              next.retryCount,
              next.leaseOwner,
              next.leaseExpiresAt,
              next.failureReason,
              next.result === null ? null : JSON.stringify(next.result),
              JSON.stringify(next.evidence),
              next.revision,
              next.updatedAt,
              next.startedAt,
              next.finishedAt,
              current.revision,
            ]
          : [
              next.taskId,
              next.status,
              next.assignedBotId,
              next.retryCount,
              next.leaseOwner,
              next.leaseExpiresAt,
              next.failureReason,
              next.result === null ? null : JSON.stringify(next.result),
              JSON.stringify(next.evidence),
              next.revision,
              next.updatedAt,
              next.startedAt,
              next.finishedAt,
              current.revision,
            ],
      );
      if (updated.rowCount !== 1) {
        throw new TaskSystemError(
          "TASK_REVISION_CONFLICT",
          "Task changed during the operation.",
        );
      }
      await this.appendHistory(client, {
        command,
        operationFingerprint,
        eventType,
        fromStatus: current.status,
        toStatus: next.status,
        reasonCode,
        task: next,
        timestamp: next.updatedAt,
      });
      const result = resultBuilder
        ? await resultBuilder(next, client)
        : (next as TResult);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await this.rollback(client);
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
  }

  private async loadTask(
    client: PostgresClientLike,
    taskId: string,
    forUpdate: boolean,
  ): Promise<TaskRecord | null> {
    const taskResult = await client.query(
      `SELECT * FROM studio_tasks WHERE task_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [taskId],
    );
    const row = taskResult.rows[0];
    if (!row) return null;
    return mapTaskRow(row, await this.loadDependencyIds(client, taskId));
  }

  private async hasTaskCancellationRequest(
    client: PostgresClientLike,
    taskId: string,
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1
       FROM studio_task_cancellation_requests
       WHERE task_id = $1
       LIMIT 1`,
      [taskId],
    );
    return result.rows.length > 0;
  }

  private async loadDependencyIds(
    client: PostgresClientLike,
    taskId: string,
  ): Promise<readonly string[]> {
    const dependencies = await client.query<{ dependency_task_id: unknown }>(
      `SELECT dependency_task_id
       FROM studio_task_dependencies
       WHERE task_id = $1
       ORDER BY dependency_task_id ASC`,
      [taskId],
    );
    return dependencies.rows.map(({ dependency_task_id }) =>
      text(dependency_task_id),
    );
  }

  private async lockOperation(
    client: PostgresClientLike,
    operationId: string,
  ): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended($1::text, 0)
       )`,
      [operationId],
    );
  }

  private async lockBotAssignment(
    client: PostgresClientLike,
    botId: string,
  ): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended($1::text, 0)
       )`,
      [`task-assignment-bot:${botId}`],
    );
  }

  private async assertBotAssignmentAvailable(
    client: PostgresClientLike,
    botId: string,
    taskId: string,
  ): Promise<void> {
    await this.lockBotAssignment(client, botId);
    const competing = await client.query(
      `SELECT task_id
       FROM studio_tasks
       WHERE assigned_bot_id = $1
         AND status IN ('assigned', 'running')
         AND lease_expires_at > clock_timestamp()
       LIMIT 1
       FOR UPDATE`,
      [botId],
    );
    const competingTaskId = competing.rows[0]?.task_id;
    if (competingTaskId !== undefined && competingTaskId !== taskId) {
      throw new TaskSystemError(
        "TASK_BOT_ASSIGNMENT_CONFLICT",
        "Bot already owns another active durable task assignment.",
      );
    }
  }

  private assertAssignmentServerContext(
    task: TaskRecord,
    command: TaskAssignmentAcquireCommand,
  ): void {
    if (
      task.target !== null &&
      (task.target.serverProfileId !== command.serverProfileId ||
        task.target.dimension !== command.dimension)
    ) {
      throw new TaskSystemError(
        "TASK_SERVER_CONTEXT_CONFLICT",
        "Assignment server context does not match the task target.",
      );
    }
  }

  private async beginTransaction(client: PostgresClientLike): Promise<void> {
    await client.query("BEGIN");
    await client.query(TRANSACTION_LOCK_TIMEOUT_SQL);
    await client.query(TRANSACTION_STATEMENT_TIMEOUT_SQL);
  }

  private async databaseNow(client: PostgresClientLike): Promise<Date> {
    const result = await client.query<{ database_now: unknown }>(
      "SELECT clock_timestamp() AS database_now",
    );
    const timestamp = iso(result.rows[0]?.database_now);
    if (timestamp === null) {
      throw new TaskSystemError(
        "TASK_PERSISTENCE_FAILED",
        "PostgreSQL did not return its current timestamp.",
      );
    }
    return new Date(timestamp);
  }

  private async dependenciesReady(
    client: PostgresClientLike,
    taskId: string,
  ): Promise<boolean> {
    const result = await client.query<{ incomplete_count: unknown }>(
      `SELECT COUNT(*)::integer AS incomplete_count
       FROM studio_task_dependencies AS link
       JOIN studio_tasks AS dependency
         ON dependency.task_id = link.dependency_task_id
       WHERE link.task_id = $1 AND dependency.status <> 'completed'`,
      [taskId],
    );
    return integer(result.rows[0]?.incomplete_count ?? 0) === 0;
  }

  private async findOperationReplay(
    client: PostgresClientLike,
    command: OperationCommand,
    operationFingerprint: string,
  ): Promise<TaskRecord | null> {
    const replay = await client.query<{
      operation_fingerprint: unknown;
      task_id: unknown;
      task_snapshot: unknown;
    }>(
      `SELECT operation_fingerprint, task_id, task_snapshot
       FROM studio_task_history
       WHERE operation_id = $1`,
      [command.operationId],
    );
    const row = replay.rows[0];
    if (!row) return null;
    if (
      text(row.operation_fingerprint) !== operationFingerprint ||
      text(row.task_id) !== command.taskId
    ) {
      throw new TaskSystemError(
        "TASK_OPERATION_CONFLICT",
        "Operation ID was reused with different parameters.",
      );
    }
    return taskRecordSchema.parse(row.task_snapshot);
  }

  private async appendHistory(
    client: PostgresClientLike,
    input: Readonly<{
      command: OperationCommand;
      operationFingerprint: string;
      eventType: string;
      fromStatus: string | null;
      toStatus: string;
      reasonCode: string;
      task: TaskRecord;
      timestamp: string;
    }>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO studio_task_history (
        operation_id, operation_fingerprint, task_id, event_type,
        from_status, to_status, actor_id, reason_code, task_snapshot, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        input.command.operationId,
        input.operationFingerprint,
        input.task.taskId,
        input.eventType,
        input.fromStatus,
        input.toStatus,
        input.command.actorId,
        input.reasonCode,
        JSON.stringify(input.task),
        input.timestamp,
      ],
    );
  }

  private async rollback(client: PostgresClientLike): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure; the pool will discard a broken client.
    }
  }

  private persistenceError(error: unknown): TaskSystemError {
    if (error instanceof TaskSystemError) return error;
    return new TaskSystemError(
      "TASK_PERSISTENCE_FAILED",
      "PostgreSQL task operation failed.",
    );
  }
}
