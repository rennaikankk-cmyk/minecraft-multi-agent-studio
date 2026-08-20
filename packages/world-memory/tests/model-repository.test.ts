import { randomUUID } from "node:crypto";

import type {
  PostgresClientLike,
  PostgresPoolLike,
  SqlQueryResult,
} from "@minecraft-studio/task-system";
import { describe, expect, it } from "vitest";

import {
  PostgresWorldMemoryRepository,
  worldMemoryOperationFingerprint,
  worldMemoryQuerySchema,
  worldMemoryWriteCommandSchema,
  type WorldMemoryWriteCommand,
} from "../src/index.js";

const NOW = "2026-08-20T08:00:00.000Z";

function command(
  overrides: Partial<WorldMemoryWriteCommand> = {},
): WorldMemoryWriteCommand {
  return {
    schemaVersion: "1.0",
    operationId: "11111111-1111-4111-8111-111111111111",
    memoryId: "22222222-2222-4222-8222-222222222222",
    serverProfileId: "server-alpha",
    dimension: "minecraft:overworld",
    position: { x: 12, y: 64, z: -4 },
    kind: "resource",
    summary: "Iron vein observed below the ridge.",
    tags: ["iron", "ridge"],
    confidence: 0.9,
    visibility: "team",
    allowedSubjectIds: [],
    modelAccess: true,
    sourceBotId: "scout-01",
    sourceTaskId: "task-01",
    traceId: "trace-memory-01",
    observedAt: NOW,
    expiresAt: null,
    supersedesMemoryId: null,
    embedding: { model: "test-embedding-v1", values: [1, 0, 0] },
    ...overrides,
  };
}

function row(
  input: WorldMemoryWriteCommand,
  fingerprint = worldMemoryOperationFingerprint(input),
): Record<string, unknown> {
  return {
    schema_version: input.schemaVersion,
    operation_id: input.operationId,
    operation_fingerprint: fingerprint,
    memory_id: input.memoryId,
    server_profile_id: input.serverProfileId,
    dimension: input.dimension,
    position_x: input.position.x,
    position_y: input.position.y,
    position_z: input.position.z,
    kind: input.kind,
    summary: input.summary,
    tags: [...input.tags].sort(),
    confidence: input.confidence,
    visibility: input.visibility,
    allowed_subject_ids: [...input.allowedSubjectIds].sort(),
    model_access: input.modelAccess,
    source_bot_id: input.sourceBotId,
    source_task_id: input.sourceTaskId,
    trace_id: input.traceId,
    observed_at: new Date(input.observedAt),
    expires_at: input.expiresAt === null ? null : new Date(input.expiresAt),
    supersedes_memory_id: input.supersedesMemoryId,
    embedding_model: input.embedding?.model ?? null,
    embedding_dimensions: input.embedding?.values.length ?? null,
    created_at: new Date(NOW),
  };
}

type QueryHandler = (
  text: string,
  values: readonly unknown[],
) => SqlQueryResult<Record<string, unknown>>;

class FakeClient implements PostgresClientLike {
  readonly queries: Array<Readonly<{ text: string; values: readonly unknown[] }>> = [];
  released = false;

  constructor(private readonly handler: QueryHandler) {}

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<TRow>> {
    this.queries.push({ text, values });
    return this.handler(text, values) as SqlQueryResult<TRow>;
  }

  release(): void {
    this.released = true;
  }
}

class FakePool implements PostgresPoolLike {
  constructor(readonly client: FakeClient) {}
  async connect(): Promise<PostgresClientLike> {
    return this.client;
  }
}

const emptyResult: SqlQueryResult<Record<string, unknown>> = {
  rows: [],
  rowCount: 0,
};

describe("world memory schemas", () => {
  it("requires server, dimension, and complete coordinates for every record and query", () => {
    expect(() =>
      worldMemoryWriteCommandSchema.parse({
        ...command(),
        serverProfileId: undefined,
      }),
    ).toThrow();
    expect(() =>
      worldMemoryWriteCommandSchema.parse({
        ...command(),
        position: { x: 1, z: 2 },
      }),
    ).toThrow();
    expect(() =>
      worldMemoryQuerySchema.parse({
        dimension: "minecraft:overworld",
        subjectId: "scout-01",
        kinds: [],
        tags: [],
        minimumConfidence: 0,
        observedAfter: null,
        center: null,
        semantic: null,
        modelAccessOnly: false,
        limit: 10,
      }),
    ).toThrow();
  });

  it("prevents sensitive or restricted facts from entering model prompts", () => {
    expect(() =>
      worldMemoryWriteCommandSchema.parse(
        command({ kind: "base", modelAccess: true }),
      ),
    ).toThrow(/cannot enter a model prompt/u);
    expect(() =>
      worldMemoryWriteCommandSchema.parse(
        command({
          visibility: "restricted",
          allowedSubjectIds: ["scout-01"],
          modelAccess: true,
        }),
      ),
    ).toThrow(/cannot enter a model prompt/u);
    expect(() =>
      worldMemoryWriteCommandSchema.parse(
        command({ embedding: { model: "test", values: [0, 0] } }),
      ),
    ).toThrow(/zero vector/u);
  });

  it("requires a restricted record to remain readable by its source Bot", () => {
    expect(() =>
      worldMemoryWriteCommandSchema.parse(
        command({
          visibility: "restricted",
          allowedSubjectIds: ["defender-01"],
          modelAccess: false,
        }),
      ),
    ).toThrow(/source Bot/u);
  });
});

describe("PostgresWorldMemoryRepository", () => {
  it("requires the memory table and pgvector 0.8 or newer", async () => {
    const readyClient = new FakeClient(() => ({
      rows: [{
        extension_version: "0.8.6",
        memory_table: "studio_world_memory",
      }],
      rowCount: 1,
    }));
    await expect(
      new PostgresWorldMemoryRepository(
        new FakePool(readyClient),
      ).verifySchema(),
    ).resolves.toBeUndefined();
    expect(readyClient.queries[0]?.text).toContain(
      "namespace.nspname = 'public'",
    );

    const oldClient = new FakeClient(() => ({
      rows: [{
        extension_version: "0.7.4",
        memory_table: "studio_world_memory",
      }],
      rowCount: 1,
    }));
    await expect(
      new PostgresWorldMemoryRepository(
        new FakePool(oldClient),
      ).verifySchema(),
    ).rejects.toMatchObject({ code: "WORLD_MEMORY_SCHEMA_UNAVAILABLE" });
  });

  it("canonicalizes unordered ACL and tag sets for idempotency", () => {
    const first = command({
      tags: ["ridge", "iron"],
      visibility: "restricted",
      allowedSubjectIds: ["scout-02", "scout-01"],
      modelAccess: false,
    });
    const second = {
      ...first,
      tags: ["iron", "ridge"],
      allowedSubjectIds: ["scout-01", "scout-02"],
    };
    expect(worldMemoryOperationFingerprint(first)).toBe(
      worldMemoryOperationFingerprint(second),
    );
  });

  it("creates once and returns an equivalent idempotent replay", async () => {
    const input = command();
    const storedRow = row(input);
    let insertCount = 0;
    const client = new FakeClient((text) => {
      if (text.includes("INSERT INTO studio_world_memory")) {
        insertCount += 1;
        return insertCount === 1
          ? { rows: [storedRow], rowCount: 1 }
          : emptyResult;
      }
      if (text.includes("WHERE m.operation_id")) {
        return { rows: [storedRow], rowCount: 1 };
      }
      return emptyResult;
    });
    const repository = new PostgresWorldMemoryRepository(
      new FakePool(client),
      () => new Date(NOW),
    );

    await expect(repository.record(input)).resolves.toMatchObject({
      created: true,
      memory: { memoryId: input.memoryId, serverProfileId: "server-alpha" },
    });
    await expect(repository.record(input)).resolves.toMatchObject({
      created: false,
      memory: { memoryId: input.memoryId },
    });
    expect(
      client.queries.find(({ text }) => text.includes("WHERE m.operation_id"))
        ?.text,
    ).toContain("m.operation_fingerprint");
    expect(client.released).toBe(true);
  });

  it("rejects an operation replay with different semantic content", async () => {
    const original = command();
    const client = new FakeClient((text) => {
      if (text.includes("INSERT INTO studio_world_memory")) return emptyResult;
      if (text.includes("WHERE m.operation_id")) {
        return { rows: [row(original)], rowCount: 1 };
      }
      return emptyResult;
    });
    const repository = new PostgresWorldMemoryRepository(new FakePool(client));
    await expect(
      repository.record(
        command({
          operationId: original.operationId,
          memoryId: randomUUID(),
          summary: "Different content under the same operation ID.",
        }),
      ),
    ).rejects.toMatchObject({ code: "WORLD_MEMORY_IDEMPOTENCY_CONFLICT" });
    expect(client.queries.some(({ text }) => text === "ROLLBACK")).toBe(true);
  });

  it("materializes same-world authorization filters before cosine distance", async () => {
    const input = command();
    const storedRow = {
      ...row(input),
      spatial_distance: 12.5,
      cosine_distance: 0.05,
    };
    const client = new FakeClient((text) =>
      text.includes("WITH permitted AS MATERIALIZED")
        ? { rows: [storedRow], rowCount: 1 }
        : emptyResult,
    );
    const repository = new PostgresWorldMemoryRepository(new FakePool(client));
    const result = await repository.search({
      serverProfileId: "server-alpha",
      dimension: "minecraft:overworld",
      subjectId: "scout-01",
      kinds: ["resource"],
      tags: ["iron"],
      minimumConfidence: 0.5,
      observedAfter: null,
      center: { x: 0, y: 64, z: 0, radius: 128 },
      semantic: {
        model: "test-embedding-v1",
        values: [1, 0, 0],
        maxCosineDistance: 0.4,
      },
      modelAccessOnly: true,
      limit: 10,
    });

    expect(result).toEqual([
      expect.objectContaining({
        distance: 12.5,
        cosineDistance: 0.05,
        memory: expect.objectContaining({ memoryId: input.memoryId }),
      }),
    ]);
    const search = client.queries.find(({ text }) =>
      text.includes("WITH permitted AS MATERIALIZED"),
    );
    expect(search?.text).toContain("m.server_profile_id = $1");
    expect(search?.text).toContain("m.dimension = $2");
    expect(search?.text).toContain("m.visibility = 'team'");
    expect(search?.text).toContain("m.embedding <=>");
    expect(search?.values.slice(0, 3)).toEqual([
      "server-alpha",
      "minecraft:overworld",
      "scout-01",
    ]);
  });
});
