import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgTaskPoolAdapter } from "@minecraft-studio/task-system";

import {
  PostgresWorldMemoryRepository,
  type WorldMemoryWriteCommand,
} from "../src/index.js";

const describeReal =
  process.env.RUN_REAL_WORLD_MEMORY_TEST === "1" ? describe : describe.skip;
const MIGRATION = {
  path: fileURLToPath(
    new URL("../migrations/0001_world_memory.sql", import.meta.url),
  ),
  sha256: "f4ce1be59254dd361dbc7a4ae3c32eb7c6194a367b80466b9ae571de0804d286",
} as const;

function namespace(input: string | undefined): string {
  if (!input || !/^studio_test_[a-z0-9_]{8,48}$/u.test(input)) {
    throw new Error(
      "WORLD_MEMORY_TEST_NAMESPACE must be a dedicated studio_test_ identifier.",
    );
  }
  return input;
}

function writeCommand(
  overrides: Partial<WorldMemoryWriteCommand> = {},
): WorldMemoryWriteCommand {
  return {
    schemaVersion: "1.0",
    operationId: randomUUID(),
    memoryId: randomUUID(),
    serverProfileId: "server-alpha",
    dimension: "minecraft:overworld",
    position: { x: 10, y: 64, z: 12 },
    kind: "resource",
    summary: "Iron vein below the ridge.",
    tags: ["iron", "ridge"],
    confidence: 0.9,
    visibility: "team",
    allowedSubjectIds: [],
    modelAccess: true,
    sourceBotId: "scout-01",
    sourceTaskId: null,
    traceId: "trace-world-memory",
    observedAt: "2026-08-20T08:00:00.000Z",
    expiresAt: null,
    supersedesMemoryId: null,
    embedding: { model: "integration-embedding-v1", values: [1, 0, 0] },
    ...overrides,
  };
}

describeReal.sequential("real PostgreSQL/pgvector world memory", () => {
  let adminPool: Pool;
  let assertionPool: Pool;
  let adapter: PgTaskPoolAdapter;
  let repository: PostgresWorldMemoryRepository;
  let schemaName: string;

  beforeAll(async () => {
    const connectionString = process.env.WORLD_MEMORY_POSTGRES_URL;
    if (!connectionString) {
      throw new Error("WORLD_MEMORY_POSTGRES_URL is required.");
    }
    schemaName = namespace(process.env.WORLD_MEMORY_TEST_NAMESPACE);
    adminPool = new Pool({ connectionString });
    await adminPool.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const scopedConfig = {
      connectionString,
      options: `-c search_path=${schemaName},public`,
    };
    assertionPool = new Pool(scopedConfig);
    const migration = await readFile(MIGRATION.path, "utf8");
    expect(createHash("sha256").update(migration).digest("hex")).toBe(
      MIGRATION.sha256,
    );
    await assertionPool.query(migration);
    adapter = new PgTaskPoolAdapter(scopedConfig);
    await adapter.verifyConnection();
    repository = new PostgresWorldMemoryRepository(
      adapter,
      () => new Date("2026-08-20T08:00:01.000Z"),
    );
    await repository.verifySchema();
  }, 30_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    await adapter?.close().catch((error) => errors.push(error));
    await assertionPool?.end().catch((error) => errors.push(error));
    if (adminPool && schemaName) {
      await adminPool
        .query(`DROP SCHEMA "${schemaName}" CASCADE`)
        .catch((error) => errors.push(error));
      await adminPool.end().catch((error) => errors.push(error));
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "World-memory integration cleanup failed.");
    }
  }, 30_000);

  it("persists idempotently and rejects operation-ID content conflicts", async () => {
    const input = writeCommand();
    await expect(repository.record(input)).resolves.toMatchObject({
      created: true,
      memory: { memoryId: input.memoryId },
    });
    await expect(repository.record(input)).resolves.toMatchObject({
      created: false,
      memory: { memoryId: input.memoryId },
    });
    await expect(
      repository.record({ ...input, summary: "Conflicting replay." }),
    ).rejects.toMatchObject({ code: "WORLD_MEMORY_IDEMPOTENCY_CONFLICT" });
  });

  it("enforces subject ACLs inside one server and returns no cross-server facts", async () => {
    const restricted = writeCommand({
      kind: "base",
      summary: "Restricted base record.",
      visibility: "restricted",
      allowedSubjectIds: ["scout-01"],
      modelAccess: false,
      embedding: null,
    });
    const otherServer = writeCommand({
      serverProfileId: "server-beta",
      summary: "Different server iron vein.",
    });
    await repository.record(restricted);
    await repository.record(otherServer);

    const baseQuery = {
      serverProfileId: "server-alpha",
      dimension: "minecraft:overworld",
      kinds: [],
      tags: [],
      minimumConfidence: 0,
      observedAfter: null,
      center: null,
      semantic: null,
      modelAccessOnly: false,
      limit: 50,
    } as const;
    const sourceView = await repository.search({
      ...baseQuery,
      subjectId: "scout-01",
    });
    expect(sourceView.some(({ memory }) => memory.memoryId === restricted.memoryId)).toBe(true);
    expect(sourceView.every(({ memory }) => memory.serverProfileId === "server-alpha")).toBe(true);

    const teammateView = await repository.search({
      ...baseQuery,
      subjectId: "worker-02",
    });
    expect(teammateView.some(({ memory }) => memory.memoryId === restricted.memoryId)).toBe(false);
    expect(teammateView.every(({ memory }) => memory.serverProfileId === "server-alpha")).toBe(true);
  });

  it("filters model context before exact pgvector cosine ranking", async () => {
    const orthogonal = writeCommand({
      summary: "Coal vein west of the ridge.",
      tags: ["coal"],
      embedding: {
        model: "integration-embedding-v1",
        values: [0, 1, 0],
      },
    });
    await repository.record(orthogonal);
    const results = await repository.search({
      serverProfileId: "server-alpha",
      dimension: "minecraft:overworld",
      subjectId: "worker-02",
      kinds: ["resource"],
      tags: [],
      minimumConfidence: 0,
      observedAfter: null,
      center: null,
      semantic: {
        model: "integration-embedding-v1",
        values: [1, 0, 0],
      },
      modelAccessOnly: true,
      limit: 20,
    });
    expect(results[0]?.memory.summary).toBe("Iron vein below the ridge.");
    expect(results[0]?.cosineDistance).toBeCloseTo(0, 6);
    expect(results.every(({ memory }) => memory.kind !== "base")).toBe(true);
    expect(results.every(({ memory }) => memory.serverProfileId === "server-alpha")).toBe(true);
  });

  it("rejects cross-server supersession at the database boundary", async () => {
    const original = writeCommand({ summary: "Portal observation." });
    await repository.record(original);
    await expect(
      repository.record(
        writeCommand({
          serverProfileId: "server-beta",
          supersedesMemoryId: original.memoryId,
          summary: "Invalid cross-server correction.",
        }),
      ),
    ).rejects.toMatchObject({ code: "POSTGRES_QUERY_FAILED" });
  });

  it("rejects update and delete because facts are immutable", async () => {
    const input = writeCommand({ summary: "Immutable landmark." });
    await repository.record(input);
    await expect(
      assertionPool.query(
        "UPDATE studio_world_memory SET summary = 'changed' WHERE memory_id = $1",
        [input.memoryId],
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      assertionPool.query(
        "DELETE FROM studio_world_memory WHERE memory_id = $1",
        [input.memoryId],
      ),
    ).rejects.toThrow(/immutable/u);
  });
});
