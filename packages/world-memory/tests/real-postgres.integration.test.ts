import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  PgWorldMemoryPoolAdapter,
  PostgresWorldMemoryRepository,
  type WorldMemoryRecord,
} from "../src/index.js";

const runRealPostgres = process.env.RUN_REAL_WORLD_MEMORY_TEST === "1";
const describeReal = runRealPostgres ? describe : describe.skip;
const REAL_TEST_TIMEOUT_MS = 30_000;
const PROFILE_A = "world-memory-server-a";
const PROFILE_B = "world-memory-server-b";
const DIMENSION = "minecraft:overworld";
const OBSERVED_AT = "2026-08-23T00:00:00.000Z";
const migrationPath = fileURLToPath(
  new URL("../migrations/0001_world_memory.sql", import.meta.url),
);

function isolatedNamespace(input: string | undefined): string {
  if (!input || !/^studio_test_[a-z0-9_]{8,48}$/u.test(input)) {
    throw new Error(
      "WORLD_MEMORY_INFRA_TEST_NAMESPACE must be a dedicated studio_test_ identifier.",
    );
  }
  return input;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function isolatedPostgresUrl(input: string | undefined): string {
  if (!input || input.length > 2_048) {
    throw new Error("WORLD_MEMORY_POSTGRES_URL is required and bounded.");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("WORLD_MEMORY_POSTGRES_URL is invalid.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !isLoopbackHostname(url.hostname) ||
    url.pathname.length < 2 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "WORLD_MEMORY_POSTGRES_URL must name an isolated loopback database.",
    );
  }
  return url.href;
}

function record(
  serverProfileId: string,
  id: string,
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
    payload: { id },
    ...overrides,
  };
}

const rawInsertSql = `
  INSERT INTO studio_world_memory (
    server_profile_id, dimension, x, y, z, kind,
    observed_at, confidence, stale_after_ms, payload
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
`;

describeReal.sequential("real isolated PostgreSQL world memory", () => {
  let schemaName = "";
  let postgresUrl = "";
  let adminPool: Pool | null = null;
  let assertionPool: Pool | null = null;
  let adapter: PgWorldMemoryPoolAdapter | null = null;
  let repository: PostgresWorldMemoryRepository | null = null;

  beforeAll(async () => {
    schemaName = isolatedNamespace(
      process.env.WORLD_MEMORY_INFRA_TEST_NAMESPACE,
    );
    postgresUrl = isolatedPostgresUrl(
      process.env.WORLD_MEMORY_POSTGRES_URL,
    );
    adminPool = new Pool({ connectionString: postgresUrl });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);

    const scopedConfig = {
      connectionString: postgresUrl,
      options: `-c search_path=${schemaName}`,
    };
    assertionPool = new Pool(scopedConfig);
    const migration = await readFile(migrationPath, "utf8");
    await assertionPool.query(migration);

    adapter = new PgWorldMemoryPoolAdapter(scopedConfig);
    await adapter.verifyConnection();
    repository = new PostgresWorldMemoryRepository(adapter, {
      nowMs: () => Date.parse("2026-08-23T00:00:30.000Z"),
    });
  }, REAL_TEST_TIMEOUT_MS);

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    if (adapter) {
      await adapter.close().catch((error: unknown) => cleanupErrors.push(error));
    }
    if (assertionPool) {
      await assertionPool.end().catch((error: unknown) => cleanupErrors.push(error));
    }
    if (adminPool && schemaName) {
      await adminPool
        .query(`DROP SCHEMA "${schemaName}" CASCADE`)
        .catch((error: unknown) => cleanupErrors.push(error));
      await adminPool.end().catch((error: unknown) => cleanupErrors.push(error));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "World memory infrastructure cleanup failed.",
      );
    }
  }, REAL_TEST_TIMEOUT_MS);

  it("isolates identical coordinates by active server profile", async () => {
    repository!.switchServer(PROFILE_A);
    await repository!.put(record(PROFILE_A, "profile-a"));

    repository!.switchServer(PROFILE_B);
    await repository!.put(record(PROFILE_B, "profile-b"));
    await expect(repository!.findAtPosition(
      PROFILE_B,
      DIMENSION,
      { x: 100, y: 64, z: 200 },
    )).resolves.toMatchObject([
      { serverProfileId: PROFILE_B, payload: { id: "profile-b" } },
    ]);
    await expect(repository!.findByKind(PROFILE_A, "SAFE_SITE")).rejects.toMatchObject({
      code: "WORLD_MEMORY_SERVER_SCOPE_MISMATCH",
    });

    repository!.switchServer(PROFILE_A);
    await expect(repository!.findAtPosition(
      PROFILE_A,
      DIMENSION,
      { x: 100, y: 64, z: 200 },
    )).resolves.toMatchObject([
      { serverProfileId: PROFILE_A, payload: { id: "profile-a" } },
    ]);
  });

  it("treats an injection-shaped profile id as literal data", async () => {
    const literalProfile = "server-a' OR TRUE --";
    repository!.switchServer(literalProfile);
    await repository!.put(record(literalProfile, "literal-profile"));

    await expect(repository!.findByKind(
      literalProfile,
      "SAFE_SITE",
    )).resolves.toMatchObject([
      { serverProfileId: literalProfile, payload: { id: "literal-profile" } },
    ]);
    const count = await assertionPool!.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM studio_world_memory WHERE server_profile_id = $1",
      [literalProfile],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("rejects NaN, infinity, empty dimensions, and non-object payloads", async () => {
    for (const coordinate of [Number.NaN, Infinity, -Infinity]) {
      await expect(assertionPool!.query(rawInsertSql, [
        PROFILE_A,
        DIMENSION,
        coordinate,
        64,
        200,
        "SAFE_SITE",
        OBSERVED_AT,
        0.9,
        60_000,
        JSON.stringify({ coordinate }),
      ])).rejects.toBeDefined();
    }

    await expect(assertionPool!.query(rawInsertSql, [
      PROFILE_A,
      "",
      100,
      64,
      200,
      "SAFE_SITE",
      OBSERVED_AT,
      0.9,
      60_000,
      JSON.stringify({ id: "empty-dimension" }),
    ])).rejects.toBeDefined();
    await expect(assertionPool!.query(rawInsertSql, [
      PROFILE_A,
      DIMENSION,
      100,
      64,
      200,
      "SAFE_SITE",
      OBSERVED_AT,
      0.9,
      60_000,
      JSON.stringify(["not-an-object"]),
    ])).rejects.toBeDefined();
  });

  it("enforces append-only records in PostgreSQL", async () => {
    repository!.switchServer(PROFILE_A);
    await repository!.put(record(PROFILE_A, "append-only"));
    const row = await assertionPool!.query<{ memory_id: string }>(
      "SELECT memory_id::text FROM studio_world_memory WHERE payload ->> 'id' = $1",
      ["append-only"],
    );
    const memoryId = row.rows[0]?.memory_id;
    expect(memoryId).toBeDefined();

    await expect(assertionPool!.query(
      "UPDATE studio_world_memory SET confidence = $1 WHERE memory_id = $2",
      [0.1, memoryId],
    )).rejects.toBeDefined();
    await expect(assertionPool!.query(
      "DELETE FROM studio_world_memory WHERE memory_id = $1",
      [memoryId],
    )).rejects.toBeDefined();
  });

  it("enforces default and caller-selected query limits", async () => {
    const boundedProfile = "world-memory-bounded-profile";
    await assertionPool!.query(
      `INSERT INTO studio_world_memory (
         server_profile_id, dimension, x, y, z, kind,
         observed_at, confidence, stale_after_ms, payload
       )
       SELECT $1, $2, series::double precision, 64, 200, 'ORE_VEIN',
              $3::timestamptz, 0.8, 60000,
              jsonb_build_object('series', series)
       FROM generate_series(1, 105) AS series`,
      [boundedProfile, DIMENSION, OBSERVED_AT],
    );
    repository!.switchServer(boundedProfile);

    await expect(repository!.findByKind(
      boundedProfile,
      "ORE_VEIN",
    )).resolves.toHaveLength(100);
    await expect(repository!.findByKind(
      boundedProfile,
      "ORE_VEIN",
      { limit: 5 },
    )).resolves.toHaveLength(5);
  });
});
