import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  PostgresWorldMemoryRepository,
  WorldMemoryAccessError,
  WorldMemoryPersistenceError,
  type WorldMemorySqlClient,
  type WorldMemorySqlPool,
  type WorldMemorySqlQueryResult,
  type WorldMemoryRecord,
} from "../src/index.js";

const PROFILE_A = "server-a";
const PROFILE_B = "server-b";
const DIMENSION = "minecraft:overworld";
const OBSERVED_AT = "2026-08-22T00:00:00.000Z";

function record(
  serverProfileId: string,
  overrides: Partial<WorldMemoryRecord> = {},
): WorldMemoryRecord {
  return {
    serverProfileId,
    dimension: DIMENSION,
    position: { x: 100, y: 64, z: 200 },
    kind: "SAFE_SITE",
    observedAt: OBSERVED_AT,
    confidence: 0.9,
    staleAfterMs: 60_000,
    payload: { source: "isolated-test" },
    ...overrides,
  };
}

type DbRow = Record<string, unknown>;

function dbRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    memory_id: "1",
    server_profile_id: PROFILE_A,
    dimension: DIMENSION,
    x: "100",
    y: 64,
    z: "200",
    kind: "SAFE_SITE",
    observed_at: new Date(OBSERVED_AT),
    confidence: "0.9",
    stale_after_ms: "60000",
    payload: { source: "database" },
    ...overrides,
  };
}

class FakeClient implements WorldMemorySqlClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  released = 0;
  rows: readonly DbRow[] = [];
  queryError: Error | null = null;
  deferred: Promise<WorldMemorySqlQueryResult<DbRow>> | null = null;

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<WorldMemorySqlQueryResult<TRow>> {
    this.calls.push({ text, values });
    if (this.queryError) throw this.queryError;
    if (this.deferred) return await this.deferred as WorldMemorySqlQueryResult<TRow>;
    return { rows: this.rows as readonly TRow[], rowCount: this.rows.length };
  }

  release(): void {
    this.released += 1;
  }
}

class FakePool implements WorldMemorySqlPool {
  readonly client = new FakeClient();
  connects = 0;

  async connect(): Promise<WorldMemorySqlClient> {
    this.connects += 1;
    return this.client;
  }
}

describe("PostgresWorldMemoryRepository", () => {
  it("rejects access before a server is selected without opening a connection", async () => {
    const pool = new FakePool();
    const repository = new PostgresWorldMemoryRepository(pool, { nowMs: () => 0 });

    await expect(repository.put(record(PROFILE_A))).rejects.toThrowError(
      WorldMemoryAccessError,
    );
    await expect(repository.findByKind(PROFILE_A, "SAFE_SITE")).rejects.toThrowError(
      WorldMemoryAccessError,
    );
    expect(pool.connects).toBe(0);
  });

  it("writes through parameterized SQL and maps the returned fact", async () => {
    const pool = new FakePool();
    pool.client.rows = [dbRow()];
    const repository = new PostgresWorldMemoryRepository(pool, {
      nowMs: () => Date.parse(OBSERVED_AT),
    });
    repository.switchServer(PROFILE_A);

    await expect(repository.put(record(PROFILE_A))).resolves.toMatchObject({
      serverProfileId: PROFILE_A,
      payload: { source: "database" },
    });
    expect(pool.client.calls).toHaveLength(1);
    const call = pool.client.calls[0]!;
    expect(call.text).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)");
    expect(call.text).not.toContain(PROFILE_A);
    expect(call.values[0]).toBe(PROFILE_A);
    expect(call.values[9]).toBe(JSON.stringify({ source: "isolated-test" }));
    expect(pool.client.released).toBe(1);
  });

  it("labels rows and keeps the query scoped to profile and kind", async () => {
    const pool = new FakePool();
    pool.client.rows = [dbRow({ observed_at: new Date("2026-08-22T00:00:30.000Z") })];
    const nowMs = Date.parse("2026-08-22T00:01:00.000Z");
    const repository = new PostgresWorldMemoryRepository(pool, { nowMs: () => nowMs });
    repository.switchServer(PROFILE_A);

    const result = await repository.findByKind(PROFILE_A, "SAFE_SITE");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ freshness: "fresh", ageMs: 30_000 });
    expect(pool.client.calls[0]?.values).toEqual([
      PROFILE_A,
      "SAFE_SITE",
      100,
    ]);
    expect(pool.client.calls[0]?.text).toContain("LIMIT $3::integer");
  });

  it("rejects a database row that violates the active server scope", async () => {
    const pool = new FakePool();
    pool.client.rows = [dbRow({ server_profile_id: PROFILE_B })];
    const repository = new PostgresWorldMemoryRepository(pool, { nowMs: () => 0 });
    repository.switchServer(PROFILE_A);

    await expect(repository.findByKind(PROFILE_A, "SAFE_SITE")).rejects.toMatchObject({
      code: "WORLD_MEMORY_ROW_INVALID",
    } satisfies Partial<WorldMemoryPersistenceError>);
  });

  it("does not release stale query results after a disconnect", async () => {
    const pool = new FakePool();
    let resolveQuery!: (result: WorldMemorySqlQueryResult<DbRow>) => void;
    pool.client.deferred = new Promise((resolve) => {
      resolveQuery = resolve;
    });
    const repository = new PostgresWorldMemoryRepository(pool, { nowMs: () => 0 });
    repository.switchServer(PROFILE_A);

    const pending = repository.findByKind(PROFILE_A, "SAFE_SITE");
    repository.disconnectServer();
    resolveQuery({ rows: [dbRow()], rowCount: 1 });

    await expect(pending).rejects.toMatchObject({
      code: "WORLD_MEMORY_SERVER_NOT_SELECTED",
    });
    expect(pool.client.released).toBe(1);
  });

  it("rejects a radius whose square overflows", async () => {
    const pool = new FakePool();
    const repository = new PostgresWorldMemoryRepository(pool, { nowMs: () => 0 });
    repository.switchServer(PROFILE_A);

    await expect(repository.findNearby(
      PROFILE_A,
      DIMENSION,
      { x: 100, y: 64, z: 200 },
      Number.MAX_VALUE,
    )).rejects.toThrowError(RangeError);
    expect(pool.connects).toBe(0);
  });

  it("ships an append-only, scoped migration", async () => {
    const migration = await readFile(
      new URL("../migrations/0001_world_memory.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS studio_world_memory");
    expect(migration).toContain("server_profile_id");
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("jsonb_typeof(payload) = 'object'");
    expect(migration.match(/'NaN'::double precision/gu)).toHaveLength(3);
    expect(migration.match(/'Infinity'::double precision/gu)).toHaveLength(3);
    expect(migration.match(/'-Infinity'::double precision/gu)).toHaveLength(3);
  });
});
