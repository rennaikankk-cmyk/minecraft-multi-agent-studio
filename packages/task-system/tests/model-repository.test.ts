import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_EXPIRED_LEASE_BATCH_SIZE,
  MAX_TASK_HISTORY_BATCH_SIZE,
  MAX_TASK_LIFECYCLE_BATCH_SIZE,
  PostgresTaskRepository,
  taskCreateCommandSchema,
  taskOperationFingerprint,
  taskRecordSchema,
  type PostgresClientLike,
  type PostgresPoolLike,
  type SqlQueryResult,
  type TaskRecord,
} from "../src/index.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const command = {
  schemaVersion: "1.0" as const,
  operationId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  idempotencyScope: "coordinator-main",
  idempotencyKey: "collect-stone-001",
  taskType: "resource.collect",
  handlerVersion: "1.0.0",
  executionIdempotent: true,
  title: "Collect stone",
  description: "Collect stone in the isolated test world.",
  priority: 50,
  requiredSkills: [{ skillId: "movement.goto", skillVersion: "1.0.0" }],
  requiredItems: [],
  target: {
    x: 10,
    y: 64,
    z: 10,
    dimension: "minecraft:overworld",
    serverProfileId: "isolated-local",
  },
  dependencyIds: [],
  parentTaskId: null,
  deadline: "2026-07-27T13:00:00.000Z",
  timeoutMs: 60_000,
  maxRetries: 2,
  riskLevel: "R1" as const,
  traceId: "trace-task-001",
  actorId: "coordinator-agent",
};

class RecordingClient implements PostgresClientLike {
  readonly statements: string[] = [];
  readonly calls: Array<{
    text: string;
    values: readonly unknown[];
  }> = [];
  released = false;

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<TRow>> {
    this.statements.push(text);
    this.calls.push({ text, values });
    if (text.includes("clock_timestamp() AS database_now")) {
      return {
        rows: [{ database_now: NOW } as unknown as TRow],
        rowCount: 1,
      };
    }
    if (text.includes("FROM studio_task_history")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("INSERT INTO studio_tasks")) {
      return {
        rows: [{ task_id: command.taskId } as unknown as TRow],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {
    this.released = true;
  }
}

class RecordingPool implements PostgresPoolLike {
  constructor(readonly client: RecordingClient) {}
  async connect(): Promise<PostgresClientLike> {
    return this.client;
  }
}

function replayTask(): TaskRecord {
  return taskRecordSchema.parse({
    schemaVersion: "1.0",
    taskId: command.taskId,
    idempotencyScope: command.idempotencyScope,
    idempotencyKey: command.idempotencyKey,
    requestFingerprint: "a".repeat(64),
    taskType: command.taskType,
    handlerVersion: command.handlerVersion,
    executionIdempotent: command.executionIdempotent,
    title: command.title,
    description: command.description,
    priority: command.priority,
    status: "queued",
    assignedBotId: null,
    requiredSkills: command.requiredSkills,
    requiredItems: [],
    target: command.target,
    dependencyIds: [],
    parentTaskId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
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

function taskRow(task: TaskRecord): Record<string, unknown> {
  return {
    schema_version: task.schemaVersion,
    task_id: task.taskId,
    idempotency_scope: task.idempotencyScope,
    idempotency_key: task.idempotencyKey,
    request_fingerprint: task.requestFingerprint,
    task_type: task.taskType,
    handler_version: task.handlerVersion,
    execution_idempotent: task.executionIdempotent,
    title: task.title,
    description: task.description,
    task_input: task.input ?? null,
    priority: task.priority,
    status: task.status,
    dispatch_bot_id: task.dispatchBotId,
    assigned_bot_id: task.assignedBotId,
    required_skills: task.requiredSkills,
    required_items: task.requiredItems,
    target: task.target,
    parent_task_id: task.parentTaskId,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    started_at: task.startedAt,
    finished_at: task.finishedAt,
    deadline: task.deadline,
    timeout_ms: task.timeoutMs,
    retry_count: task.retryCount,
    max_retries: task.maxRetries,
    lease_owner: task.leaseOwner,
    lease_expires_at: task.leaseExpiresAt,
    risk_level: task.riskLevel,
    failure_reason: task.failureReason,
    result: task.result,
    evidence: task.evidence,
    trace_id: task.traceId,
    revision: task.revision,
  };
}

describe("task model and PostgreSQL boundary", () => {
  it("strictly rejects unknown fields and self dependencies", () => {
    expect(() =>
      taskCreateCommandSchema.parse({ ...command, unexpected: true }),
    ).toThrow();
    expect(() =>
      taskCreateCommandSchema.parse({
        ...command,
        dependencyIds: [command.taskId],
      }),
    ).toThrow();
  });

  it("normalizes accepted task deadlines to canonical UTC", () => {
    expect(
      taskCreateCommandSchema.parse({
        ...command,
        deadline: "2026-07-27T21:00:00.000+08:00",
      }).deadline,
    ).toBe("2026-07-27T13:00:00.000Z");
  });

  it("accepts bounded structured task input and rejects null or oversized input", () => {
    expect(
      taskCreateCommandSchema.parse({
        ...command,
        input: { kind: "coordinator.goal.v1", operatorGoal: "Collect wood" },
      }).input,
    ).toEqual({
      kind: "coordinator.goal.v1",
      operatorGoal: "Collect wood",
    });
    expect(() =>
      taskCreateCommandSchema.parse({ ...command, input: null }),
    ).toThrow();
    expect(() =>
      taskCreateCommandSchema.parse({
        ...command,
        input: { payload: "x".repeat(33 * 1_024) },
      }),
    ).toThrow();
  });

  it("uses a deterministic canonical operation fingerprint", () => {
    expect(taskOperationFingerprint({ b: 2, a: { d: 4, c: 3 } })).toBe(
      taskOperationFingerprint({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(taskOperationFingerprint({ value: 1 })).not.toBe(
      taskOperationFingerprint({ value: 2 }),
    );
    expect(
      taskOperationFingerprint({ ...command, input: { operatorGoal: "A" } }),
    ).not.toBe(
      taskOperationFingerprint({ ...command, input: { operatorGoal: "B" } }),
    );
  });

  it("canonicalizes set-like create arrays before fingerprinting and storage", async () => {
    const dependencyA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const dependencyB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = {
      ...command,
      requiredSkills: [
        { skillId: "movement.goto", skillVersion: "2.0.0" },
        { skillId: "movement.goto", skillVersion: "1.0.0" },
      ],
      requiredItems: [
        { itemName: "minecraft:stone", count: 16 },
        { itemName: "minecraft:coal", count: 8 },
      ],
      dependencyIds: [dependencyB, dependencyA],
    };
    const second = {
      ...first,
      requiredSkills: [...first.requiredSkills].reverse(),
      requiredItems: [...first.requiredItems].reverse(),
      dependencyIds: [...first.dependencyIds].reverse(),
    };

    expect(taskOperationFingerprint(first)).toBe(
      taskOperationFingerprint(second),
    );
    const firstResult = await new PostgresTaskRepository(
      new RecordingPool(new RecordingClient()),
    ).createTask(first);
    const secondResult = await new PostgresTaskRepository(
      new RecordingPool(new RecordingClient()),
    ).createTask(second);

    expect(firstResult.task.requestFingerprint).toBe(
      secondResult.task.requestFingerprint,
    );
    expect(firstResult.task.requiredSkills).toEqual([
      { skillId: "movement.goto", skillVersion: "1.0.0" },
      { skillId: "movement.goto", skillVersion: "2.0.0" },
    ]);
    expect(firstResult.task.requiredItems).toEqual([
      { itemName: "minecraft:coal", count: 8 },
      { itemName: "minecraft:stone", count: 16 },
    ]);
    expect(firstResult.task.dependencyIds).toEqual([
      dependencyA,
      dependencyB,
    ]);
  });

  it("creates one queued task and appends history in one transaction", async () => {
    const client = new RecordingClient();
    const repository = new PostgresTaskRepository(new RecordingPool(client));

    const result = await repository.createTask(command);

    expect(result).toMatchObject({
      created: true,
      task: {
        taskId: command.taskId,
        status: "queued",
        revision: 0,
      },
    });
    expect(client.statements[0]).toBe("BEGIN");
    expect(client.calls.slice(1, 3)).toEqual([
      {
        text: "SET LOCAL lock_timeout = '3000ms'",
        values: [],
      },
      {
        text: "SET LOCAL statement_timeout = '10000ms'",
        values: [],
      },
    ]);
    expect(client.statements[3]).toContain("pg_advisory_xact_lock");
    expect(
      client.statements.some((statement) =>
        statement.includes("clock_timestamp() AS database_now"),
      ),
    ).toBe(true);
    expect(
      client.statements.some((statement) =>
        statement.includes("INSERT INTO studio_task_history"),
      ),
    ).toBe(true);
    expect(client.statements.at(-1)).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("atomically persists a preassignment lease and revisioned dispatch", async () => {
    const assignment = {
      schemaVersion: "1.0" as const,
      operationId: "33333333-3333-4333-8333-333333333333",
      taskId: command.taskId,
      expectedRevision: 0,
      actorId: "coordinator-main",
      botId: "worker-01",
      leaseOwner: "coordinator-assignment-01",
      leaseDurationMs: 5_000,
      serverProfileId: "isolated-local",
      dimension: "minecraft:overworld",
    };
    let taskRowState = taskRow(replayTask());
    let outboxRow: Record<string, unknown> | null = null;
    let history: {
      operationFingerprint: string;
      taskSnapshot: unknown;
    } | null = null;
    const client: PostgresClientLike = {
      async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<SqlQueryResult<TRow>> {
        if (text.includes("FROM studio_task_history")) {
          return {
            rows: history === null
              ? []
              : [{
                  operation_fingerprint: history.operationFingerprint,
                  task_id: command.taskId,
                  task_snapshot: history.taskSnapshot,
                } as unknown as TRow],
            rowCount: history === null ? 0 : 1,
          };
        }
        if (text.includes("SELECT * FROM studio_tasks")) {
          return { rows: [taskRowState as TRow], rowCount: 1 };
        }
        if (text.includes("FROM studio_task_dependencies")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("clock_timestamp() AS database_now")) {
          return { rows: [{ database_now: NOW } as unknown as TRow], rowCount: 1 };
        }
        if (text.includes("UPDATE studio_tasks SET")) {
          taskRowState = {
            ...taskRowState,
            status: values[1],
            dispatch_bot_id: values[2],
            assigned_bot_id: values[3],
            retry_count: values[4],
            lease_owner: values[5],
            lease_expires_at: values[6],
            failure_reason: values[7],
            result: values[8] === null ? null : JSON.parse(String(values[8])),
            evidence: JSON.parse(String(values[9])),
            revision: values[10],
            updated_at: values[11],
            started_at: values[12],
            finished_at: values[13],
          };
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("INSERT INTO studio_task_history")) {
          history = {
            operationFingerprint: String(values[1]),
            taskSnapshot: JSON.parse(String(values[8])),
          };
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("FROM studio_task_outbox")) {
          return {
            rows: outboxRow === null ? [] : [outboxRow as TRow],
            rowCount: outboxRow === null ? 0 : 1,
          };
        }
        if (text.includes("INSERT INTO studio_task_outbox")) {
          const payload = JSON.parse(String(values[4])) as Record<string, unknown>;
          outboxRow = {
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
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const repository = new PostgresTaskRepository({
      connect: async () => client,
    });

    await expect(
      repository.acquireAssignmentLease({
        ...assignment,
        serverProfileId: "different-server",
      }),
    ).rejects.toMatchObject({ code: "TASK_SERVER_CONTEXT_CONFLICT" });

    const first = await repository.acquireAssignmentLease(assignment);
    const replay = await repository.acquireAssignmentLease(assignment);

    expect(first).toMatchObject({
      task: {
        status: "assigned",
        dispatchBotId: "worker-01",
        assignedBotId: "worker-01",
        leaseOwner: "coordinator-assignment-01",
        revision: 1,
      },
      dispatch: {
        botId: "worker-01",
        payload: {
          expectedRevision: 1,
          assignmentLeaseOwner: "coordinator-assignment-01",
        },
      },
      outbox: { taskId: command.taskId, expectedRevision: 1 },
    });
    expect(replay).toEqual(first);
  });

  it("persists a synchronous assignment without creating a queue outbox", async () => {
    const assignment = {
      schemaVersion: "1.0" as const,
      operationId: "44444444-4444-4444-8444-444444444444",
      taskId: command.taskId,
      expectedRevision: 0,
      actorId: "coordinator-main",
      botId: "worker-01",
      leaseOwner: "goal-assignment-01",
      leaseDurationMs: 5_000,
      serverProfileId: "isolated-local",
      dimension: "minecraft:overworld",
    };
    let taskRowState = taskRow(replayTask());
    let history: { operationFingerprint: string; taskSnapshot: unknown } | null = null;
    const statements: string[] = [];
    const client: PostgresClientLike = {
      async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<SqlQueryResult<TRow>> {
        statements.push(text);
        if (text.includes("FROM studio_task_history")) {
          return {
            rows: history === null
              ? []
              : [{
                  operation_fingerprint: history.operationFingerprint,
                  task_id: command.taskId,
                  task_snapshot: history.taskSnapshot,
                } as unknown as TRow],
            rowCount: history === null ? 0 : 1,
          };
        }
        if (text.includes("SELECT * FROM studio_tasks")) {
          return { rows: [taskRowState as TRow], rowCount: 1 };
        }
        if (text.includes("FROM studio_task_dependencies")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("clock_timestamp() AS database_now")) {
          return { rows: [{ database_now: NOW } as unknown as TRow], rowCount: 1 };
        }
        if (text.includes("UPDATE studio_tasks SET")) {
          taskRowState = {
            ...taskRowState,
            status: values[1],
            dispatch_bot_id: values[2],
            assigned_bot_id: values[3],
            retry_count: values[4],
            lease_owner: values[5],
            lease_expires_at: values[6],
            failure_reason: values[7],
            result: values[8] === null ? null : JSON.parse(String(values[8])),
            evidence: JSON.parse(String(values[9])),
            revision: values[10],
            updated_at: values[11],
            started_at: values[12],
            finished_at: values[13],
          };
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("INSERT INTO studio_task_history")) {
          history = {
            operationFingerprint: String(values[1]),
            taskSnapshot: JSON.parse(String(values[8])),
          };
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const repository = new PostgresTaskRepository({
      connect: async () => client,
    });

    const first = await repository.acquireSynchronousAssignment(assignment);
    const replay = await repository.acquireSynchronousAssignment(assignment);

    expect(first).toMatchObject({
      status: "assigned",
      dispatchBotId: "worker-01",
      assignedBotId: "worker-01",
      leaseOwner: "goal-assignment-01",
      revision: 1,
    });
    expect(replay).toEqual(first);
    expect(statements.some((text) => text.includes("INSERT INTO studio_task_outbox"))).toBe(false);
  });

  it("rejects synchronous assignment when a durable dispatch target already exists", async () => {
    const assignment = {
      schemaVersion: "1.0" as const,
      operationId: "55555555-5555-4555-8555-555555555555",
      taskId: command.taskId,
      expectedRevision: 0,
      actorId: "coordinator-main",
      botId: "worker-02",
      leaseOwner: "goal-assignment-02",
      leaseDurationMs: 5_000,
      serverProfileId: "isolated-local",
      dimension: "minecraft:overworld",
    };
    const submitted = taskRow({
      ...replayTask(),
      dispatchBotId: "worker-01",
    });
    const client: PostgresClientLike = {
      async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
      ): Promise<SqlQueryResult<TRow>> {
        if (text.includes("FROM studio_task_history")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("SELECT * FROM studio_tasks")) {
          return { rows: [submitted as TRow], rowCount: 1 };
        }
        if (text.includes("FROM studio_task_dependencies")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("clock_timestamp() AS database_now")) {
          return { rows: [{ database_now: NOW } as unknown as TRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const repository = new PostgresTaskRepository({
      connect: async () => client,
    });

    await expect(repository.acquireSynchronousAssignment(assignment)).rejects.toMatchObject({
      code: "TASK_OPERATION_CONFLICT",
    });
  });

  it("rejects synchronous assignment when the same-revision outbox survives without a target", async () => {
    const assignment = {
      schemaVersion: "1.0" as const,
      operationId: "66666666-6666-4666-8666-666666666666",
      taskId: command.taskId,
      expectedRevision: 0,
      actorId: "coordinator-main",
      botId: "worker-02",
      leaseOwner: "goal-assignment-03",
      leaseDurationMs: 5_000,
      serverProfileId: "isolated-local",
      dimension: "minecraft:overworld",
    };
    const task = taskRow(replayTask());
    const client: PostgresClientLike = {
      async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
      ): Promise<SqlQueryResult<TRow>> {
        if (text.includes("FROM studio_task_history")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("SELECT * FROM studio_tasks")) {
          return { rows: [task as TRow], rowCount: 1 };
        }
        if (text.includes("FROM studio_task_dependencies")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("clock_timestamp() AS database_now")) {
          return { rows: [{ database_now: NOW } as unknown as TRow], rowCount: 1 };
        }
        if (
          text.includes("FROM studio_task_outbox") &&
          text.includes("expected_revision = $2")
        ) {
          return { rows: [{ marker: true } as TRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const repository = new PostgresTaskRepository({
      connect: async () => client,
    });

    await expect(repository.acquireSynchronousAssignment(assignment)).rejects.toMatchObject({
      code: "TASK_OPERATION_CONFLICT",
    });
  });

  it("checks the exact active durable assignment lease at the PostgreSQL boundary", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const client: PostgresClientLike = {
      async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<SqlQueryResult<TRow>> {
        calls.push({ text, values });
        if (text.includes("FROM studio_tasks")) {
          return { rows: [{ active: 1 } as TRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const repository = new PostgresTaskRepository({
      connect: async () => client,
    });

    await expect(
      repository.isTaskAssignmentLeaseActive({
        taskId: command.taskId,
        botId: "worker-01",
        leaseOwner: "goal-assignment-01",
      }),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      values: [command.taskId, "worker-01", "goal-assignment-01"],
    });
    expect(calls[0]?.text).toContain("dispatch_bot_id = $2");
    expect(calls[0]?.text).toContain("status IN ('assigned', 'running')");
    expect(calls[0]?.text).toContain("lease_expires_at > clock_timestamp()");
  });

  it("stores structured task input in the task row", async () => {
    const client = new RecordingClient();
    const repository = new PostgresTaskRepository(new RecordingPool(client));
    const input = {
      kind: "coordinator.goal.v1",
      botId: "worker-01",
      operatorGoal: "Collect wood",
    };

    const result = await repository.createTask({ ...command, input });

    expect(result.task.input).toEqual(input);
    const insert = client.calls.find(({ text }) =>
      text.includes("INSERT INTO studio_tasks"),
    );
    expect(insert?.text).toContain("task_input");
    expect(insert?.values[9]).toBe(JSON.stringify(input));
  });

  it("returns the persisted snapshot for an exact operation replay", async () => {
    const snapshot = replayTask();
    const fingerprint = taskOperationFingerprint(command);
    const client: PostgresClientLike = {
      async query<
        TRow extends Record<string, unknown> = Record<string, unknown>,
      >(text: string): Promise<SqlQueryResult<TRow>> {
        if (text.includes("FROM studio_task_history")) {
          return {
            rows: [
              {
                operation_fingerprint: fingerprint,
                task_id: command.taskId,
                task_snapshot: snapshot,
              } as unknown as TRow,
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const repository = new PostgresTaskRepository({
      connect: async () => client,
    });

    await expect(repository.createTask(command)).resolves.toEqual({
      task: snapshot,
      created: false,
    });
  });

  it("returns an exact operation replay before checking an expired deadline", async () => {
    const expiredCommand = {
      ...command,
      deadline: "2026-07-27T11:00:00.000Z",
    };
    const snapshot = taskRecordSchema.parse({
      ...replayTask(),
      deadline: expiredCommand.deadline,
    });
    const fingerprint = taskOperationFingerprint(expiredCommand);
    const client: PostgresClientLike = {
      async query<
        TRow extends Record<string, unknown> = Record<string, unknown>,
      >(text: string): Promise<SqlQueryResult<TRow>> {
        if (text.includes("FROM studio_task_history")) {
          return {
            rows: [
              {
                operation_fingerprint: fingerprint,
                task_id: expiredCommand.taskId,
                task_snapshot: snapshot,
              } as unknown as TRow,
            ],
            rowCount: 1,
          };
        }
        if (text.includes("clock_timestamp()")) {
          throw new Error("Database time must not be read for a replay.");
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };

    await expect(
      new PostgresTaskRepository({
        connect: async () => client,
      }).createTask(expiredCommand),
    ).resolves.toEqual({ task: snapshot, created: false });
  });

  it("serializes mutations by operation ID and uses PostgreSQL time", async () => {
    const current = replayTask();
    const databaseNow = new Date("2026-07-27T12:00:05.000Z");
    const statements: string[] = [];
    const client: PostgresClientLike = {
      async query<
        TRow extends Record<string, unknown> = Record<string, unknown>,
      >(text: string): Promise<SqlQueryResult<TRow>> {
        statements.push(text);
        if (text.includes("FROM studio_task_history")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("SELECT * FROM studio_tasks")) {
          return {
            rows: [taskRow(current) as unknown as TRow],
            rowCount: 1,
          };
        }
        if (text.includes("FROM studio_task_dependencies")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("clock_timestamp() AS database_now")) {
          return {
            rows: [{ database_now: databaseNow } as unknown as TRow],
            rowCount: 1,
          };
        }
        if (text.includes("UPDATE studio_tasks SET")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };

    const result = await new PostgresTaskRepository({
      connect: async () => client,
    }).transition({
      schemaVersion: "1.0",
      operationId: "99999999-9999-4999-8999-999999999999",
      taskId: command.taskId,
      expectedRevision: 0,
      actorId: command.actorId,
      to: "cancelled",
      reasonCode: "TASK_CANCELLED",
      leaseOwner: null,
      failureReason: null,
      result: null,
      evidence: [],
    });

    expect(result.updatedAt).toBe(databaseNow.toISOString());
    expect(statements.slice(1, 3)).toEqual([
      "SET LOCAL lock_timeout = '3000ms'",
      "SET LOCAL statement_timeout = '10000ms'",
    ]);
    expect(statements[3]).toContain("pg_advisory_xact_lock");
    expect(
      statements.findIndex((text) => text.includes("pg_advisory_xact_lock")),
    ).toBeLessThan(
      statements.findIndex((text) => text.includes("FROM studio_task_history")),
    );
  });

  it("exposes PostgreSQL time and always releases its client", async () => {
    const client = new RecordingClient();
    const repository = new PostgresTaskRepository(new RecordingPool(client));

    await expect(repository.getDatabaseTime()).resolves.toEqual(NOW);
    expect(client.calls).toEqual([
      {
        text: "SELECT clock_timestamp() AS database_now",
        values: [],
      },
    ]);
    expect(client.released).toBe(true);

    let invalidClientReleased = false;
    const invalidClient: PostgresClientLike = {
      async query<
        TRow extends Record<string, unknown> = Record<string, unknown>,
      >(): Promise<SqlQueryResult<TRow>> {
        return {
          rows: [{ database_now: "not-a-time" } as unknown as TRow],
          rowCount: 1,
        };
      },
      release() {
        invalidClientReleased = true;
      },
    };
    const invalidRepository = new PostgresTaskRepository({
      connect: async () => invalidClient,
    });

    await expect(invalidRepository.getDatabaseTime()).rejects.toMatchObject({
      code: "TASK_PERSISTENCE_FAILED",
    });
    expect(invalidClientReleased).toBe(true);
  });

  it("verifies the durable goal schema and releases its client", async () => {
    let released = false;
    let verificationSql = "";
    const repository = new PostgresTaskRepository({
      connect: async () => ({
        async query<
          TRow extends Record<string, unknown> = Record<string, unknown>,
        >(text: string): Promise<SqlQueryResult<TRow>> {
          verificationSql = text;
          return {
            rows: [{ ready: true } as unknown as TRow],
            rowCount: 1,
          };
        },
        release() {
          released = true;
        },
      }),
    });

    await expect(
      repository.verifyGoalLifecycleSchema(),
    ).resolves.toBeUndefined();
    expect(released).toBe(true);
    expect(verificationSql).toContain("data_type = 'jsonb'");
    expect(verificationSql).toContain("studio_tasks_input_size_check");
    expect(verificationSql).toContain(
      "studio_tasks_type_status_updated_idx",
    );

    const missing = new PostgresTaskRepository({
      connect: async () => ({
        async query<
          TRow extends Record<string, unknown> = Record<string, unknown>,
        >(): Promise<SqlQueryResult<TRow>> {
          return {
            rows: [{ ready: false } as unknown as TRow],
            rowCount: 1,
          };
        },
        release() {},
      }),
    });
    await expect(missing.verifyGoalLifecycleSchema()).rejects.toMatchObject({
      code: "TASK_PERSISTENCE_FAILED",
    });
  });

  it("lists a bounded goal lifecycle projection with task input", async () => {
    const lifecycleTask = taskRecordSchema.parse({
      ...replayTask(),
      taskType: "coordinator.goal",
      input: {
        schemaVersion: "1.0",
        kind: "coordinator.goal.v1",
        operationId: command.operationId,
      },
    });
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const repository = new PostgresTaskRepository({
      connect: async () => ({
        async query<
          TRow extends Record<string, unknown> = Record<string, unknown>,
        >(
          text: string,
          values: readonly unknown[] = [],
        ): Promise<SqlQueryResult<TRow>> {
          calls.push({ text, values });
          if (text.includes("FROM studio_tasks")) {
            return {
              rows: [
                {
                  ...taskRow(lifecycleTask),
                  task_input: lifecycleTask.input,
                } as unknown as TRow,
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      }),
    });
    const lowerBound = "2026-07-27T11:55:00.000Z";

    await expect(
      repository.listTaskLifecycle({
        taskType: "coordinator.goal",
        terminalUpdatedAfter: lowerBound,
        limit: 25,
      }),
    ).resolves.toEqual([lifecycleTask]);
    expect(calls[0]?.values).toEqual([
      "coordinator.goal",
      lowerBound,
      25,
    ]);
    expect(calls[0]?.text).toContain("updated_at >= $2::timestamptz");
    expect(calls[0]?.text).toContain("LIMIT $3");
    await expect(
      repository.listTaskLifecycle({
        taskType: "coordinator.goal",
        terminalUpdatedAfter: "not-a-time",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.listTaskLifecycle({
        taskType: "coordinator.goal",
        terminalUpdatedAfter: lowerBound,
        limit: MAX_TASK_LIFECYCLE_BATCH_SIZE + 1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("lists task history with bounded keyset pagination and bot input lookup", async () => {
    const historyTasks = [
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "09:03:00"],
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "09:02:00"],
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "09:01:00"],
    ].map(([taskId, time], index) =>
      taskRecordSchema.parse({
        ...replayTask(),
        taskId,
        idempotencyKey: `history-task-${index}`,
        taskType: "coordinator.goal",
        input: { botId: "worker-01", sequence: index },
        status: "completed",
        createdAt: `2026-07-27T${time}.000Z`,
        updatedAt: `2026-07-27T${time}.000Z`,
        finishedAt: `2026-07-27T${time}.000Z`,
        deadline: null,
      }),
    );
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    let released = false;
    const repository = new PostgresTaskRepository({
      connect: async () => ({
        async query<
          TRow extends Record<string, unknown> = Record<string, unknown>,
        >(
          text: string,
          values: readonly unknown[] = [],
        ): Promise<SqlQueryResult<TRow>> {
          calls.push({ text, values });
          if (text.includes("SELECT task.*")) {
            return {
              rows: historyTasks.map((task) =>
                taskRow(task) as unknown as TRow,
              ),
              rowCount: historyTasks.length,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {
          released = true;
        },
      }),
    });
    const cursorTaskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    await expect(
      repository.listTaskHistory({
        limit: 2,
        status: "completed",
        botId: "worker-01",
        before: {
          createdAt: "2026-07-27T17:04:00.000+08:00",
          taskId: cursorTaskId,
        },
      }),
    ).resolves.toEqual({
      tasks: historyTasks.slice(0, 2),
      hasMore: true,
    });
    expect(calls[0]?.values).toEqual([
      "completed",
      "worker-01",
      "2026-07-27T09:04:00.000Z",
      cursorTaskId,
      3,
    ]);
    expect(calls[0]?.text).toContain("task.status = $1::text");
    expect(calls[0]?.text).toContain("task.task_input ->> 'botId' = $2::text");
    expect(calls[0]?.text).toContain("(task.created_at, task.task_id) <");
    expect(calls[0]?.text).toContain("LIMIT $5");
    expect(released).toBe(true);

    await expect(
      repository.listTaskHistory({
        limit: MAX_TASK_HISTORY_BATCH_SIZE + 1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("lists only a bounded PostgreSQL-clock expired lease recovery batch", async () => {
    const expired = taskRecordSchema.parse({
      ...replayTask(),
      status: "assigned",
      assignedBotId: "worker-01",
      leaseOwner: "lease-owner-01",
      leaseExpiresAt: "2026-07-27T11:59:59.000Z",
      revision: 1,
    });
    const calls: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const client: PostgresClientLike = {
      async query<
        TRow extends Record<string, unknown> = Record<string, unknown>,
      >(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<SqlQueryResult<TRow>> {
        calls.push({ text, values });
        if (text.includes("lease_expires_at <= clock_timestamp()")) {
          return {
            rows: [taskRow(expired) as unknown as TRow],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const repository = new PostgresTaskRepository({
      connect: async () => client,
    });

    await expect(repository.listExpiredLeases(2)).resolves.toEqual([expired]);
    expect(calls[0]?.values).toEqual([2]);
    expect(calls[0]?.text).toContain("status IN ('assigned', 'running')");
    await expect(repository.listExpiredLeases(0)).rejects.toThrow(RangeError);
    await expect(
      repository.listExpiredLeases(MAX_EXPIRED_LEASE_BATCH_SIZE + 1),
    ).rejects.toThrow(RangeError);
  });

  it("defines uniqueness, optimistic revision, leases and append-only history", () => {
    const migration = readFileSync(
      new URL("../migrations/0001_task_system.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      "UNIQUE (idempotency_scope, idempotency_key)",
    );
    expect(migration).toContain("lease_expires_at TIMESTAMPTZ");
    expect(migration).toContain("revision BIGINT NOT NULL DEFAULT 0");
    expect(migration).toContain("studio_task_history_append_only");
    expect(migration).toContain("studio_tasks_no_delete");

    const hardeningMigration = readFileSync(
      new URL(
        "../migrations/0002_task_lease_invariants.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(hardeningMigration).toContain("WHERE status = 'queued'");
    expect(hardeningMigration).toContain(
      "studio_tasks_status_lease_consistency_check",
    );
    expect(hardeningMigration).toContain(
      "status NOT IN ('assigned', 'running')",
    );

    const goalInputMigration = readFileSync(
      new URL("../migrations/0005_task_goal_input.sql", import.meta.url),
      "utf8",
    );
    expect(goalInputMigration).toContain(
      "ADD COLUMN IF NOT EXISTS task_input JSONB",
    );
    expect(goalInputMigration).toContain("studio_tasks_input_size_check");
    expect(goalInputMigration).toContain("task_input::text) <= 65536");
    expect(goalInputMigration).toContain("studio_tasks_type_status_updated_idx");
    expect(goalInputMigration).toContain("studio_tasks_history_created_idx");
    expect(goalInputMigration).toContain("studio_tasks_goal_bot_idx");
  });
});
