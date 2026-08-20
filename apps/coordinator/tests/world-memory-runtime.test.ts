import { describe, expect, it } from "vitest";

import {
  CoordinatorWorldMemoryError,
  CoordinatorWorldMemoryIngestionHealth,
  loadCoordinatorWorldMemoryConfig,
} from "../src/index.js";

describe("Coordinator world-memory configuration", () => {
  it("is disabled by default and rejects ambiguous enablement", () => {
    expect(loadCoordinatorWorldMemoryConfig({})).toEqual({ enabled: false });
    expect(() =>
      loadCoordinatorWorldMemoryConfig({ WORLD_MEMORY_ENABLED: "yes" }),
    ).toThrow(CoordinatorWorldMemoryError);
  });

  it("accepts a bounded loopback PostgreSQL configuration", () => {
    expect(
      loadCoordinatorWorldMemoryConfig({
        WORLD_MEMORY_ENABLED: "true",
        WORLD_MEMORY_POSTGRES_URL:
          "postgresql://studio:secret@127.0.0.1:5432/minecraft_studio",
        WORLD_MEMORY_SCHEMA: "studio_memory",
        WORLD_MEMORY_MAX_ENTRIES: "16",
        WORLD_MEMORY_RADIUS: "8192",
        WORLD_MEMORY_MIN_CONFIDENCE: "0.35",
        WORLD_MEMORY_INGESTION_SPOOL_DIR:
          "/var/lib/minecraft-studio/world-memory-ingestion",
        WORLD_MEMORY_INGESTION_BATCH_SIZE: "20",
        WORLD_MEMORY_INGESTION_MAX_PENDING_BATCHES: "5000",
        WORLD_MEMORY_INGESTION_POLL_INTERVAL_MS: "2000",
        WORLD_MEMORY_INGESTION_RETRY_BASE_MS: "500",
        WORLD_MEMORY_INGESTION_RETRY_MAX_MS: "30000",
      }),
    ).toEqual({
      enabled: true,
      postgresUrl:
        "postgresql://studio:secret@127.0.0.1:5432/minecraft_studio",
      schemaName: "studio_memory",
      maxEntries: 16,
      radius: 8192,
      minimumConfidence: 0.35,
      ingestionSpoolDirectory:
        "/var/lib/minecraft-studio/world-memory-ingestion",
      ingestionBatchSize: 20,
      ingestionMaxPendingBatches: 5000,
      ingestionPollIntervalMs: 2000,
      ingestionRetryBaseMs: 500,
      ingestionRetryMaxMs: 30000,
    });
  });

  it.each([
    ["postgresql://studio:secret@db.internal:5432/studio", "remote host"],
    ["postgresql://studio:secret@127.0.0.1:5432/", "missing database"],
    ["https://127.0.0.1/studio", "wrong protocol"],
    ["postgresql://127.0.0.1/studio?sslmode=disable", "query data"],
  ])("rejects %s (%s)", (url) => {
    expect(() =>
      loadCoordinatorWorldMemoryConfig({
        WORLD_MEMORY_ENABLED: "true",
        WORLD_MEMORY_POSTGRES_URL: url,
      }),
    ).toThrow(/loopback database URL/u);
  });

  it("rejects unsafe schema identifiers and unbounded retrieval", () => {
    const base = {
      WORLD_MEMORY_ENABLED: "true",
      WORLD_MEMORY_POSTGRES_URL:
        "postgresql://studio@127.0.0.1:5432/studio",
      WORLD_MEMORY_INGESTION_SPOOL_DIR:
        "/var/lib/minecraft-studio/world-memory-ingestion",
    };
    expect(() =>
      loadCoordinatorWorldMemoryConfig({
        ...base,
        WORLD_MEMORY_SCHEMA: "public; DROP SCHEMA public",
      }),
    ).toThrow(/safe unquoted/u);
    expect(() =>
      loadCoordinatorWorldMemoryConfig({
        ...base,
        WORLD_MEMORY_MAX_ENTRIES: "33",
      }),
    ).toThrow(/between 1 and 32/u);
  });

  it("requires a bounded, absolute durable ingestion spool", () => {
    const base = {
      WORLD_MEMORY_ENABLED: "true",
      WORLD_MEMORY_POSTGRES_URL:
        "postgresql://studio@127.0.0.1:5432/studio",
    };
    expect(() => loadCoordinatorWorldMemoryConfig(base)).toThrow(
      /INGESTION_SPOOL_DIR is required/u,
    );
    expect(() =>
      loadCoordinatorWorldMemoryConfig({
        ...base,
        WORLD_MEMORY_INGESTION_SPOOL_DIR: "runtime-data/memory",
      }),
    ).toThrow(/non-root absolute path/u);
    expect(() =>
      loadCoordinatorWorldMemoryConfig({
        ...base,
        WORLD_MEMORY_INGESTION_SPOOL_DIR: "/var/lib/studio/memory",
        WORLD_MEMORY_INGESTION_RETRY_BASE_MS: "2000",
        WORLD_MEMORY_INGESTION_RETRY_MAX_MS: "1000",
      }),
    ).toThrow(/retry base must not exceed/u);
  });

  it("fails planning closed until a durable ingestion backlog is cleared", () => {
    const health = new CoordinatorWorldMemoryIngestionHealth();
    expect(() => health.assertPlanningAllowed()).not.toThrow();

    health.noteIngestion({ deferredCount: 1, pendingBatchCount: 1 });
    expect(() => health.assertPlanningAllowed()).toThrow(
      /backlog must recover/u,
    );
    health.noteReconcile({ failed: 0, pendingBatchCount: 1 });
    expect(() => health.assertPlanningAllowed()).toThrow(
      /backlog must recover/u,
    );
    health.noteReconcile({ failed: 0, pendingBatchCount: 0 });
    expect(() => health.assertPlanningAllowed()).not.toThrow();

    health.noteFailure();
    expect(() => health.assertPlanningAllowed()).toThrow(
      /backlog must recover/u,
    );
  });
});
