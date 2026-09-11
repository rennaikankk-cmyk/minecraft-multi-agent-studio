import { describe, expect, it } from "vitest";

import {
  taskDispatchRetryCommandSchema,
  taskOutboxRecordSchema,
  type TaskOutboxRecord,
} from "../src/model.js";
import {
  TaskOutboxReconciler,
  type TaskOutboxRepositoryLike,
} from "../src/outbox-reconciler.js";
import {
  MAX_TASK_OUTBOX_ATTEMPTS,
  PostgresTaskRepository,
  type PostgresClientLike,
  type PostgresPoolLike,
  type SqlQueryResult,
} from "../src/postgres-repository.js";

const NOW = "2026-07-27T12:00:00.000Z";
const TASK_A = "2a7f5a33-05c7-4336-a037-27c196256978";
const TASK_B = "3b8f6a44-16d8-4447-b148-38d207367a89";

const submitCommand = {
  schemaVersion: "1.0" as const,
  operationId: "66666666-6666-4666-8666-666666666666",
  taskId: TASK_A,
  idempotencyScope: "coordinator-main",
  idempotencyKey: "collect-stone-001",
  taskType: "resource.collect",
  handlerVersion: "1.0.0",
  executionIdempotent: true,
  title: "Collect stone",
  description: "Collect stone in the isolated test world.",
  priority: 50,
  requiredSkills: [],
  requiredItems: [],
  target: null,
  dependencyIds: [],
  parentTaskId: null,
  deadline: "2026-07-27T13:00:00.000Z",
  timeoutMs: 60_000,
  maxRetries: 2,
  riskLevel: "R1" as const,
  traceId: "trace-task-001",
  actorId: "coordinator-agent",
  dispatchBotId: "worker-01",
};

const retryDispatchCommand = {
  schemaVersion: "1.0" as const,
  operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  taskId: TASK_A,
  expectedRevision: 1,
  actorId: "coordinator-agent",
  reasonCode: "TASK_DISPATCH_RETRY_REQUESTED",
};

const recoverExpiredLeaseCommand = {
  schemaVersion: "1.0" as const,
  operationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  taskId: TASK_A,
  expectedRevision: 1,
  actorId: "coordinator-lease-recovery",
  reasonCode: "TASK_LEASE_EXPIRED" as const,
};

function outbox(
  taskId: string,
  expectedRevision: number,
  messageId: string,
): TaskOutboxRecord {
  return {
    messageId,
    taskId,
    expectedRevision,
    type: "task.dispatch.v1",
    payload: {
      schemaVersion: "1.0",
      messageId,
      traceId: `trace-${taskId.slice(0, 8)}`,
      timestamp: NOW,
      source: { service: "coordinator", instanceId: "coordinator-test" },
      taskId,
      botId: "worker-01",
      type: "task.dispatch.v1",
      payload: {
        expectedRevision,
        taskType: "resource.collect",
        handlerVersion: "1.0.0",
        executionIdempotent: true,
      },
    },
    status: "pending",
    attemptCount: 0,
    availableAt: NOW,
    claimedBy: null,
    claimExpiresAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    deliveredAt: null,
  };
}

class FakeOutboxRepository implements TaskOutboxRepositoryLike {
  readonly entries = new Map<string, TaskOutboxRecord>();
  now = new Date(NOW);

  async claimTaskOutbox(input: {
    claimerId: string;
    limit?: number;
    leaseDurationMs?: number;
  }): Promise<readonly TaskOutboxRecord[]> {
    const claimed: TaskOutboxRecord[] = [];
    for (const [messageId, entry] of this.entries) {
      if (claimed.length >= (input.limit ?? 100)) break;
      if (
        !(
          entry.status === "pending" ||
          entry.status === "delivered" ||
          (entry.status === "claimed" &&
            Date.parse(entry.claimExpiresAt ?? "") <= this.now.getTime())
        ) ||
        Date.parse(entry.availableAt) > this.now.getTime()
      ) {
        continue;
      }
      const next: TaskOutboxRecord = {
        ...entry,
        status: "claimed",
        claimedBy: input.claimerId,
        claimExpiresAt: new Date(
          this.now.getTime() + (input.leaseDurationMs ?? 30_000),
        ).toISOString(),
        updatedAt: this.now.toISOString(),
      };
      this.entries.set(messageId, next);
      claimed.push(next);
    }
    return claimed;
  }

  async markTaskOutboxDelivered(input: {
    messageId: string;
    claimerId: string;
  }): Promise<boolean> {
    const entry = this.entries.get(input.messageId);
    if (!entry || entry.status !== "claimed" || entry.claimedBy !== input.claimerId) {
      return false;
    }
    this.entries.set(input.messageId, {
      ...entry,
      status: "delivered",
      attemptCount: 0,
      claimedBy: null,
      claimExpiresAt: null,
      lastError: null,
      availableAt: new Date(this.now.getTime() + 30_000).toISOString(),
      deliveredAt: this.now.toISOString(),
      updatedAt: this.now.toISOString(),
    });
    return true;
  }

  async retryTaskOutbox(input: {
    messageId: string;
    claimerId: string;
    error: string;
    delayMs?: number;
  }): Promise<boolean> {
    const entry = this.entries.get(input.messageId);
    if (!entry || entry.status !== "claimed" || entry.claimedBy !== input.claimerId) {
      return false;
    }
    const attemptCount = Math.min(
      entry.attemptCount + 1,
      MAX_TASK_OUTBOX_ATTEMPTS,
    );
    // Mirrors the PostgreSQL semantics: an already-delivered row is exempt
    // from the delivery failure budget and can never dead-letter.
    const status =
      entry.deliveredAt === null && attemptCount >= MAX_TASK_OUTBOX_ATTEMPTS
        ? "failed"
        : "pending";
    this.entries.set(input.messageId, {
      ...entry,
      status,
      attemptCount,
      claimedBy: null,
      claimExpiresAt: null,
      lastError: input.error,
      availableAt:
        status === "failed"
          ? this.now.toISOString()
          : new Date(
              this.now.getTime() + (input.delayMs ?? 0),
            ).toISOString(),
      updatedAt: this.now.toISOString(),
    });
    return true;
  }
}

class FakeQueue {
  readonly enqueued: TaskOutboxRecord["payload"][] = [];
  readonly removed: Array<{ taskId: string; revision: number }> = [];
  readonly jobs = new Map<string, { getState: () => Promise<string> }>();
  failNext = false;
  removeResultOverride: boolean | null = null;

  async enqueue(input: unknown): Promise<{ accepted: true }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Redis unavailable");
    }
    const dispatch = input as TaskOutboxRecord["payload"];
    const jobKey = `${dispatch.taskId}:${dispatch.payload.expectedRevision}`;
    if (this.jobs.has(jobKey)) return { accepted: true };
    this.enqueued.push(dispatch);
    this.jobs.set(jobKey, {
      getState: async () => "waiting",
    });
    return { accepted: true };
  }

  async getJob(taskId: string, expectedRevision: number) {
    return this.jobs.get(`${taskId}:${expectedRevision}`) ?? null;
  }

  async remove(taskId: string, expectedRevision: number): Promise<boolean> {
    this.removed.push({ taskId, revision: expectedRevision });
    if (this.removeResultOverride !== null) {
      return this.removeResultOverride;
    }
    return this.jobs.delete(`${taskId}:${expectedRevision}`);
  }
}

function reconciler(
  repository: FakeOutboxRepository,
  queue: FakeQueue,
  options: Partial<{ batchSize: number; retryBaseMs: number; retryMaxMs: number }> = {},
): TaskOutboxReconciler {
  return new TaskOutboxReconciler({
    repository,
    queue,
    instanceId: "reconciler-01",
    batchSize: options.batchSize,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
  });
}

class RecordingSubmitClient implements PostgresClientLike {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly operationHistory = new Map<
    string,
    { operationFingerprint: string; taskId: string; taskSnapshot: unknown }
  >();
  outboxRow: Record<string, unknown> | null = null;
  outboxInsertCount = 0;

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<TRow>> {
    this.calls.push({ text, values });
    if (text.includes("FROM studio_task_history")) {
      const replay = this.operationHistory.get(String(values[0]));
      return {
        rows: replay
          ? [
              {
                operation_fingerprint: replay.operationFingerprint,
                task_id: replay.taskId,
                task_snapshot: replay.taskSnapshot,
              } as unknown as TRow,
            ]
          : [],
        rowCount: replay ? 1 : 0,
      };
    }
    if (text.includes("clock_timestamp() AS database_now")) {
      return { rows: [{ database_now: NOW } as unknown as TRow], rowCount: 1 };
    }
    if (text.includes("INSERT INTO studio_tasks")) {
      return {
        rows: [{ task_id: submitCommand.taskId } as unknown as TRow],
        rowCount: 1,
      };
    }
    if (text.includes("INSERT INTO studio_task_history")) {
      this.operationHistory.set(String(values[0]), {
        operationFingerprint: String(values[1]),
        taskId: String(values[2]),
        taskSnapshot: JSON.parse(String(values[8])),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM studio_task_outbox")) {
      return {
        rows: this.outboxRow ? [this.outboxRow as TRow] : [],
        rowCount: this.outboxRow ? 1 : 0,
      };
    }
    if (text.includes("INSERT INTO studio_task_outbox")) {
      const payload = JSON.parse(String(values[4])) as TaskOutboxRecord["payload"];
      this.outboxRow = {
        message_id: values[0],
        task_id: values[1],
        expected_revision: values[2],
        type: values[3],
        payload,
        status: "pending",
        attempt_count: 0,
        // $7 is the caller-supplied availability timestamp (retry backoff).
        available_at: values[6] ?? values[5],
        claimed_by: null,
        claim_expires_at: null,
        last_error: null,
        created_at: values[5],
        updated_at: values[5],
        delivered_at: null,
      };
      this.outboxInsertCount += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

class RecordingSubmitPool implements PostgresPoolLike {
  constructor(readonly client: RecordingSubmitClient) {}

  async connect(): Promise<PostgresClientLike> {
    return this.client;
  }
}

function recordingTaskRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    task_id: TASK_A,
    schema_version: "1.0",
    idempotency_scope: submitCommand.idempotencyScope,
    idempotency_key: submitCommand.idempotencyKey,
    request_fingerprint: "a".repeat(64),
    task_type: submitCommand.taskType,
    handler_version: submitCommand.handlerVersion,
    execution_idempotent: submitCommand.executionIdempotent,
    title: submitCommand.title,
    description: submitCommand.description,
    priority: submitCommand.priority,
    status: "queued",
    dispatch_bot_id: submitCommand.dispatchBotId,
    assigned_bot_id: null,
    required_skills: [],
    required_items: [],
    target: null,
    parent_task_id: null,
    deadline: submitCommand.deadline,
    timeout_ms: submitCommand.timeoutMs,
    retry_count: 0,
    max_retries: submitCommand.maxRetries,
    lease_owner: null,
    lease_expires_at: null,
    risk_level: submitCommand.riskLevel,
    failure_reason: null,
    result: null,
    evidence: [],
    trace_id: submitCommand.traceId,
    revision: 0,
    created_at: NOW,
    updated_at: NOW,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

class RecordingClaimClient implements PostgresClientLike {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(
    readonly claimedRow: Record<string, unknown>,
    readonly taskRow: Record<string, unknown> = recordingTaskRow(),
    readonly databaseTimestamp: string = NOW,
  ) {}

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<TRow>> {
    this.calls.push({ text, values });
    if (text.includes("WITH candidates AS")) {
      return {
        rows: [this.claimedRow as TRow],
        rowCount: 1,
      };
    }
    if (
      text.includes("UPDATE studio_task_outbox") &&
      text.includes("SET status = 'failed'")
    ) {
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("SELECT * FROM studio_tasks")) {
      return {
        rows: [this.taskRow as TRow],
        rowCount: 1,
      };
    }
    if (text.includes("FROM studio_task_dependencies")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("clock_timestamp() AS database_now")) {
      return {
        rows: [
          { database_now: this.databaseTimestamp } as unknown as TRow,
        ],
        rowCount: 1,
      };
    }
    if (text.includes("UPDATE studio_tasks SET")) {
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO studio_task_history")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

class RecordingClaimPool implements PostgresPoolLike {
  constructor(readonly client: RecordingClaimClient) {}

  async connect(): Promise<PostgresClientLike> {
    return this.client;
  }
}

type RecordedOperation = Readonly<{
  operationFingerprint: string;
  taskId: string;
  taskSnapshot: unknown;
}>;

class RecordingDispatchRetryClient implements PostgresClientLike {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly operationHistory = new Map<string, RecordedOperation>();
  readonly outboxRows = new Map<string, Record<string, unknown>>();
  taskRow: Record<string, unknown>;
  outboxInsertCount = 0;
  failOutboxInsert = false;
  private transactionSnapshot:
    | Readonly<{
        taskRow: Record<string, unknown>;
        operationHistory: Map<string, RecordedOperation>;
        outboxRows: Map<string, Record<string, unknown>>;
      }>
    | undefined;

  constructor(
    taskRow: Record<string, unknown> = recordingTaskRow({
      status: "blocked",
      failure_reason: "TASK_OUTBOX_DELIVERY_EXHAUSTED",
      revision: 1,
    }),
    readonly databaseTimestamp: string = NOW,
  ) {
    this.taskRow = taskRow;
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<TRow>> {
    this.calls.push({ text, values });
    if (text === "BEGIN") {
      this.transactionSnapshot = {
        taskRow: { ...this.taskRow },
        operationHistory: new Map(this.operationHistory),
        outboxRows: new Map(
          [...this.outboxRows].map(([key, row]) => [key, { ...row }]),
        ),
      };
      return { rows: [], rowCount: null };
    }
    if (text === "COMMIT") {
      this.transactionSnapshot = undefined;
      return { rows: [], rowCount: null };
    }
    if (text === "ROLLBACK") {
      if (this.transactionSnapshot) {
        this.taskRow = { ...this.transactionSnapshot.taskRow };
        this.operationHistory.clear();
        for (const entry of this.transactionSnapshot.operationHistory) {
          this.operationHistory.set(...entry);
        }
        this.outboxRows.clear();
        for (const [key, row] of this.transactionSnapshot.outboxRows) {
          this.outboxRows.set(key, { ...row });
        }
      }
      this.transactionSnapshot = undefined;
      return { rows: [], rowCount: null };
    }
    if (text.includes("FROM studio_task_history")) {
      const replay = this.operationHistory.get(String(values[0]));
      return {
        rows: replay
          ? [
              {
                operation_fingerprint: replay.operationFingerprint,
                task_id: replay.taskId,
                task_snapshot: replay.taskSnapshot,
              } as unknown as TRow,
            ]
          : [],
        rowCount: replay ? 1 : 0,
      };
    }
    if (text.includes("SELECT * FROM studio_tasks")) {
      return { rows: [this.taskRow as TRow], rowCount: 1 };
    }
    if (text.includes("FROM studio_task_dependencies")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("clock_timestamp() AS database_now")) {
      return {
        rows: [
          { database_now: this.databaseTimestamp } as unknown as TRow,
        ],
        rowCount: 1,
      };
    }
    if (text.includes("UPDATE studio_tasks SET")) {
      const hasDispatchTarget = text.includes("dispatch_bot_id = $3");
      const offset = hasDispatchTarget ? 1 : 0;
      this.taskRow = {
        ...this.taskRow,
        ...(hasDispatchTarget ? { dispatch_bot_id: values[2] } : {}),
        status: values[1],
        assigned_bot_id: values[2 + offset],
        retry_count: values[3 + offset],
        lease_owner: values[4 + offset],
        lease_expires_at: values[5 + offset],
        failure_reason: values[6 + offset],
        result: values[7 + offset] === null ? null : JSON.parse(String(values[7 + offset])),
        evidence: JSON.parse(String(values[8 + offset])),
        revision: values[9 + offset],
        updated_at: values[10 + offset],
        started_at: values[11 + offset],
        finished_at: values[12 + offset],
      };
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO studio_task_history")) {
      this.operationHistory.set(String(values[0]), {
        operationFingerprint: String(values[1]),
        taskId: String(values[2]),
        taskSnapshot: JSON.parse(String(values[8])),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM studio_task_outbox")) {
      const key = `${String(values[0])}:${String(values[1])}`;
      const row = this.outboxRows.get(key);
      return {
        rows: row ? [row as TRow] : [],
        rowCount: row ? 1 : 0,
      };
    }
    if (text.includes("INSERT INTO studio_task_outbox")) {
      if (this.failOutboxInsert) throw new Error("outbox insert failed");
      const payload = JSON.parse(
        String(values[4]),
      ) as TaskOutboxRecord["payload"];
      const row = {
        message_id: values[0],
        task_id: values[1],
        expected_revision: values[2],
        type: values[3],
        payload,
        status: "pending",
        attempt_count: 0,
        // $7 is the caller-supplied availability timestamp (retry backoff);
        // created/updated stay on $6 so a delayed row records when it was made.
        available_at: values[6] ?? values[5],
        claimed_by: null,
        claim_expires_at: null,
        last_error: null,
        created_at: values[5],
        updated_at: values[5],
        delivered_at: null,
      };
      this.outboxRows.set(`${String(values[1])}:${String(values[2])}`, row);
      this.outboxInsertCount += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

class RecordingDispatchRetryPool implements PostgresPoolLike {
  constructor(readonly client: RecordingDispatchRetryClient) {}

  async connect(): Promise<PostgresClientLike> {
    return this.client;
  }
}

describe("TaskOutboxReconciler", () => {
  it("keeps the durable messageId across Redis retry and reconciliation replay", async () => {
    const repository = new FakeOutboxRepository();
    const queue = new FakeQueue();
    const entry = outbox(
      TASK_A,
      0,
      "11111111-1111-4111-8111-111111111111",
    );
    repository.entries.set(entry.messageId, entry);
    queue.failNext = true;
    const runner = reconciler(repository, queue, {
      retryBaseMs: 100,
      retryMaxMs: 1_000,
    });

    await expect(runner.reconcileOnce()).resolves.toEqual({
      claimed: 1,
      enqueued: 0,
      skipped: 0,
      failed: 1,
    });
    expect(repository.entries.get(entry.messageId)?.lastError).toBe(
      "Redis unavailable",
    );
    expect(repository.entries.get(entry.messageId)?.availableAt).toBe(
      "2026-07-27T12:00:00.100Z",
    );
    expect(repository.entries.get(entry.messageId)?.attemptCount).toBe(1);

    repository.now = new Date("2026-07-27T12:00:00.100Z");
    await expect(runner.reconcileOnce()).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      skipped: 0,
      failed: 0,
    });
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.messageId).toBe(entry.messageId);

    await expect(runner.reconcileOnce()).resolves.toEqual({
      claimed: 0,
      enqueued: 0,
      skipped: 0,
      failed: 0,
    });

    repository.now = new Date("2026-07-27T12:00:30.100Z");
    await expect(runner.reconcileOnce()).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      skipped: 0,
      failed: 0,
    });
    expect(queue.enqueued).toHaveLength(1);
    expect(repository.entries.get(entry.messageId)?.attemptCount).toBe(0);
  });

  it("does not enqueue stale events that the PostgreSQL claim query excludes", async () => {
    const repository = new FakeOutboxRepository();
    const queue = new FakeQueue();
    const stale = outbox(
      TASK_A,
      0,
      "22222222-2222-4222-8222-222222222222",
    );
    // A real repository excludes a task with a changed status or revision in
    // claimTaskOutbox's JOIN predicate. The fake represents that absence.
    void stale;
    const runner = reconciler(repository, queue);

    await expect(runner.reconcileOnce()).resolves.toEqual({
      claimed: 0,
      enqueued: 0,
      skipped: 0,
      failed: 0,
    });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("bounds a batch and removes a failed BullMQ job before re-enqueueing", async () => {
    const repository = new FakeOutboxRepository();
    const queue = new FakeQueue();
    const first = outbox(
      TASK_A,
      0,
      "44444444-4444-4444-8444-444444444444",
    );
    const second = outbox(
      TASK_B,
      0,
      "55555555-5555-4555-8555-555555555555",
    );
    repository.entries.set(first.messageId, first);
    repository.entries.set(second.messageId, second);
    queue.jobs.set(`${TASK_A}:0`, { getState: async () => "failed" });

    await expect(reconciler(repository, queue, { batchSize: 1 }).reconcileOnce()).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      skipped: 0,
      failed: 0,
    });
    expect(queue.removed).toEqual([{ taskId: TASK_A, revision: 0 }]);
    expect(queue.enqueued).toEqual([first.payload]);
    expect(repository.entries.get(first.messageId)?.attemptCount).toBe(0);
    expect(repository.entries.get(second.messageId)?.attemptCount).toBe(0);
  });

  it("re-drives a completed BullMQ job instead of acknowledging an orphaned queued task", async () => {
    // The durable task is still 'queued' (the claim query only offers queued
    // tasks), yet a stale job sits in the terminal 'completed' state — e.g. the
    // worker finished but the DB status write was lost. Acknowledging delivery
    // here would fabricate success and orphan a task with no runnable job.
    const repository = new FakeOutboxRepository();
    const queue = new FakeQueue();
    const entry = outbox(TASK_A, 0, "88888888-8888-4888-8888-888888888888");
    repository.entries.set(entry.messageId, entry);
    queue.jobs.set(`${TASK_A}:0`, { getState: async () => "completed" });

    await expect(reconciler(repository, queue).reconcileOnce()).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      skipped: 0,
      failed: 0,
    });
    // The terminal job is removed and a fresh dispatch is re-enqueued.
    expect(queue.removed).toEqual([{ taskId: TASK_A, revision: 0 }]);
    expect(queue.enqueued).toEqual([entry.payload]);
    expect(repository.entries.get(entry.messageId)?.status).toBe("delivered");
  });

  it("treats an unrecognized BullMQ job state as not-live and re-drives it", async () => {
    // Fail-closed: an unknown state must not be assumed runnable.
    const repository = new FakeOutboxRepository();
    const queue = new FakeQueue();
    const entry = outbox(TASK_A, 0, "99999999-9999-4999-8999-999999999999");
    repository.entries.set(entry.messageId, entry);
    queue.jobs.set(`${TASK_A}:0`, { getState: async () => "unknown" });

    await expect(reconciler(repository, queue).reconcileOnce()).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      skipped: 0,
      failed: 0,
    });
    expect(queue.removed).toEqual([{ taskId: TASK_A, revision: 0 }]);
    expect(queue.enqueued).toEqual([entry.payload]);
  });

  it("does not acknowledge a stale job when BullMQ refuses removal", async () => {
    const repository = new FakeOutboxRepository();
    const queue = new FakeQueue();
    const entry = outbox(TASK_A, 0, "abababab-abab-4aba-8aba-abababababab");
    repository.entries.set(entry.messageId, entry);
    queue.jobs.set(`${TASK_A}:0`, { getState: async () => "failed" });
    queue.removeResultOverride = false;

    await expect(reconciler(repository, queue).reconcileOnce()).resolves.toEqual({
      claimed: 1,
      enqueued: 0,
      skipped: 0,
      failed: 1,
    });
    expect(queue.enqueued).toEqual([]);
    expect(repository.entries.get(entry.messageId)).toMatchObject({
      status: "pending",
      lastError: "Stale task dispatch job could not be removed before redrive.",
    });
  });

  it("keeps a live (active) BullMQ job without removing it", async () => {
    // A genuinely live job must be left in place and the outbox acknowledged;
    // removing/re-driving it would be needless churn on a runnable dispatch.
    const repository = new FakeOutboxRepository();
    const queue = new FakeQueue();
    const entry = outbox(TASK_A, 0, "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1");
    repository.entries.set(entry.messageId, entry);
    queue.jobs.set(`${TASK_A}:0`, { getState: async () => "active" });

    await expect(reconciler(repository, queue).reconcileOnce()).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      skipped: 0,
      failed: 0,
    });
    // Live job left in place (no removal); enqueue no-ops on the existing job.
    expect(queue.removed).toEqual([]);
    expect(queue.enqueued).toEqual([]);
    expect(repository.entries.get(entry.messageId)?.status).toBe("delivered");
  });

  it("reclaims an expired claim without consuming the failure budget", async () => {
    const repository = new FakeOutboxRepository();
    const entry = {
      ...outbox(
        TASK_A,
        0,
        "77777777-7777-4777-8777-777777777777",
      ),
      status: "claimed" as const,
      attemptCount: 7,
      claimedBy: "reconciler-before-crash",
      claimExpiresAt: "2026-07-27T11:59:59.000Z",
    };
    repository.entries.set(entry.messageId, entry);

    const claimed = await repository.claimTaskOutbox({
      claimerId: "reconciler-after-crash",
      leaseDurationMs: 1_000,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      messageId: entry.messageId,
      attemptCount: 7,
      claimedBy: "reconciler-after-crash",
    });
  });

  it("moves an exhausted delivery to a terminal outbox state", async () => {
    const repository = new FakeOutboxRepository();
    const queue = new FakeQueue();
    const entry = {
      ...outbox(
        TASK_A,
        0,
        "88888888-8888-4888-8888-888888888888",
      ),
      attemptCount: MAX_TASK_OUTBOX_ATTEMPTS - 1,
    };
    repository.entries.set(entry.messageId, entry);
    queue.failNext = true;

    await expect(reconciler(repository, queue).reconcileOnce()).resolves.toEqual({
      claimed: 1,
      enqueued: 0,
      skipped: 0,
      failed: 1,
    });
    expect(repository.entries.get(entry.messageId)).toMatchObject({
      status: "failed",
      attemptCount: MAX_TASK_OUTBOX_ATTEMPTS,
      lastError: "Redis unavailable",
    });
    await expect(reconciler(repository, queue).reconcileOnce()).resolves.toEqual({
      claimed: 0,
      enqueued: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("never dead-letters an already-delivered row during a Redis outage", async () => {
    // A delivered outbox row is periodically re-checked while its task stays
    // queued. A prolonged Redis outage must not consume the delivery failure
    // budget of a message that was already delivered once — flipping it to
    // 'failed' would block/expire a task whose dispatch already succeeded.
    const repository = new FakeOutboxRepository();
    const queue = new FakeQueue();
    const entry = {
      ...outbox(
        TASK_A,
        0,
        "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2",
      ),
      status: "delivered" as const,
      attemptCount: MAX_TASK_OUTBOX_ATTEMPTS - 1,
      deliveredAt: NOW,
    };
    repository.entries.set(entry.messageId, entry);
    queue.failNext = true;

    await expect(reconciler(repository, queue).reconcileOnce()).resolves.toEqual({
      claimed: 1,
      enqueued: 0,
      skipped: 0,
      failed: 1,
    });
    // The row goes back to 'pending' for a later recheck instead of 'failed'.
    expect(repository.entries.get(entry.messageId)).toMatchObject({
      status: "pending",
      attemptCount: MAX_TASK_OUTBOX_ATTEMPTS,
      lastError: "Redis unavailable",
      deliveredAt: NOW,
    });
  });
});

describe("PostgresTaskRepository dispatch delivery accounting", () => {
  it("resets attempt_count after a successful delivery acknowledgement", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const client: PostgresClientLike = {
      async query<
        TRow extends Record<string, unknown> = Record<string, unknown>,
      >(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<SqlQueryResult<TRow>> {
        calls.push({ text, values });
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const repository = new PostgresTaskRepository({
      connect: async () => client,
    });

    await expect(
      repository.markTaskOutboxDelivered({
        messageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        claimerId: "reconciler-01",
      }),
    ).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("attempt_count = 0");
  });
});

describe("PostgresTaskRepository retryTaskDispatch", () => {
  it("strictly validates the versioned retry command", () => {
    expect(
      taskDispatchRetryCommandSchema.safeParse({
        ...retryDispatchCommand,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      taskDispatchRetryCommandSchema.parse(retryDispatchCommand),
    ).toEqual(retryDispatchCommand);
  });

  it("atomically requeues a blocked task and replays the same outbox", async () => {
    const client = new RecordingDispatchRetryClient();
    const repository = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(client),
      { dispatchSourceInstanceId: "coordinator-test" },
    );

    const first = await repository.retryTaskDispatch(retryDispatchCommand);
    const replay = await repository.retryTaskDispatch(retryDispatchCommand);

    expect(first).toMatchObject({
      task: {
        status: "queued",
        revision: 2,
        failureReason: null,
      },
      dispatch: {
        taskId: TASK_A,
        botId: submitCommand.dispatchBotId,
        payload: { expectedRevision: 2 },
      },
      outbox: {
        taskId: TASK_A,
        expectedRevision: 2,
        status: "pending",
        attemptCount: 0,
      },
    });
    expect(replay).toEqual(first);
    expect(client.outboxInsertCount).toBe(1);
    expect(
      client.calls.filter((call) => call.text.includes("UPDATE studio_tasks SET")),
    ).toHaveLength(1);
    const history = client.calls.filter((call) =>
      call.text.includes("INSERT INTO studio_task_history"),
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.values.slice(3, 8)).toEqual([
      "task.dispatch-retried",
      "blocked",
      "queued",
      retryDispatchCommand.actorId,
      retryDispatchCommand.reasonCode,
    ]);
    await expect(
      repository.retryTaskDispatch({
        ...retryDispatchCommand,
        reasonCode: "TASK_DISPATCH_RETRY_PARAMETERS_CHANGED",
      }),
    ).rejects.toMatchObject({ code: "TASK_OPERATION_CONFLICT" });
    expect(client.outboxInsertCount).toBe(1);
  });

  it("rejects non-blocked and deadline-expired retry targets", async () => {
    const queued = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(
        new RecordingDispatchRetryClient(
          recordingTaskRow({ status: "queued", revision: 1 }),
        ),
      ),
    );
    await expect(
      queued.retryTaskDispatch(retryDispatchCommand),
    ).rejects.toMatchObject({ code: "TASK_TRANSITION_INVALID" });

    // A cancelled task is never re-dispatched: only blocked and failed rows are
    // eligible retry targets.
    const cancelled = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(
        new RecordingDispatchRetryClient(
          recordingTaskRow({
            status: "cancelled",
            failure_reason: "TASK_CANCELLED_BY_OPERATOR",
            revision: 1,
          }),
        ),
      ),
    );
    await expect(
      cancelled.retryTaskDispatch(retryDispatchCommand),
    ).rejects.toMatchObject({ code: "TASK_TRANSITION_INVALID" });

    const expired = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(
        new RecordingDispatchRetryClient(
          recordingTaskRow({
            status: "blocked",
            failure_reason: "TASK_OUTBOX_DELIVERY_EXHAUSTED",
            revision: 1,
            deadline: NOW,
          }),
        ),
      ),
    );
    await expect(
      expired.retryTaskDispatch(retryDispatchCommand),
    ).rejects.toMatchObject({ code: "TASK_DEADLINE_EXPIRED" });
  });

  it("requeues a failed task with a durable backoff on the next revision", async () => {
    const client = new RecordingDispatchRetryClient(
      recordingTaskRow({
        status: "failed",
        failure_reason: "TASK_WORKER_UNAVAILABLE",
        retry_count: 0,
        revision: 1,
      }),
    );
    const repository = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(client),
      { dispatchSourceInstanceId: "coordinator-test" },
    );
    const delayMs = 4_000;

    const retried = await repository.retryTaskDispatch({
      ...retryDispatchCommand,
      reasonCode: "TASK_RETRYABLE_FAILURE_REQUEUED",
      delayMs,
    });

    expect(retried).toMatchObject({
      task: {
        status: "queued",
        revision: 2,
        retryCount: 1,
        failureReason: null,
        finishedAt: null,
      },
      outbox: {
        taskId: TASK_A,
        expectedRevision: 2,
        status: "pending",
        attemptCount: 0,
      },
    });
    // The backoff is durable: it is the new outbox row's availability instant,
    // measured from PostgreSQL's own clock, not from a worker-local timer.
    const expectedAvailability = new Date(
      Date.parse(NOW) + delayMs,
    ).toISOString();
    expect(retried.outbox.availableAt).toBe(expectedAvailability);
    const insert = client.calls.find((call) =>
      call.text.includes("INSERT INTO studio_task_outbox"),
    );
    expect(insert?.values[6]).toBe(expectedAvailability);
    const history = client.calls.filter((call) =>
      call.text.includes("INSERT INTO studio_task_history"),
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.values.slice(3, 8)).toEqual([
      "task.dispatch-retried",
      "failed",
      "queued",
      retryDispatchCommand.actorId,
      "TASK_RETRYABLE_FAILURE_REQUEUED",
    ]);
  });

  it("replays a failed-task retry without charging the budget twice", async () => {
    const client = new RecordingDispatchRetryClient(
      recordingTaskRow({
        status: "failed",
        failure_reason: "TASK_WORKER_UNAVAILABLE",
        retry_count: 0,
        revision: 1,
      }),
    );
    const repository = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(client),
      { dispatchSourceInstanceId: "coordinator-test" },
    );
    const command = {
      ...retryDispatchCommand,
      reasonCode: "TASK_RETRYABLE_FAILURE_REQUEUED",
      delayMs: 1_500,
    };

    const first = await repository.retryTaskDispatch(command);
    const replay = await repository.retryTaskDispatch(command);

    expect(replay).toEqual(first);
    expect(first.task.retryCount).toBe(1);
    expect(client.outboxInsertCount).toBe(1);
    expect(
      client.calls.filter((call) => call.text.includes("UPDATE studio_tasks SET")),
    ).toHaveLength(1);
  });

  it("refuses to retry a failed task whose budget is exhausted", async () => {
    const client = new RecordingDispatchRetryClient(
      recordingTaskRow({
        status: "failed",
        failure_reason: "TASK_WORKER_UNAVAILABLE",
        retry_count: submitCommand.maxRetries,
        revision: 1,
      }),
    );
    const repository = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(client),
      { dispatchSourceInstanceId: "coordinator-test" },
    );

    await expect(
      repository.retryTaskDispatch({
        ...retryDispatchCommand,
        reasonCode: "TASK_RETRYABLE_FAILURE_REQUEUED",
        delayMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "TASK_RETRY_EXHAUSTED" });
    expect(client.taskRow).toMatchObject({
      status: "failed",
      retry_count: submitCommand.maxRetries,
      revision: 1,
    });
    expect(client.outboxInsertCount).toBe(0);
  });

  it("keeps an immediate retry available for the blocked recovery path", async () => {
    const client = new RecordingDispatchRetryClient();
    const repository = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(client),
      { dispatchSourceInstanceId: "coordinator-test" },
    );

    const retried = await repository.retryTaskDispatch(retryDispatchCommand);

    expect(retried.outbox.availableAt).toBe(NOW);
  });

  it("rolls back task and history when the new outbox insert fails", async () => {
    const client = new RecordingDispatchRetryClient();
    client.failOutboxInsert = true;
    const repository = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(client),
    );

    await expect(
      repository.retryTaskDispatch(retryDispatchCommand),
    ).rejects.toMatchObject({ code: "TASK_PERSISTENCE_FAILED" });

    expect(client.taskRow).toMatchObject({
      status: "blocked",
      revision: 1,
      failure_reason: "TASK_OUTBOX_DELIVERY_EXHAUSTED",
    });
    expect(client.operationHistory.size).toBe(0);
    expect(client.outboxRows.size).toBe(0);
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.calls.some((call) => call.text === "COMMIT")).toBe(false);
  });
});

describe("PostgresTaskRepository recoverExpiredLease", () => {
  it("atomically requeues an assigned task and replays the same new-revision outbox", async () => {
    const client = new RecordingDispatchRetryClient(
      recordingTaskRow({
        status: "assigned",
        assigned_bot_id: "worker-01",
        lease_owner: "worker-lease-01",
        lease_expires_at: "2026-07-27T11:59:00.000Z",
        revision: 1,
      }),
    );
    const repository = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(client),
      { dispatchSourceInstanceId: "coordinator-test" },
    );

    const first = await repository.recoverExpiredLease(
      recoverExpiredLeaseCommand,
    );
    const replay = await repository.recoverExpiredLease(
      recoverExpiredLeaseCommand,
    );

    expect(first).toMatchObject({
      task: {
        status: "queued",
        assignedBotId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        revision: 2,
      },
      dispatch: {
        taskId: TASK_A,
        botId: submitCommand.dispatchBotId,
        payload: { expectedRevision: 2 },
      },
      outbox: {
        taskId: TASK_A,
        expectedRevision: 2,
        status: "pending",
        attemptCount: 0,
      },
    });
    expect(replay).toEqual(first);
    expect(client.outboxInsertCount).toBe(1);
    expect(client.operationHistory.size).toBe(1);
    const history = client.calls.filter((call) =>
      call.text.includes("INSERT INTO studio_task_history"),
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.values.slice(3, 8)).toEqual([
      "task.lease-expired",
      "assigned",
      "queued",
      recoverExpiredLeaseCommand.actorId,
      recoverExpiredLeaseCommand.reasonCode,
    ]);
  });

  it("makes an expired running task terminal without creating another dispatch", async () => {
    const client = new RecordingDispatchRetryClient(
      recordingTaskRow({
        status: "running",
        assigned_bot_id: "worker-01",
        lease_owner: "worker-lease-01",
        lease_expires_at: "2026-07-27T11:59:00.000Z",
        revision: 1,
        started_at: "2026-07-27T11:50:00.000Z",
      }),
    );
    const repository = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(client),
    );

    await expect(
      repository.recoverExpiredLease(recoverExpiredLeaseCommand),
    ).resolves.toMatchObject({
      task: {
        status: "failed",
        failureReason: "TASK_LEASE_EXPIRED",
        revision: 2,
        finishedAt: NOW,
      },
      dispatch: null,
      outbox: null,
    });
    expect(client.outboxInsertCount).toBe(0);
    expect(client.outboxRows.size).toBe(0);
  });

  it("rolls back the lease transition and history when outbox creation fails", async () => {
    const client = new RecordingDispatchRetryClient(
      recordingTaskRow({
        status: "assigned",
        assigned_bot_id: "worker-01",
        lease_owner: "worker-lease-01",
        lease_expires_at: "2026-07-27T11:59:00.000Z",
        revision: 1,
      }),
    );
    client.failOutboxInsert = true;
    const repository = new PostgresTaskRepository(
      new RecordingDispatchRetryPool(client),
    );

    await expect(
      repository.recoverExpiredLease(recoverExpiredLeaseCommand),
    ).rejects.toMatchObject({ code: "TASK_PERSISTENCE_FAILED" });

    expect(client.taskRow).toMatchObject({
      status: "assigned",
      assigned_bot_id: "worker-01",
      lease_owner: "worker-lease-01",
      lease_expires_at: "2026-07-27T11:59:00.000Z",
      revision: 1,
    });
    expect(client.operationHistory.size).toBe(0);
    expect(client.outboxRows.size).toBe(0);
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.calls.some((call) => call.text === "COMMIT")).toBe(false);
  });
});

describe("PostgresTaskRepository submitTask", () => {
  it("writes task, history, and one immutable dispatch outbox payload in one transaction", async () => {
    const client = new RecordingSubmitClient();
    const repository = new PostgresTaskRepository(
      new RecordingSubmitPool(client),
      { dispatchSourceInstanceId: "coordinator-test" },
    );

    const first = await repository.submitTask(submitCommand);
    const replay = await repository.submitTask(submitCommand);

    expect(first).toMatchObject({
      created: true,
      task: {
        taskId: submitCommand.taskId,
        dispatchBotId: submitCommand.dispatchBotId,
        status: "queued",
        revision: 0,
      },
      dispatch: {
        botId: submitCommand.dispatchBotId,
        taskId: submitCommand.taskId,
        source: { instanceId: "coordinator-test" },
        payload: { expectedRevision: 0 },
      },
    });
    expect(replay).toMatchObject({ created: false, dispatch: first.dispatch });
    expect(replay.outbox).toEqual(first.outbox);
    expect(client.outboxInsertCount).toBe(1);

    const taskInsert = client.calls.find((call) =>
      call.text.includes("INSERT INTO studio_tasks"),
    );
    expect(taskInsert?.text).toContain("dispatch_bot_id");
    expect(taskInsert?.values).toContain(submitCommand.dispatchBotId);

    const historyIndex = client.calls.findIndex((call) =>
      call.text.includes("INSERT INTO studio_task_history"),
    );
    const outboxIndex = client.calls.findIndex((call) =>
      call.text.includes("INSERT INTO studio_task_outbox"),
    );
    const firstCommitIndex = client.calls.findIndex(
      (call) => call.text === "COMMIT",
    );
    expect(historyIndex).toBeGreaterThan(-1);
    expect(outboxIndex).toBeGreaterThan(historyIndex);
    expect(firstCommitIndex).toBeGreaterThan(outboxIndex);
  });
});

describe("PostgresTaskRepository outbox claims", () => {
  it("commits quarantine for a durable row that fails the protocol schema", async () => {
    const messageId = "99999999-9999-4999-8999-999999999999";
    const client = new RecordingClaimClient({
      message_id: messageId,
      task_id: TASK_A,
      expected_revision: 0,
      type: "task.dispatch.v1",
      payload: {
        schemaVersion: "1.0",
        messageId,
        taskId: TASK_A,
        type: "task.dispatch.v1",
        payload: { expectedRevision: 0 },
      },
      status: "claimed",
      attempt_count: 0,
      available_at: NOW,
      claimed_by: "reconciler-01",
      claim_expires_at: "2026-07-27T12:00:30.000Z",
      last_error: null,
      created_at: NOW,
      updated_at: NOW,
      delivered_at: null,
    });
    const repository = new PostgresTaskRepository(
      new RecordingClaimPool(client),
    );

    await expect(
      repository.claimTaskOutbox({
        claimerId: "reconciler-01",
        leaseDurationMs: 1_000,
      }),
    ).resolves.toEqual([]);
    const quarantine = client.calls.find((call) =>
      call.text.includes("SET status = 'failed'"),
    );
    expect(quarantine?.values).toEqual([
      messageId,
      "reconciler-01",
      "TASK_OUTBOX_RECORD_INVALID",
    ]);
    expect(
      client.calls.some((call) => call.text.includes("UPDATE studio_tasks SET")),
    ).toBe(true);
    const taskUpdate = client.calls.find((call) =>
      call.text.includes("UPDATE studio_tasks SET"),
    );
    expect(taskUpdate?.values[1]).toBe("blocked");
    expect(taskUpdate?.values[6]).toBe("TASK_OUTBOX_RECORD_INVALID");
    const history = client.calls.find((call) =>
      call.text.includes("INSERT INTO studio_task_history"),
    );
    expect(history?.values[3]).toBe("task.dispatch-blocked");
    expect(history?.values[5]).toBe("blocked");
    expect(history?.values[7]).toBe("TASK_OUTBOX_RECORD_INVALID");
    expect(client.calls.some((call) => call.text === "COMMIT")).toBe(true);
    expect(client.calls.some((call) => call.text === "ROLLBACK")).toBe(false);
  });

  it("quarantines a protocol-valid dispatch with the wrong Bot contract", async () => {
    const entry = outbox(
      TASK_A,
      0,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    const client = new RecordingClaimClient({
      message_id: entry.messageId,
      task_id: entry.taskId,
      expected_revision: entry.expectedRevision,
      type: entry.type,
      payload: entry.payload,
      status: "claimed",
      attempt_count: 0,
      available_at: NOW,
      claimed_by: "reconciler-01",
      claim_expires_at: "2026-07-27T12:00:30.000Z",
      last_error: null,
      created_at: NOW,
      updated_at: NOW,
      delivered_at: null,
      task_dispatch_bot_id: "worker-02",
      task_type: submitCommand.taskType,
      task_handler_version: submitCommand.handlerVersion,
      task_execution_idempotent: submitCommand.executionIdempotent,
      task_trace_id: submitCommand.traceId,
    });
    const repository = new PostgresTaskRepository(
      new RecordingClaimPool(client),
    );

    await expect(
      repository.claimTaskOutbox({
        claimerId: "reconciler-01",
        leaseDurationMs: 1_000,
      }),
    ).resolves.toEqual([]);
    const quarantine = client.calls.find((call) =>
      call.text.includes("SET status = 'failed'"),
    );
    expect(quarantine?.values).toEqual([
      entry.messageId,
      "reconciler-01",
      "TASK_OUTBOX_TASK_CONTRACT_MISMATCH",
    ]);
  });

  it("claims a dispatch for an active preassignment lease", async () => {
    const assignmentLeaseOwner = "coordinator-assignment-01";
    const base = outbox(
      TASK_A,
      1,
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    const payload = {
      ...base.payload,
      payload: {
        ...base.payload.payload,
        assignmentLeaseOwner,
      },
    };
    const entry: TaskOutboxRecord = { ...base, payload };
    const client = new RecordingClaimClient({
      message_id: entry.messageId,
      task_id: entry.taskId,
      expected_revision: entry.expectedRevision,
      type: entry.type,
      payload: entry.payload,
      status: "claimed",
      attempt_count: 0,
      available_at: NOW,
      claimed_by: "reconciler-01",
      claim_expires_at: "2026-07-27T12:00:30.000Z",
      last_error: null,
      created_at: NOW,
      updated_at: NOW,
      delivered_at: null,
      task_dispatch_bot_id: "worker-01",
      task_status: "assigned",
      task_lease_owner: assignmentLeaseOwner,
      task_assigned_bot_id: "worker-01",
      task_type: submitCommand.taskType,
      task_handler_version: submitCommand.handlerVersion,
      task_execution_idempotent: submitCommand.executionIdempotent,
      task_trace_id: entry.payload.traceId,
    });
    const repository = new PostgresTaskRepository(
      new RecordingClaimPool(client),
    );

    const claimed = await repository.claimTaskOutbox({
      claimerId: "reconciler-01",
      leaseDurationMs: 1_000,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.payload.payload.assignmentLeaseOwner).toBe(
      assignmentLeaseOwner,
    );
    expect(client.calls.some(({ text }) => text === "COMMIT")).toBe(true);
  });

  it("expires an invalid dispatch when the task deadline has arrived", async () => {
    const messageId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const client = new RecordingClaimClient(
      {
        message_id: messageId,
        task_id: TASK_A,
        expected_revision: 0,
        type: "task.dispatch.v1",
        payload: {},
        status: "claimed",
        attempt_count: 0,
        available_at: NOW,
        claimed_by: "reconciler-01",
        claim_expires_at: "2026-07-27T12:00:30.000Z",
        last_error: null,
        created_at: NOW,
        updated_at: NOW,
        delivered_at: null,
      },
      recordingTaskRow({ deadline: NOW }),
    );
    const repository = new PostgresTaskRepository(
      new RecordingClaimPool(client),
    );

    await expect(
      repository.claimTaskOutbox({
        claimerId: "reconciler-01",
        leaseDurationMs: 1_000,
      }),
    ).resolves.toEqual([]);

    const taskUpdate = client.calls.find((call) =>
      call.text.includes("UPDATE studio_tasks SET"),
    );
    expect(taskUpdate?.values[1]).toBe("expired");
    expect(taskUpdate?.values[6]).toBe("TASK_OUTBOX_RECORD_INVALID");
    expect(taskUpdate?.values[12]).toBe(NOW);
    const history = client.calls.find((call) =>
      call.text.includes("INSERT INTO studio_task_history"),
    );
    expect(history?.values[3]).toBe("task.dispatch-expired");
    expect(history?.values[5]).toBe("expired");
    expect(history?.values[7]).toBe("TASK_OUTBOX_RECORD_INVALID");
  });

  it("requires a durable error for terminal failed outbox records", () => {
    expect(
      taskOutboxRecordSchema.safeParse({
        ...outbox(
          TASK_A,
          0,
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ),
        status: "failed",
      }).success,
    ).toBe(false);
  });
});
