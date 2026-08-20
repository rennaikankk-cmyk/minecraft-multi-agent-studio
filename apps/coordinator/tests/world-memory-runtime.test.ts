import { describe, expect, it } from "vitest";

import {
  CoordinatorWorldMemoryError,
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
      }),
    ).toEqual({
      enabled: true,
      postgresUrl:
        "postgresql://studio:secret@127.0.0.1:5432/minecraft_studio",
      schemaName: "studio_memory",
      maxEntries: 16,
      radius: 8192,
      minimumConfidence: 0.35,
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
        "postgresql://studio:secret@127.0.0.1:5432/studio",
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
});
