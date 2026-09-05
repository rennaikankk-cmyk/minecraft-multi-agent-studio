import { afterEach, describe, expect, it, vi } from "vitest";
import { NearbyBlockScanner } from "../src/nearby-block-scanner.js";
import { importantBlockNames, type NearbyBlockState, type WorldPosition } from "../src/world-state.js";

const origin: WorldPosition = { serverProfileId: "isolated", dimension: "minecraft:overworld", x: 0, y: 65, z: 0 };
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const query = vi.fn((name: string, position: WorldPosition): readonly NearbyBlockState[] => name === "furnace"
    ? [{ name, position, lastSeen: new Date().toISOString(), reachable: true, source: "observation", confidence: 1 }] : []);
  const scopeMatches = vi.fn(() => true);
  const scanner = new NearbyBlockScanner({ query, scopeMatches, now: Date.now }, 1_000);
  return { scanner, query, scopeMatches };
}
afterEach(() => vi.useRealTimers());

describe("cooperative nearby block observations", () => {
  it("yields between queries and publishes only the complete scan", async () => {
    const f = fixture();
    expect(f.scanner.read(origin)).toEqual([]);
    expect(f.query).not.toHaveBeenCalled();
    await vi.advanceTimersToNextTimerAsync();
    expect(f.query.mock.calls.length).toBeGreaterThan(0);
    expect(f.query.mock.calls.length).toBeLessThan(importantBlockNames.length);
    expect(f.scanner.read(origin)).toEqual([]);
    await vi.runAllTimersAsync();
    expect(f.query).toHaveBeenCalledTimes(importantBlockNames.length);
    expect(f.scanner.read(origin)).toMatchObject([{ name: "furnace" }]);
    expect(f.query).toHaveBeenCalledTimes(importantBlockNames.length);
  });
  it("discards pending results after switching server or dimension", async () => {
    const f = fixture();
    f.scanner.read(origin);
    await vi.advanceTimersToNextTimerAsync();
    const destination = { ...origin, serverProfileId: "another", dimension: "minecraft:the_nether" };
    expect(f.scanner.read(destination)).toEqual([]);
    await vi.runAllTimersAsync();
    expect(f.scanner.read(destination)).toMatchObject([{ position: destination }]);
  });
  it("stops pending queries on disconnect", async () => {
    const f = fixture();
    f.scanner.read(origin);
    f.scanner.reset();
    await vi.runAllTimersAsync();
    expect(f.query).not.toHaveBeenCalled();
  });
  it("retains original observation timestamps when refresh fails", async () => {
    const f = fixture();
    f.scanner.read(origin);
    await vi.runAllTimersAsync();
    const previous = f.scanner.read(origin);
    vi.advanceTimersByTime(1_000);
    f.query.mockImplementation(() => { throw new Error("chunk unavailable"); });
    expect(f.scanner.read(origin)).toBe(previous);
    await vi.runAllTimersAsync();
    expect(f.scanner.read(origin)).toBe(previous);
  });
});
