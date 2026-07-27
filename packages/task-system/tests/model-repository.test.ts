import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
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
  released = false;

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
  ): Promise<SqlQueryResult<TRow>> {
    this.statements.push(text);
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

  it("uses a deterministic canonical operation fingerprint", () => {
    expect(taskOperationFingerprint({ b: 2, a: { d: 4, c: 3 } })).toBe(
      taskOperationFingerprint({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(taskOperationFingerprint({ value: 1 })).not.toBe(
      taskOperationFingerprint({ value: 2 }),
    );
  });

  it("creates one queued task and appends history in one transaction", async () => {
    const client = new RecordingClient();
    const repository = new PostgresTaskRepository(
      new RecordingPool(client),
      () => NOW,
    );

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
    const repository = new PostgresTaskRepository(
      { connect: async () => client },
      () => NOW,
    );

    await expect(repository.createTask(command)).resolves.toEqual({
      task: snapshot,
      created: false,
    });
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
  });
});
