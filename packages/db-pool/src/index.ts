import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";

/**
 * 有界生产 pg 池适配器 —— task-system 与 world-memory 此前各自维护一份
 * 结构级拷贝（含超时/健康状态机），漂移即产生分叉的数据库行为。
 * 本包是该实现的唯一权威；两个消费包经各自的 pg-pool-adapter.ts 兼容
 * re-export 保留既有公共名（错误码统一为 POSTGRES_* 前缀，全仓无字符串
 * 匹配消费者）。
 */

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
  verifyConnection(): Promise<void>;
  getHealthStatus(): PgPoolHealth;
  close(): Promise<void>;
}

export const PG_CONNECTION_TIMEOUT_MS = 5_000;
export const PG_STATEMENT_TIMEOUT_MS = 10_000;
export const PG_QUERY_TIMEOUT_MS = 12_000;

export type PgPoolErrorCode =
  | "POSTGRES_CONNECTION_UNAVAILABLE"
  | "POSTGRES_QUERY_FAILED"
  | "POSTGRES_POOL_BACKGROUND_ERROR"
  | "POSTGRES_READINESS_FAILED"
  | "POSTGRES_CLOSE_FAILED";

export type PgPoolHealth = Readonly<{
  status: "unknown" | "ready" | "degraded" | "closed";
  errorCode: PgPoolErrorCode | null;
}>;

export class PgPoolAdapterError extends Error {
  constructor(
    readonly code: PgPoolErrorCode,
    message: string,
    options?: Readonly<{ cause: unknown }>,
  ) {
    super(message, options);
    this.name = "PgPoolAdapterError";
  }
}

class PgClientAdapter implements PostgresClientLike {
  constructor(
    private readonly client: PoolClient,
    private readonly recordFailure: (code: PgPoolErrorCode) => void,
  ) {}

  async query<TRow extends SqlRow = SqlRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>> {
    try {
      const result = await this.client.query<QueryResultRow>(
        text,
        values === undefined ? [] : [...values],
      );
      return {
        rows: result.rows as TRow[],
        rowCount: result.rowCount,
      };
    } catch (error) {
      this.recordFailure("POSTGRES_QUERY_FAILED");
      throw new PgPoolAdapterError(
        "POSTGRES_QUERY_FAILED",
        "PostgreSQL query failed.",
        { cause: error },
      );
    }
  }

  release(): void {
    this.client.release();
  }
}

export class PgPoolAdapter implements PostgresPoolLike {
  private readonly pool: Pool;
  private health: PgPoolHealth = Object.freeze({
    status: "unknown",
    errorCode: null,
  });

  constructor(config: PoolConfig) {
    this.pool = new Pool({
      ...config,
      connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
      statement_timeout: PG_STATEMENT_TIMEOUT_MS,
      query_timeout: PG_QUERY_TIMEOUT_MS,
    });
    this.pool.on("error", () => {
      this.setHealth("degraded", "POSTGRES_POOL_BACKGROUND_ERROR");
    });
  }

  async connect(): Promise<PostgresClientLike> {
    try {
      const client = await this.pool.connect();
      this.setHealth("ready", null);
      return new PgClientAdapter(client, (code) => {
        this.setHealth("degraded", code);
      });
    } catch (error) {
      this.setHealth("degraded", "POSTGRES_CONNECTION_UNAVAILABLE");
      throw new PgPoolAdapterError(
        "POSTGRES_CONNECTION_UNAVAILABLE",
        "PostgreSQL connection is unavailable.",
        { cause: error },
      );
    }
  }

  async verifyConnection(): Promise<void> {
    // 就绪失败的两类来源（探针查询抛错 / 返回行不符）统一折叠为稳定错误，
    // 但保留原始 cause 供诊断；健康状态只落稳定错误码。
    let failure: unknown;
    try {
      const result = await this.pool.query<{ ready: number }>(
        "SELECT 1::integer AS ready",
      );
      if (result.rows[0]?.ready !== 1) {
        failure = new Error("readiness probe returned an unexpected row");
      } else {
        this.setHealth("ready", null);
        return;
      }
    } catch (error) {
      failure = error;
    }
    this.setHealth("degraded", "POSTGRES_READINESS_FAILED");
    throw new PgPoolAdapterError(
      "POSTGRES_READINESS_FAILED",
      "PostgreSQL readiness check failed.",
      { cause: failure },
    );
  }

  getHealthStatus(): PgPoolHealth {
    return this.health;
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
      this.setHealth("closed", null);
    } catch (error) {
      this.setHealth("degraded", "POSTGRES_CLOSE_FAILED");
      throw new PgPoolAdapterError(
        "POSTGRES_CLOSE_FAILED",
        "PostgreSQL pool failed to close.",
        { cause: error },
      );
    }
  }

  private setHealth(
    status: PgPoolHealth["status"],
    errorCode: PgPoolErrorCode | null,
  ): void {
    this.health = Object.freeze({ status, errorCode });
  }
}
