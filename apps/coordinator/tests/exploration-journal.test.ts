import { mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExplorationJournal } from "../src/exploration-journal.js";

const now = Date.parse("2026-09-06T00:00:00Z");
const input = { serverProfileId: "isolated", dimension: "minecraft:overworld", center: { x: -1, z: 0 }, radiusChunks: 1 };
const output = { completed: false, status: "BATCH_LIMIT", visited: [{ x: -1, z: 0 }], newlyObserved: 1, observedAt: new Date(now).toISOString() };
describe("exploration checkpoints", () => {
  it("rejects oversized cache files before parsing and preserves the original", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "exploration-")), "cache.json");
    const handle = await open(file, "w");
    await handle.truncate(17 * 1024 * 1024);
    await handle.close();
    const journal = new ExplorationJournal(file, () => now);
    await journal.initialize();
    expect(journal.health()).toMatchObject({ entries: 0, errorCode: "EXPLORATION_CACHE_LOAD_FAILED" });
  });
  it("restores observations after restart, with server, dimension and age isolation", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "exploration-")), "cache.json");
    const journal = new ExplorationJournal(file, () => now);
    await journal.recordReceipt(input, output);
    const restored = new ExplorationJournal(file, () => now);
    await restored.initialize();
    expect(restored.list(input.serverProfileId, input.dimension, input.center, 1)).toEqual(output.visited);
    expect(restored.has("another", input.dimension, -1, 0)).toBe(false);
    expect(restored.has(input.serverProfileId, "minecraft:the_nether", -1, 0)).toBe(false);
    const stale = new ExplorationJournal(file, () => now + 86_400_001);
    await stale.initialize();
    expect(stale.has(input.serverProfileId, input.dimension, -1, 0)).toBe(false);
  });
  it("preserves corrupt evidence and exposes degraded persistence", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "exploration-")), "cache.json");
    await writeFile(file, "invalid");
    const journal = new ExplorationJournal(file, () => now);
    await journal.recordReceipt(input, output);
    expect(journal.health().errorCode).toBe("EXPLORATION_CACHE_LOAD_FAILED");
    expect(await readFile(file, "utf8")).toBe("invalid");
  });
  it("rejects future, out of area, excluded and malformed receipts before mutation", async () => {
    const journal = new ExplorationJournal(null, () => now);
    await expect(journal.recordReceipt(input, { ...output, observedAt: new Date(now + 1).toISOString() })).rejects.toThrow("STALE");
    await expect(journal.recordReceipt(input, { ...output, visited: [{ x: 9, z: 0 }] })).rejects.toThrow("SCOPE_MISMATCH");
    await expect(journal.recordReceipt({ ...input, excluded: output.visited }, output)).rejects.toThrow("SCOPE_MISMATCH");
    await expect(journal.recordReceipt(input, { ...output, observedAt: "invalid" })).rejects.toThrow();
    expect(journal.health().entries).toBe(0);
  });
  it("serializes concurrent writes without losing different servers' observations", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "exploration-")), "cache.json");
    const journal = new ExplorationJournal(file, () => now);
    await Promise.all([journal.recordReceipt(input, output), journal.recordReceipt({ ...input, serverProfileId: "second" }, output)]);
    const restored = new ExplorationJournal(file, () => now);
    await restored.initialize();
    expect(restored.health()).toMatchObject({ entries: 2, errorCode: null });
  });
});
