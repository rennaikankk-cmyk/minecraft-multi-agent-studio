import { beforeEach, describe, expect, it, vi } from "vitest";

const pgMock = vi.hoisted(() => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    client,
    configs: [] as unknown[],
    connect: vi.fn(),
    end: vi.fn(),
    listeners: new Map<string, (...arguments_: unknown[]) => void>(),
    query: vi.fn(),
  };
});

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(config: unknown) {
      pgMock.configs.push(config);
    }

    on(event: string, listener: (...arguments_: unknown[]) => void) {
      pgMock.listeners.set(event, listener);
      return this;
    }

    query(...arguments_: unknown[]) {
      return pgMock.query(...arguments_);
    }

    connect() {
      return pgMock.connect();
    }

    end() {
      return pgMock.end();
    }
  },
}));

import {
  PgWorldMemoryPoolAdapter,
  PgWorldMemoryPoolAdapterError,
  WORLD_MEMORY_PG_CONNECTION_TIMEOUT_MS,
  WORLD_MEMORY_PG_QUERY_TIMEOUT_MS,
  WORLD_MEMORY_PG_STATEMENT_TIMEOUT_MS,
} from "../src/pg-pool-adapter.js";

describe("bounded world-memory PostgreSQL pool adapter", () => {
  beforeEach(() => {
    pgMock.configs.length = 0;
    pgMock.listeners.clear();
    pgMock.client.query.mockReset();
    pgMock.client.release.mockReset();
    pgMock.connect.mockReset().mockResolvedValue(pgMock.client);
    pgMock.end.mockReset().mockResolvedValue(undefined);
    pgMock.query.mockReset().mockResolvedValue({
      rows: [{ ready: 1 }],
      rowCount: 1,
    });
  });

  it("forces bounded connection, statement, and query timeouts", () => {
    new PgWorldMemoryPoolAdapter({
      connectionTimeoutMillis: 0,
      query_timeout: 0,
      statement_timeout: 0,
    });

    expect(pgMock.configs[0]).toMatchObject({
      connectionTimeoutMillis: WORLD_MEMORY_PG_CONNECTION_TIMEOUT_MS,
      query_timeout: WORLD_MEMORY_PG_QUERY_TIMEOUT_MS,
      statement_timeout: WORLD_MEMORY_PG_STATEMENT_TIMEOUT_MS,
    });
    expect(pgMock.listeners.has("error")).toBe(true);
  });

  it("stores only stable sanitized background health state", async () => {
    const adapter = new PgWorldMemoryPoolAdapter({});
    await adapter.verifyConnection();
    expect(adapter.getHealthStatus()).toEqual({
      status: "ready",
      errorCode: null,
    });

    pgMock.listeners.get("error")?.(
      new Error("password=secret postgresql://admin:secret@example.invalid/db"),
    );

    const health = adapter.getHealthStatus();
    expect(health).toEqual({
      status: "degraded",
      errorCode: "POSTGRES_POOL_BACKGROUND_ERROR",
    });
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  it("replaces raw connection and query failures with stable errors", async () => {
    const adapter = new PgWorldMemoryPoolAdapter({});
    pgMock.connect.mockRejectedValueOnce(new Error("password=connection-secret"));

    await expect(adapter.connect()).rejects.toMatchObject({
      code: "POSTGRES_CONNECTION_UNAVAILABLE",
      message: "PostgreSQL connection is unavailable.",
    });

    const client = await adapter.connect();
    pgMock.client.query.mockRejectedValueOnce(new Error("password=query-secret"));
    await expect(client.query("SELECT $1::integer", [1])).rejects.toEqual(
      expect.objectContaining<PgWorldMemoryPoolAdapterError>({
        code: "POSTGRES_QUERY_FAILED",
        message: "PostgreSQL query failed.",
      }),
    );
    expect(JSON.stringify(adapter.getHealthStatus())).not.toContain("secret");
  });

  it("uses stable readiness failures and tracks graceful closure", async () => {
    const adapter = new PgWorldMemoryPoolAdapter({});
    pgMock.query.mockRejectedValueOnce(new Error("host=private.internal"));

    await expect(adapter.verifyConnection()).rejects.toMatchObject({
      code: "POSTGRES_READINESS_FAILED",
      message: "PostgreSQL readiness check failed.",
    });

    await adapter.close();
    expect(adapter.getHealthStatus()).toEqual({
      status: "closed",
      errorCode: null,
    });
  });
});
