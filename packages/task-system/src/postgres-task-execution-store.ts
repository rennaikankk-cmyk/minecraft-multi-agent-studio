import {
  taskExecutionRecordSchema,
  type TaskExecutionRecord,
  type TaskExecutionStore,
} from "./task-fsm.js";
import { z } from "zod";

type SqlRow = Record<string, unknown>;
const taskExecutionUuidSchema = z.string().uuid();

export interface TaskExecutionSqlClient {
  query<TRow extends SqlRow = SqlRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly TRow[]; rowCount: number | null }>;
}

export interface TaskExecutionSqlPool {
  connect(): Promise<TaskExecutionSqlClient & { release(): void }>;
}

function rowSnapshot(row: SqlRow): TaskExecutionRecord {
  const snapshot = row.snapshot;
  return taskExecutionRecordSchema.parse(
    typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot,
  );
}

/** PostgreSQL-backed durable store for the execution FSM. */
export class PostgresTaskExecutionStore implements TaskExecutionStore {
  private readonly pool: TaskExecutionSqlPool;

  constructor(pool: TaskExecutionSqlPool) {
    this.pool = pool;
  }

  async get(taskId: string): Promise<TaskExecutionRecord | null> {
    const parsedTaskId = taskExecutionUuidSchema.parse(taskId);
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT snapshot
           FROM studio_task_executions
          WHERE task_id = $1`,
        [parsedTaskId],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowSnapshot(row);
    } finally {
      client.release();
    }
  }

  async save(record: TaskExecutionRecord): Promise<void> {
    const parsed = taskExecutionRecordSchema.parse(record);
    taskExecutionUuidSchema.parse(parsed.taskId);
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO studio_task_executions (
           task_id, bot_id, execution_state, revision, snapshot, updated_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
         ON CONFLICT (task_id) DO UPDATE SET
           bot_id = EXCLUDED.bot_id,
           execution_state = EXCLUDED.execution_state,
           revision = EXCLUDED.revision,
           snapshot = EXCLUDED.snapshot,
           updated_at = EXCLUDED.updated_at
         WHERE studio_task_executions.revision = EXCLUDED.revision - 1`,
        [
          parsed.taskId,
          parsed.botId,
          parsed.state,
          parsed.revision,
          JSON.stringify(parsed),
          parsed.updatedAt,
        ],
      );
      // A duplicate revision is idempotent. Every mutation after creation is
      // a one-step CAS, so a writer cannot skip over an unseen durable revision.
      if (result.rowCount === null) {
        throw new Error("Task execution persistence returned no row count.");
      }
      if (result.rowCount === 0) {
        const current = await client.query(
          `SELECT revision, snapshot
             FROM studio_task_executions
            WHERE task_id = $1`,
          [parsed.taskId],
        );
        const currentRow = current.rows[0];
        const revision = Number(currentRow?.revision);
        if (!Number.isSafeInteger(revision)) {
          throw new Error("Task execution revision could not be verified.");
        }
        if (revision > parsed.revision) {
          throw new Error("Task execution revision is stale.");
        }
        if (revision < parsed.revision) {
          throw new Error("Task execution revision is not the next durable revision.");
        }
        if (revision === parsed.revision) {
          const durable = rowSnapshot(currentRow!);
          if (JSON.stringify(durable) !== JSON.stringify(parsed)) {
            throw new Error("Task execution revision conflicts with another snapshot.");
          }
        }
      }
    } finally {
      client.release();
    }
  }

  async list(): Promise<readonly TaskExecutionRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT snapshot
           FROM studio_task_executions
          ORDER BY updated_at ASC, task_id ASC`,
      );
      return result.rows.map(rowSnapshot);
    } finally {
      client.release();
    }
  }
}
