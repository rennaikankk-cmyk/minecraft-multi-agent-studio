import { describe, expect, it } from "vitest";

import {
  InMemoryWorldMemoryRepository,
  WorldMemoryAccessError,
  worldMemoryRecordSchema,
  type WorldMemoryRecord,
} from "../src/index.js";

const PROFILE_A = "server-a";
const PROFILE_B = "server-b";
const DIMENSION = "minecraft:overworld";

function record(
  serverProfileId: string,
  overrides: Partial<WorldMemoryRecord> = {},
): WorldMemoryRecord {
  return {
    serverProfileId,
    dimension: DIMENSION,
    position: { x: 100, y: 64, z: 200 },
    kind: "SAFE_SITE",
    observedAt: "2026-08-22T00:00:00.000Z",
    confidence: 0.9,
    staleAfterMs: 60_000,
    payload: { source: "isolated-test" },
    ...overrides,
  };
}

describe("world memory schema", () => {
  it("rejects records missing any server/dimension/position coordinate scope", () => {
    expect(() => worldMemoryRecordSchema.parse({
      ...record(PROFILE_A),
      serverProfileId: undefined,
    })).toThrow();
    expect(() => worldMemoryRecordSchema.parse({
      ...record(PROFILE_A),
      dimension: undefined,
    })).toThrow();
    expect(() => worldMemoryRecordSchema.parse({
      ...record(PROFILE_A),
      position: { x: 100, y: 64 },
    })).toThrow();
  });

  it("rejects unknown top-level fields while retaining the explicit payload contract", () => {
    expect(() => worldMemoryRecordSchema.parse({
      ...record(PROFILE_A),
      accidentalField: "must not cross the boundary",
    })).toThrow();
    expect(worldMemoryRecordSchema.parse(record(PROFILE_A)).payload).toEqual({
      source: "isolated-test",
    });
    expect(() => worldMemoryRecordSchema.parse({
      ...record(PROFILE_A),
      payload: { invalid: () => "not JSON" },
    })).toThrow();
  });
});

describe("InMemoryWorldMemoryRepository", () => {
  it("requires an active server before writes or reads", () => {
    const repository = new InMemoryWorldMemoryRepository({ nowMs: () => 0 });
    expect(() => repository.put(record(PROFILE_A))).toThrowError(
      WorldMemoryAccessError,
    );
    expect(() => repository.findByKind(PROFILE_A, "SAFE_SITE")).toThrowError(
      WorldMemoryAccessError,
    );
  });

  it("structurally blocks cross-server reads after switching profiles", () => {
    let nowMs = Date.parse("2026-08-22T00:00:00.000Z");
    const repository = new InMemoryWorldMemoryRepository({ nowMs: () => nowMs });
    repository.switchServer(PROFILE_A);
    repository.put(record(PROFILE_A));

    repository.switchServer(PROFILE_B);
    expect(repository.findAtPosition(
      PROFILE_B,
      DIMENSION,
      { x: 100, y: 64, z: 200 },
    )).toEqual([]);
    expect(() => repository.findAtPosition(
      PROFILE_A,
      DIMENSION,
      { x: 100, y: 64, z: 200 },
    )).toThrowError(
      expect.objectContaining({ code: "WORLD_MEMORY_SERVER_SCOPE_MISMATCH" }),
    );

    nowMs += 1;
    repository.switchServer(PROFILE_A);
    expect(repository.findAtPosition(
      PROFILE_A,
      DIMENSION,
      { x: 100, y: 64, z: 200 },
    )).toHaveLength(1);
  });

  it("clears the active scope on disconnect and denies access until reconnect", () => {
    const repository = new InMemoryWorldMemoryRepository({ nowMs: () => 0 });
    const events: unknown[] = [];
    repository.onServerSwitch((event) => events.push(event));
    repository.switchServer(PROFILE_A);
    repository.put(record(PROFILE_A));

    repository.disconnectServer();

    expect(repository.activeServerProfileId).toBeNull();
    expect(events.at(-1)).toEqual({
      previousServerProfileId: PROFILE_A,
      nextServerProfileId: null,
    });
    expect(() => repository.findByKind(PROFILE_A, "SAFE_SITE")).toThrowError(
      expect.objectContaining({ code: "WORLD_MEMORY_SERVER_NOT_SELECTED" }),
    );
    expect(() => repository.put(record(PROFILE_A))).toThrowError(
      expect.objectContaining({ code: "WORLD_MEMORY_SERVER_NOT_SELECTED" }),
    );

    repository.switchServer(PROFILE_A);
    expect(repository.findByKind(PROFILE_A, "SAFE_SITE")).toHaveLength(1);
  });

  it("emits a switch event for the task layer without cancelling tasks itself", () => {
    const repository = new InMemoryWorldMemoryRepository({ nowMs: () => 0 });
    const events: unknown[] = [];
    const unsubscribe = repository.onServerSwitch((event) => events.push(event));
    repository.switchServer(PROFILE_A);
    repository.switchServer(PROFILE_B);
    repository.switchServer(PROFILE_B);
    unsubscribe();
    repository.switchServer(PROFILE_A);

    expect(events).toEqual([
      { previousServerProfileId: null, nextServerProfileId: PROFILE_A },
      { previousServerProfileId: PROFILE_A, nextServerProfileId: PROFILE_B },
    ]);
  });

  it("labels records fresh, stale, and future timestamps fail-closed", () => {
    const nowMs = Date.parse("2026-08-22T00:01:00.000Z");
    const repository = new InMemoryWorldMemoryRepository({ nowMs: () => nowMs });
    repository.switchServer(PROFILE_A);
    repository.put(record(PROFILE_A, {
      observedAt: "2026-08-22T00:00:00.000Z",
      staleAfterMs: 59_999,
      payload: { id: "stale" },
    }));
    repository.put(record(PROFILE_A, {
      observedAt: "2026-08-22T00:00:30.000Z",
      payload: { id: "fresh" },
    }));
    repository.put(record(PROFILE_A, {
      observedAt: "2026-08-22T00:02:00.000Z",
      payload: { id: "future" },
    }));

    const results = repository.findByKind(PROFILE_A, "SAFE_SITE");
    expect(results.map((item) => [item.payload.id, item.freshness])).toEqual([
      ["stale", "stale"],
      ["fresh", "fresh"],
      ["future", "stale"],
    ]);
    expect(results[0]?.ageMs).toBe(60_000);
    expect(results[1]?.ageMs).toBe(30_000);
    expect(results[2]?.ageMs).toBe(-60_000);
  });

  it("does not allow nested caller mutations to change stored facts", () => {
    const repository = new InMemoryWorldMemoryRepository({ nowMs: () => 0 });
    repository.switchServer(PROFILE_A);
    const input = record(PROFILE_A, { payload: { nested: { value: 1 } } });
    repository.put(input);
    (input.payload as Record<string, unknown>)["nested"] = { value: 99 };

    const result = repository.findByKind(PROFILE_A, "SAFE_SITE");
    (result[0]!.payload as Record<string, unknown>)["nested"] = { value: 42 };
    expect(repository.findByKind(PROFILE_A, "SAFE_SITE")[0]?.payload).toEqual({
      nested: { value: 1 },
    });
  });

  it("rejects a backwards repository clock but accepts delayed observations", () => {
    let nowMs = 1_000;
    const repository = new InMemoryWorldMemoryRepository({ nowMs: () => nowMs });
    repository.switchServer(PROFILE_A);
    repository.put(record(PROFILE_A, {
      observedAt: "1970-01-01T00:16:40.000Z",
    }));

    nowMs = 999;
    expect(() => repository.findByKind(PROFILE_A, "SAFE_SITE")).toThrowError(
      RangeError,
    );

    nowMs = 1_000;
    expect(() => repository.put(record(PROFILE_A, {
      observedAt: "1970-01-01T00:16:39.000Z",
    }))).not.toThrow();
  });

  it("filters by kind, dimension, and Euclidean radius", () => {
    const repository = new InMemoryWorldMemoryRepository({ nowMs: () => 100_000 });
    repository.switchServer(PROFILE_A);
    repository.put(record(PROFILE_A, { kind: "HAZARD" }));
    repository.put(record(PROFILE_A, {
      kind: "VILLAGER",
      position: { x: 103, y: 64, z: 200 },
    }));
    repository.put(record(PROFILE_A, {
      kind: "VILLAGER",
      dimension: "minecraft:the_nether",
      position: { x: 101, y: 64, z: 200 },
    }));

    expect(repository.findNearby(
      PROFILE_A,
      DIMENSION,
      { x: 100, y: 64, z: 200 },
      2,
      { kind: "VILLAGER" },
    )).toEqual([]);
    expect(repository.findNearby(
      PROFILE_A,
      DIMENSION,
      { x: 100, y: 64, z: 200 },
      3,
      { kind: "VILLAGER" },
    )).toHaveLength(1);
  });

  it("rejects a radius whose square overflows instead of broadening the query", () => {
    const repository = new InMemoryWorldMemoryRepository({ nowMs: () => 0 });
    repository.switchServer(PROFILE_A);

    expect(() => repository.findNearby(
      PROFILE_A,
      DIMENSION,
      { x: 100, y: 64, z: 200 },
      Number.MAX_VALUE,
    )).toThrowError(RangeError);
  });
  it("bounds query results and rejects invalid limits", () => {
    const repository = new InMemoryWorldMemoryRepository({ nowMs: () => 0 });
    repository.switchServer(PROFILE_A);
    for (let index = 0; index < 105; index += 1) {
      repository.put(record(PROFILE_A, {
        payload: { index },
      }));
    }

    expect(repository.findByKind(PROFILE_A, "SAFE_SITE")).toHaveLength(100);
    expect(repository.findByKind(
      PROFILE_A,
      "SAFE_SITE",
      { limit: 2 },
    )).toHaveLength(2);
    expect(() => repository.findByKind(
      PROFILE_A,
      "SAFE_SITE",
      { limit: 0 },
    )).toThrowError(RangeError);
    expect(() => repository.findNearby(
      PROFILE_A,
      DIMENSION,
      { x: 100, y: 64, z: 200 },
      1,
      { limit: 501 },
    )).toThrowError(RangeError);
  });
});
