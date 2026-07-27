import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";

import {
  type PostgresClientLike,
  type PostgresPoolLike,
  type SqlQueryResult,
} from "./postgres-repository.js";

type SqlRow = Record<string, unknown>;

export const PG_CONNECTION_TIMEOUT_MS = 5_000;
export const PG_STATEMENT_TIMEOUT_MS = 10_000;
export const PG_QUERY_TIMEOUT_MS = 12_000;

export type PgTaskPoolErrorCode =
  | "POSTGRES_CONNECTION_UNAVAILABLE"
  | "POSTGRES_QUERY_FAILED"
  | "POSTGRES_POOL_BACKGROUND_ERROR"
  | "POSTGRES_READINESS_FAILED"
  | "POSTGRES_CLOSE_FAILED";

export type PgTaskPoolHealth = Readonly<{
  status: "unknown" | "ready" | "degraded" | "closed";
  errorCode: PgTaskPoolErrorCode | null;
}>;

export class PgTaskPoolAdapterError extends Error {
  constructor(
    readonly code: PgTaskPoolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PgTaskPoolAdapterError";
  }
}

class PgClientAdapter implements PostgresClientLike {
  constructor(
    private readonly client: PoolClient,
    private readonly recordFailure: (
      code: PgTaskPoolErrorCode,
    ) => void,
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
    } catch {
      this.recordFailure("POSTGRES_QUERY_FAILED");
      throw new PgTaskPoolAdapterError(
        "POSTGRES_QUERY_FAILED",
        "PostgreSQL query failed.",
      );
    }
  }

  release(): void {
    this.client.release();
  }
}

export class PgTaskPoolAdapter implements PostgresPoolLike {
  private readonly pool: Pool;
  private health: PgTaskPoolHealth = Object.freeze({
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
    } catch {
      this.setHealth("degraded", "POSTGRES_CONNECTION_UNAVAILABLE");
      throw new PgTaskPoolAdapterError(
        "POSTGRES_CONNECTION_UNAVAILABLE",
        "PostgreSQL connection is unavailable.",
      );
    }
  }

  async verifyConnection(): Promise<void> {
    try {
      const result = await this.pool.query<{ ready: number }>(
        "SELECT 1::integer AS ready",
      );
      if (result.rows[0]?.ready !== 1) {
        throw new PgTaskPoolAdapterError(
          "POSTGRES_READINESS_FAILED",
          "PostgreSQL readiness check failed.",
        );
      }
      this.setHealth("ready", null);
    } catch {
      this.setHealth("degraded", "POSTGRES_READINESS_FAILED");
      throw new PgTaskPoolAdapterError(
        "POSTGRES_READINESS_FAILED",
        "PostgreSQL readiness check failed.",
      );
    }
  }

  getHealthStatus(): PgTaskPoolHealth {
    return this.health;
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
      this.setHealth("closed", null);
    } catch {
      this.setHealth("degraded", "POSTGRES_CLOSE_FAILED");
      throw new PgTaskPoolAdapterError(
        "POSTGRES_CLOSE_FAILED",
        "PostgreSQL pool failed to close.",
      );
    }
  }

  private setHealth(
    status: PgTaskPoolHealth["status"],
    errorCode: PgTaskPoolErrorCode | null,
  ): void {
    this.health = Object.freeze({ status, errorCode });
  }
}
