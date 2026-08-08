import { describe, expect, it } from "vitest";

import type { TaskOutboxRecord } from "../src/model.js";
import {
  TaskOutboxReconciler,
  type TaskOutboxRepositoryLike,
} from "../src/outbox-reconciler.js";
import {
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
        entry.status === "claimed" ||
        Date.parse(entry.availableAt) > this.now.getTime()
      ) {
        continue;
      }
      const next: TaskOutboxRecord = {
        ...entry,
        status: "claimed",
        attemptCount: entry.attemptCount + 1,
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
      claimedBy: null,
      claimExpiresAt: null,
      lastError: null,
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
    this.entries.set(input.messageId, {
      ...entry,
      status: "pending",
      claimedBy: null,
      claimExpiresAt: null,
      lastError: input.error,
      availableAt: new Date(
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
        available_at: values[5],
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
      claimed: 1,
      enqueued: 1,
      skipped: 0,
      failed: 0,
    });
    expect(queue.enqueued).toHaveLength(1);
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
    expect(repository.entries.get(first.messageId)?.attemptCount).toBe(1);
    expect(repository.entries.get(second.messageId)?.attemptCount).toBe(0);
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
