import { createHash } from "node:crypto";

import { TaskSystemError } from "./errors.js";
import {
  taskCreateCommandSchema,
  taskLeaseAcquireCommandSchema,
  taskLeaseExpireCommandSchema,
  taskLeaseReleaseCommandSchema,
  taskLeaseRenewCommandSchema,
  taskRecordSchema,
  taskTransitionCommandSchema,
  type TaskCreateCommand,
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

type OperationCommand = Readonly<{
  operationId: string;
  taskId: string;
  actorId: string;
}>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function taskOperationFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
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
    title: row.title,
    description: row.description,
    priority: integer(row.priority),
    status: row.status,
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
): TaskRecord {
  return taskRecordSchema.parse({
    schemaVersion: "1.0",
    taskId: command.taskId,
    idempotencyScope: command.idempotencyScope,
    idempotencyKey: command.idempotencyKey,
    requestFingerprint,
    taskType: command.taskType,
    title: command.title,
    description: command.description,
    priority: command.priority,
    status: "queued",
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

export class PostgresTaskRepository {
  constructor(
    private readonly pool: PostgresPoolLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createTask(input: unknown): Promise<CreateTaskResult> {
    const command = taskCreateCommandSchema.parse(input);
    const now = this.now();
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
    const requestFingerprint = createRequestFingerprint(command);
    const operationFingerprint = taskOperationFingerprint(command);
    const proposed = createdTask(command, requestFingerprint, timestamp);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const replay = await this.findOperationReplay(
        client,
        command,
        operationFingerprint,
      );
      if (replay) {
        await client.query("COMMIT");
        return { task: replay, created: false };
      }

      const inserted = await client.query(
        `INSERT INTO studio_tasks (
          task_id, schema_version, idempotency_scope, idempotency_key,
          request_fingerprint, task_type, title, description, priority, status,
          assigned_bot_id, required_skills, required_items, target,
          parent_task_id, deadline, timeout_ms, retry_count, max_retries,
          lease_owner, lease_expires_at, risk_level, failure_reason, result,
          evidence, trace_id, revision, created_at, updated_at, started_at,
          finished_at
        ) VALUES (
          $1, '1.0', $2, $3, $4, $5, $6, $7, $8, 'queued',
          NULL, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, 0, $15,
          NULL, NULL, $16, NULL, NULL, '[]'::jsonb, $17, 0, $18, $18, NULL,
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
          command.title,
          command.description,
          command.priority,
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
      await client.query("COMMIT");
      return { task, created: wasCreated };
    } catch (error) {
      await this.rollback(client);
      throw this.persistenceError(error);
    } finally {
      client.release();
    }
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

  transition(input: unknown): Promise<TaskRecord> {
    const command = taskTransitionCommandSchema.parse(input);
    return this.mutate(
      command,
      "task.transitioned",
      command.reasonCode,
      (task, now) => transitionTask(task, command, now),
    );
  }

  acquireLease(input: unknown): Promise<TaskRecord> {
    const command = taskLeaseAcquireCommandSchema.parse(input);
    return this.mutate(
      command,
      "task.lease-acquired",
      "TASK_LEASE_ACQUIRED",
      async (task, now, client) =>
        acquireTaskLease(task, command, {
          now,
          dependenciesReady: await this.dependenciesReady(
            client,
            command.taskId,
          ),
        }),
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
      (task, now) => expireTaskLease(task, command, now),
    );
  }

  private async mutate<TCommand extends OperationCommand>(
    command: TCommand,
    eventType: string,
    reasonCode: string,
    planner: (
      task: TaskRecord,
      now: Date,
      client: PostgresClientLike,
    ) => TaskRecord | Promise<TaskRecord>,
  ): Promise<TaskRecord> {
    const operationFingerprint = taskOperationFingerprint(command);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await this.findOperationReplay(
        client,
        command,
        operationFingerprint,
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      const current = await this.loadTask(client, command.taskId, true);
      if (!current) {
        throw new TaskSystemError("TASK_NOT_FOUND", "Task does not exist.");
      }
      const now = this.now();
      const next = await planner(current, now, client);
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
      await client.query("COMMIT");
      return next;
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
    const dependencies = await client.query<{ dependency_task_id: unknown }>(
      `SELECT dependency_task_id
       FROM studio_task_dependencies
       WHERE task_id = $1
       ORDER BY dependency_task_id ASC`,
      [taskId],
    );
    return mapTaskRow(
      row,
      dependencies.rows.map(({ dependency_task_id }) =>
        text(dependency_task_id),
      ),
    );
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
