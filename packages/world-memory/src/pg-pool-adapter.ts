import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";

import {
  type WorldMemorySqlClient,
  type WorldMemorySqlPool,
  type WorldMemorySqlQueryResult,
} from "./postgres-repository.js";

type SqlRow = Record<string, unknown>;

export const WORLD_MEMORY_PG_CONNECTION_TIMEOUT_MS = 5_000;
export const WORLD_MEMORY_PG_STATEMENT_TIMEOUT_MS = 10_000;
export const WORLD_MEMORY_PG_QUERY_TIMEOUT_MS = 12_000;

export type PgWorldMemoryPoolErrorCode =
  | "WORLD_MEMORY_POSTGRES_CONNECTION_UNAVAILABLE"
  | "WORLD_MEMORY_POSTGRES_QUERY_FAILED"
  | "WORLD_MEMORY_POSTGRES_POOL_BACKGROUND_ERROR"
  | "WORLD_MEMORY_POSTGRES_READINESS_FAILED"
  | "WORLD_MEMORY_POSTGRES_CLOSE_FAILED";

export type PgWorldMemoryPoolHealth = Readonly<{
  status: "unknown" | "ready" | "degraded" | "closed";
  errorCode: PgWorldMemoryPoolErrorCode | null;
}>;

export class PgWorldMemoryPoolAdapterError extends Error {
  constructor(
    readonly code: PgWorldMemoryPoolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PgWorldMemoryPoolAdapterError";
  }
}

class PgWorldMemoryClientAdapter implements WorldMemorySqlClient {
  constructor(
    private readonly client: PoolClient,
    private readonly recordFailure: (
      code: PgWorldMemoryPoolErrorCode,
    ) => void,
  ) {}

  async query<TRow extends SqlRow = SqlRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<WorldMemorySqlQueryResult<TRow>> {
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
      this.recordFailure("WORLD_MEMORY_POSTGRES_QUERY_FAILED");
      throw new PgWorldMemoryPoolAdapterError(
        "WORLD_MEMORY_POSTGRES_QUERY_FAILED",
        "PostgreSQL world memory query failed.",
      );
    }
  }

  release(): void {
    this.client.release();
  }
}

/** Bounded production pg adapter for the durable world-memory repository. */
export class PgWorldMemoryPoolAdapter implements WorldMemorySqlPool {
  private readonly pool: Pool;
  private health: PgWorldMemoryPoolHealth = Object.freeze({
    status: "unknown",
    errorCode: null,
  });

  constructor(config: PoolConfig) {
    this.pool = new Pool({
      ...config,
      connectionTimeoutMillis: WORLD_MEMORY_PG_CONNECTION_TIMEOUT_MS,
      statement_timeout: WORLD_MEMORY_PG_STATEMENT_TIMEOUT_MS,
      query_timeout: WORLD_MEMORY_PG_QUERY_TIMEOUT_MS,
    });
    this.pool.on("error", () => {
      this.setHealth(
        "degraded",
        "WORLD_MEMORY_POSTGRES_POOL_BACKGROUND_ERROR",
      );
    });
  }

  async connect(): Promise<WorldMemorySqlClient> {
    try {
      const client = await this.pool.connect();
      this.setHealth("ready", null);
      return new PgWorldMemoryClientAdapter(client, (code) => {
        this.setHealth("degraded", code);
      });
    } catch {
      this.setHealth(
        "degraded",
        "WORLD_MEMORY_POSTGRES_CONNECTION_UNAVAILABLE",
      );
      throw new PgWorldMemoryPoolAdapterError(
        "WORLD_MEMORY_POSTGRES_CONNECTION_UNAVAILABLE",
        "PostgreSQL world memory connection is unavailable.",
      );
    }
  }

  async verifyConnection(): Promise<void> {
    try {
      const result = await this.pool.query<{ ready: number }>(
        "SELECT 1::integer AS ready",
      );
      if (result.rows[0]?.ready !== 1) {
        throw new Error("Unexpected readiness result.");
      }
      this.setHealth("ready", null);
    } catch {
      this.setHealth(
        "degraded",
        "WORLD_MEMORY_POSTGRES_READINESS_FAILED",
      );
      throw new PgWorldMemoryPoolAdapterError(
        "WORLD_MEMORY_POSTGRES_READINESS_FAILED",
        "PostgreSQL world memory readiness check failed.",
      );
    }
  }

  getHealthStatus(): PgWorldMemoryPoolHealth {
    return this.health;
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
      this.setHealth("closed", null);
    } catch {
      this.setHealth("degraded", "WORLD_MEMORY_POSTGRES_CLOSE_FAILED");
      throw new PgWorldMemoryPoolAdapterError(
        "WORLD_MEMORY_POSTGRES_CLOSE_FAILED",
        "PostgreSQL world memory pool failed to close.",
      );
    }
  }

  private setHealth(
    status: PgWorldMemoryPoolHealth["status"],
    errorCode: PgWorldMemoryPoolErrorCode | null,
  ): void {
    this.health = Object.freeze({ status, errorCode });
  }
}
