import { describe, expect, it } from "vitest";

import {
  WorldMemoryPlannerContextService,
  type WorldMemoryQuery,
  type WorldMemoryRecord,
  type WorldMemoryRepositoryLike,
  type WorldMemorySearchResult,
} from "../src/index.js";

function memory(
  overrides: Partial<WorldMemoryRecord> = {},
): WorldMemoryRecord {
  return {
    schemaVersion: "1.0",
    operationId: "11111111-1111-4111-8111-111111111111",
    memoryId: "22222222-2222-4222-8222-222222222222",
    serverProfileId: "server-alpha",
    dimension: "minecraft:overworld",
    position: { x: 100, y: 64, z: 100 },
    kind: "hazard",
    summary: "Lava pool blocks the eastern tunnel.",
    tags: ["lava"],
    confidence: 0.9,
    visibility: "team",
    allowedSubjectIds: [],
    modelAccess: true,
    sourceBotId: "scout-01",
    sourceTaskId: null,
    traceId: "trace-memory",
    observedAt: "2026-08-20T08:00:00.000Z",
    expiresAt: null,
    supersedesMemoryId: null,
    embeddingModel: null,
    embeddingDimensions: null,
    createdAt: "2026-08-20T08:00:01.000Z",
    ...overrides,
  };
}

function result(
  overrides: Partial<WorldMemoryRecord> = {},
): WorldMemorySearchResult {
  return {
    memory: memory(overrides),
    distance: 25,
    cosineDistance: null,
  };
}

class FakeRepository implements WorldMemoryRepositoryLike {
  queries: WorldMemoryQuery[] = [];
  constructor(private readonly results: readonly WorldMemorySearchResult[]) {}
  async search(query: WorldMemoryQuery) {
    this.queries.push(query);
    return this.results;
  }
}

const request = {
  serverProfileId: "server-alpha",
  dimension: "minecraft:overworld",
  position: { x: 0, y: 64, z: 0 },
  subjectId: "worker-01",
  task: "Find a safe iron route",
} as const;

describe("WorldMemoryPlannerContextService", () => {
  it("returns only same-world model-safe summaries and never exact coordinates", async () => {
    const repository = new FakeRepository([
      result(),
      result({
        memoryId: "33333333-3333-4333-8333-333333333333",
        kind: "base",
        modelAccess: false,
        summary: "Secret base at x=5 y=64 z=9.",
      }),
      result({
        memoryId: "44444444-4444-4444-8444-444444444444",
        serverProfileId: "server-beta",
        summary: "A fact from a different server.",
      }),
    ]);
    const service = new WorldMemoryPlannerContextService(repository, {
      maxEntries: 4,
      radius: 512,
    });

    await expect(service.retrieve(request)).resolves.toEqual([
      "[hazard; confidence=0.90] Lava pool blocks the eastern tunnel.",
    ]);
    expect(repository.queries).toEqual([
      expect.objectContaining({
        serverProfileId: "server-alpha",
        dimension: "minecraft:overworld",
        subjectId: "worker-01",
        modelAccessOnly: true,
        center: { x: 0, y: 64, z: 0, radius: 512 },
      }),
    ]);
  });

  it("uses bounded embedding search and accepts only candidate IDs from a reranker", async () => {
    const secondId = "33333333-3333-4333-8333-333333333333";
    const repository = new FakeRepository([
      result(),
      result({ memoryId: secondId, kind: "resource", summary: "Iron nearby." }),
    ]);
    const service = new WorldMemoryPlannerContextService(repository, {
      maxEntries: 2,
      embeddingProvider: {
        model: "embedding-v1",
        embed: async () => [1, 0, 0],
      },
      reranker: {
        rerank: async () => [secondId],
      },
    });

    await expect(service.retrieve(request)).resolves.toEqual([
      "[resource; confidence=0.90] Iron nearby.",
    ]);
    expect(repository.queries[0]?.semantic).toEqual({
      model: "embedding-v1",
      values: [1, 0, 0],
    });
  });

  it("fails closed when a reranker injects an unknown record", async () => {
    const service = new WorldMemoryPlannerContextService(
      new FakeRepository([result(), result({ memoryId: "33333333-3333-4333-8333-333333333333" })]),
      {
        reranker: {
          rerank: async () => ["99999999-9999-4999-8999-999999999999"],
        },
      },
    );
    await expect(service.retrieve(request)).rejects.toMatchObject({
      code: "WORLD_MEMORY_LOOKUP_FAILED",
    });
  });

  it("cancels before accessing storage", async () => {
    const repository = new FakeRepository([result()]);
    const service = new WorldMemoryPlannerContextService(repository);
    const controller = new AbortController();
    controller.abort("newer_state");
    await expect(
      service.retrieve({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "WORLD_MEMORY_LOOKUP_CANCELLED" });
    expect(repository.queries).toHaveLength(0);
  });
});
