import { describe, expect, it } from "vitest";

import {
  PostgresTaskExecutionStore,
  taskExecutionRecordSchema,
  type TaskExecutionSqlClient,
  type TaskExecutionSqlPool,
} from "../src/index.js";

const record = taskExecutionRecordSchema.parse({
  schemaVersion: "1.0",
  taskId: "11111111-1111-4111-8111-111111111111",
  botId: "bot-01",
  goal: "Acquire wood pickaxe",
  parentTask: null,
  childTasks: [],
  state: "EXECUTE",
  currentStep: "craft planks",
  startTime: "2026-08-28T06:00:00.000Z",
  lastProgressTime: "2026-08-28T06:00:01.000Z",
  updatedAt: "2026-08-28T06:00:01.000Z",
  retryCount: 0,
  recoveryCount: 0,
  maxRecoveryCount: 3,
  planVersion: 1,
  worldStateVersion: 8,
  reservedResources: [{ resourceId: "oak_log", amount: 1 }],
  movementLease: null,
  expectedResult: { item: "wooden_pickaxe" },
  actualResult: null,
  failureReason: null,
  cancellationToken: {
    tokenId: "cancel-task-01",
    cancelled: false,
    cancelledAt: null,
    reason: null,
  },
  revision: 4,
});

class Client implements TaskExecutionSqlClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  released = false;
  rowCount = 1;
  rows: readonly Record<string, unknown>[] = [];

  async query<TRow extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: readonly TRow[]; rowCount: number | null }> {
    this.calls.push({ text, values });
    return { rows: this.rows as readonly TRow[], rowCount: this.rowCount };
  }

  release(): void {
    this.released = true;
  }
}

class Pool implements TaskExecutionSqlPool {
  constructor(readonly client: Client) {}
  async connect(): Promise<Client> {
    return this.client;
  }
}

describe("PostgresTaskExecutionStore", () => {
  it("persists the complete snapshot with a monotonic revision guard", async () => {
    const client = new Client();
    const store = new PostgresTaskExecutionStore(new Pool(client));
    await store.save(record);
    expect(client.calls[0]?.text).toContain(
      "studio_task_executions.revision = EXCLUDED.revision - 1",
    );
    expect(client.calls[0]?.values).toContain(record.revision);
    expect(client.calls[0]?.values).toContain(JSON.stringify(record));
    expect(client.released).toBe(true);
  });

  it("loads and validates a durable execution snapshot", async () => {
    const client = new Client();
    client.rows = [{ snapshot: JSON.stringify(record) }];
    const store = new PostgresTaskExecutionStore(new Pool(client));
    expect(await store.get(record.taskId)).toEqual(record);
    expect(client.released).toBe(true);
  });

  it("rejects an older snapshot instead of overwriting newer progress", async () => {
    const client = new Client();
    client.rowCount = 0;
    client.rows = [{ revision: "5", snapshot: { ...record, revision: 5 } }];
    const store = new PostgresTaskExecutionStore(new Pool(client));
    await expect(store.save(record)).rejects.toThrow("revision is stale");
    expect(client.calls).toHaveLength(2);
  });

  it("rejects a skipped revision instead of overwriting unseen progress", async () => {
    const client = new Client();
    client.rowCount = 0;
    client.rows = [{ revision: "2", snapshot: { ...record, revision: 2 } }];
    const store = new PostgresTaskExecutionStore(new Pool(client));
    await expect(store.save(record)).rejects.toThrow(
      "not the next durable revision",
    );
  });
});
