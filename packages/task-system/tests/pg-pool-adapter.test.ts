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
  PG_CONNECTION_TIMEOUT_MS,
  PG_QUERY_TIMEOUT_MS,
  PG_STATEMENT_TIMEOUT_MS,
  PgTaskPoolAdapter,
  PgTaskPoolAdapterError,
} from "../src/pg-pool-adapter.js";

describe("bounded PostgreSQL pool adapter", () => {
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

  it("forces bounded connection, statement and query timeouts", () => {
    new PgTaskPoolAdapter({
      connectionTimeoutMillis: 0,
      query_timeout: 0,
      statement_timeout: 0,
    });

    expect(pgMock.configs[0]).toMatchObject({
      connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
      query_timeout: PG_QUERY_TIMEOUT_MS,
      statement_timeout: PG_STATEMENT_TIMEOUT_MS,
    });
    expect(pgMock.listeners.has("error")).toBe(true);
  });

  it("stores only a stable sanitized background health error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const adapter = new PgTaskPoolAdapter({});
      await adapter.verifyConnection();
      expect(adapter.getHealthStatus()).toEqual({
        status: "ready",
        errorCode: null,
      });

      pgMock.listeners
        .get("error")
        ?.(
          new Error(
            "password=secret postgresql://admin:secret@example.invalid/db",
          ),
        );

      const health = adapter.getHealthStatus();
      expect(health).toEqual({
        status: "degraded",
        errorCode: "POSTGRES_POOL_BACKGROUND_ERROR",
      });
      expect(JSON.stringify(health)).not.toContain("secret");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("replaces raw connection and query failures with stable errors", async () => {
    const adapter = new PgTaskPoolAdapter({});
    pgMock.connect.mockRejectedValueOnce(
      new Error("password=connection-secret"),
    );

    await expect(adapter.connect()).rejects.toMatchObject({
      code: "POSTGRES_CONNECTION_UNAVAILABLE",
      message: "PostgreSQL connection is unavailable.",
    });
    expect(adapter.getHealthStatus()).toEqual({
      status: "degraded",
      errorCode: "POSTGRES_CONNECTION_UNAVAILABLE",
    });

    const client = await adapter.connect();
    pgMock.client.query.mockRejectedValueOnce(
      new Error("password=query-secret"),
    );
    await expect(client.query("SELECT $1::integer", [1])).rejects.toEqual(
      expect.objectContaining<PgTaskPoolAdapterError>({
        code: "POSTGRES_QUERY_FAILED",
        message: "PostgreSQL query failed.",
      }),
    );
    expect(JSON.stringify(adapter.getHealthStatus())).not.toContain("secret");
  });

  it("uses stable readiness failures and tracks graceful closure", async () => {
    const adapter = new PgTaskPoolAdapter({});
    pgMock.query.mockRejectedValueOnce(new Error("host=private.internal"));

    await expect(adapter.verifyConnection()).rejects.toMatchObject({
      code: "POSTGRES_READINESS_FAILED",
      message: "PostgreSQL readiness check failed.",
    });
    expect(adapter.getHealthStatus()).toEqual({
      status: "degraded",
      errorCode: "POSTGRES_READINESS_FAILED",
    });

    await adapter.close();
    expect(adapter.getHealthStatus()).toEqual({
      status: "closed",
      errorCode: null,
    });
  });

  it("preserves the original pg error as cause on every stable failure path", async () => {
    // 稳定错误码/文案不变，但原始错误必须经 cause 保留——statement timeout、
    // 约束冲突（23505）、语法错误等关键诊断信息不能被固定文案吞掉。
    const adapter = new PgTaskPoolAdapter({});

    pgMock.client.query.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    );
    const client = await adapter.connect();
    const queryFailure = await client.query("SELECT 1").then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error,
    );
    expect(queryFailure).toMatchObject({
      code: "POSTGRES_QUERY_FAILED",
      message: "PostgreSQL query failed.",
    });
    expect((queryFailure as { cause?: { message?: string; code?: string } }).cause)
      .toMatchObject({ message: "duplicate key value violates unique constraint", code: "23505" });

    pgMock.connect.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1:5432"));
    const connectFailure = await adapter.connect().then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error,
    );
    expect(connectFailure).toMatchObject({ code: "POSTGRES_CONNECTION_UNAVAILABLE" });
    expect((connectFailure as { cause?: { message?: string } }).cause)
      .toMatchObject({ message: "ECONNREFUSED 127.0.0.1:5432" });

    pgMock.query.mockRejectedValueOnce(new Error("statement timeout"));
    const readinessFailure = await adapter.verifyConnection().then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error,
    );
    expect(readinessFailure).toMatchObject({ code: "POSTGRES_READINESS_FAILED" });
    expect((readinessFailure as { cause?: { message?: string } }).cause)
      .toMatchObject({ message: "statement timeout" });
  });
});
