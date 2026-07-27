import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_EXPIRED_LEASE_BATCH_SIZE,
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
    priority: task.priority,
    status: task.status,
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

  it("uses a deterministic canonical operation fingerprint", () => {
    expect(taskOperationFingerprint({ b: 2, a: { d: 4, c: 3 } })).toBe(
      taskOperationFingerprint({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(taskOperationFingerprint({ value: 1 })).not.toBe(
      taskOperationFingerprint({ value: 2 }),
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
  });
});
