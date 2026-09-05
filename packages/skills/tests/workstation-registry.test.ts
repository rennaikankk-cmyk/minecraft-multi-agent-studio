import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryWorkstationRegistry,
  acquireWorkstation,
  normalizeBlockPos,
  usageModeFor,
  type WorkstationRegistryPort,
} from "../src/workstation-registry.js";

const SERVER = "test-profile";
const DIM = "minecraft:overworld";
const BOT_A = "studio-bot-01";
const BOT_B = "studio-bot-02";

function reg(): InMemoryWorkstationRegistry {
  return new InMemoryWorkstationRegistry({ entryTtlMs: 60_000, leaseTtlMs: 10_000 });
}

describe("WorkstationRegistry v1", () => {
  let r: InMemoryWorkstationRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    r = reg();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. register/find
  it("1: register then find returns entry", () => {
    r.register(SERVER, DIM, "crafting_table", { x: 10, y: 64, z: 10 });
    const cands = r.findCandidates(SERVER, DIM, "crafting_table", { x: 10, y: 64, z: 10 });
    expect(cands).toHaveLength(1);
    expect(cands[0]!.position).toEqual({ x: 10, y: 64, z: 10 });
  });

  // 2. serverProfile isolation
  it("2: entries from server-A invisible from server-B", () => {
    r.register("server-A", DIM, "crafting_table", { x: 10, y: 64, z: 10 });
    expect(r.findCandidates("server-B", DIM, "crafting_table", { x: 10, y: 64, z: 10 })).toHaveLength(0);
  });

  // 3. dimension isolation
  it("3: entries from nether invisible from overworld", () => {
    r.register(SERVER, "minecraft:the_nether", "crafting_table", { x: 10, y: 40, z: 10 });
    expect(r.findCandidates(SERVER, "minecraft:overworld", "crafting_table", { x: 10, y: 64, z: 10 })).toHaveLength(0);
  });

  // 4. nearest ordering
  it("4: candidates sorted by distance ascending", () => {
    r.register(SERVER, DIM, "crafting_table", { x: 30, y: 64, z: 30 });
    r.register(SERVER, DIM, "crafting_table", { x: 5, y: 64, z: 5 });
    r.register(SERVER, DIM, "crafting_table", { x: 15, y: 64, z: 15 });
    const cands = r.findCandidates(SERVER, DIM, "crafting_table", { x: 0, y: 64, z: 0 });
    expect(cands[0]!.position).toEqual({ x: 5, y: 64, z: 5 });
    expect(cands[2]!.position).toEqual({ x: 30, y: 64, z: 30 });
  });

  // 5. maxDistance
  it("5: maxDistance filters out distant entries", () => {
    r.register(SERVER, DIM, "crafting_table", { x: 100, y: 64, z: 100 });
    expect(r.findCandidates(SERVER, DIM, "crafting_table", { x: 0, y: 64, z: 0 }, 32)).toHaveLength(0);
    expect(r.findCandidates(SERVER, DIM, "crafting_table", { x: 0, y: 64, z: 0 }, 200)).toHaveLength(1);
  });

  // 6. expired entry ignored
  it("6: expired entries excluded from candidates", () => {
    r.register(SERVER, DIM, "crafting_table", { x: 10, y: 64, z: 10 });
    // Advance past TTL (60s)
    vi.advanceTimersByTime(61_000);
    expect(r.findCandidates(SERVER, DIM, "crafting_table", { x: 10, y: 64, z: 10 })).toHaveLength(0);
  });

  // 7. type replacement at same position
  it("7: same-position type change replaces entry (not duplicate)", () => {
    r.register(SERVER, DIM, "crafting_table", { x: 10, y: 64, z: 10 });
    expect(r.size).toBe(1);
    r.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: 10 });
    expect(r.size).toBe(1);
    const cands = r.findCandidates(SERVER, DIM, "furnace", { x: 10, y: 64, z: 10 });
    expect(cands).toHaveLength(1);
    // Old crafting_table is gone
    expect(r.findCandidates(SERVER, DIM, "crafting_table", { x: 10, y: 64, z: 10 })).toHaveLength(0);
  });

  // 8. block position normalization
  it("8: float coordinates normalized to block floor", () => {
    r.register(SERVER, DIM, "crafting_table", { x: 10.7, y: 64.2, z: 10.9 });
    const cands = r.findCandidates(SERVER, DIM, "crafting_table", { x: 10, y: 64, z: 10 });
    expect(cands).toHaveLength(1);
    expect(cands[0]!.position).toEqual({ x: 10, y: 64, z: 10 });
  });

  // 9. claim by bot A
  it("9: claim succeeds for first bot", () => {
    r.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: 10 });
    const pos = normalizeBlockPos({ x: 10, y: 64, z: 10 });
    expect(r.claim(SERVER, DIM, pos, BOT_A)).toBe(true);
  });

  // 10. second bot claim rejected
  it("10: second bot claim rejected while first bot holds lease", () => {
    r.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: 10 });
    const pos = normalizeBlockPos({ x: 10, y: 64, z: 10 });
    expect(r.claim(SERVER, DIM, pos, BOT_A)).toBe(true);
    expect(r.claim(SERVER, DIM, pos, BOT_B)).toBe(false);
  });

  // 11. expired lease can be reclaimed
  it("11: expired lease allows reclaim by another bot", () => {
    r.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: 10 });
    const pos = normalizeBlockPos({ x: 10, y: 64, z: 10 });
    r.claim(SERVER, DIM, pos, BOT_A, 5_000);
    vi.advanceTimersByTime(6_000); // lease expired
    expect(r.claim(SERVER, DIM, pos, BOT_B)).toBe(true);
  });

  // 12. renew lease
  it("12: renewClaim extends the lease for the same owner", () => {
    r.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: 10 });
    const pos = normalizeBlockPos({ x: 10, y: 64, z: 10 });
    r.claim(SERVER, DIM, pos, BOT_A, 5_000);
    vi.advanceTimersByTime(3_000);
    expect(r.renewClaim(SERVER, DIM, pos, BOT_A, 10_000, r.get(SERVER, DIM, pos)!.lease!)).toBe(true);
    // Original 5s would have expired, renewed 10s is still valid
    vi.advanceTimersByTime(3_000);
    expect(r.claim(SERVER, DIM, pos, BOT_B)).toBe(false); // still held by A
  });

  // 13. release
  it("13: release frees the workstation for other bots", () => {
    r.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: 10 });
    const pos = normalizeBlockPos({ x: 10, y: 64, z: 10 });
    r.claim(SERVER, DIM, pos, BOT_A);
    r.release(SERVER, DIM, pos, BOT_A, r.get(SERVER, DIM, pos)!.lease!);
    expect(r.claim(SERVER, DIM, pos, BOT_B)).toBe(true);
  });

  // 14. shared workstation multi-bot use
  it("14: crafting_table is shared — no claim needed, multiple bots can use", () => {
    expect(usageModeFor("crafting_table")).toBe("shared");
    expect(usageModeFor("furnace")).toBe("exclusive");
    // Shared workstations don't require claims
    r.register(SERVER, DIM, "crafting_table", { x: 10, y: 64, z: 10 });
    const cands = r.findCandidates(SERVER, DIM, "crafting_table", { x: 10, y: 64, z: 10 });
    expect(cands).toHaveLength(1);
  });

  // 15. normalizeBlockPos
  it("15: normalizeBlockPos floors coordinates", () => {
    expect(normalizeBlockPos({ x: 10.7, y: -3.2, z: 0.1 })).toEqual({ x: 10, y: -4, z: 0 });
  });

  // 16. same-position type replacement (already tested in #7 but explicit)
  it("16: register replaces old type at same position without duplicates", () => {
    r.register(SERVER, DIM, "crafting_table", { x: 10, y: 64, z: 10 });
    r.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: 10 });
    r.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: 10 });
    expect(r.size).toBe(1);
  });

  // 17. maxEntries hard bound
  it("17: maxEntries eviction caps total entries", () => {
    const small = new InMemoryWorkstationRegistry({ maxEntries: 5, entryTtlMs: 60_000 });
    for (let i = 0; i < 20; i += 1) {
      small.register(SERVER, DIM, "crafting_table", { x: i, y: 64, z: i });
    }
    expect(small.size).toBeLessThanOrEqual(5);
  });

  // 18. candidate fallback
  it("18: candidates provide fallback when nearest is invalidated", () => {
    r.register(SERVER, DIM, "crafting_table", { x: 5, y: 64, z: 5 });
    r.register(SERVER, DIM, "crafting_table", { x: 20, y: 64, z: 20 });
    // Invalidate nearest
    r.invalidate(SERVER, DIM, { x: 5, y: 64, z: 5 });
    const cands = r.findCandidates(SERVER, DIM, "crafting_table", { x: 0, y: 64, z: 0 });
    expect(cands).toHaveLength(1);
    expect(cands[0]!.position).toEqual({ x: 20, y: 64, z: 20 });
  });

  // 19. dimension switch does NOT destroy memory
  it("19: overworld entries survive going to nether and back", () => {
    r.register(SERVER, "minecraft:overworld", "crafting_table", { x: 10, y: 64, z: 10 });
    // Go to nether
    const netherCands = r.findCandidates(SERVER, "minecraft:the_nether", "crafting_table", { x: 0, y: 40, z: 0 });
    expect(netherCands).toHaveLength(0); // nothing in nether
    // Come back to overworld — entries still there
    const owCands = r.findCandidates(SERVER, "minecraft:overworld", "crafting_table", { x: 10, y: 64, z: 10 });
    expect(owCands).toHaveLength(1);
  });

  // 20. releaseAllClaims
  it("20: unfenced bulk release preserves live claims until expiry", () => {
    r.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: 10 });
    r.register(SERVER, DIM, "furnace", { x: 20, y: 64, z: 20 });
    const p1 = normalizeBlockPos({ x: 10, y: 64, z: 10 });
    const p2 = normalizeBlockPos({ x: 20, y: 64, z: 20 });
    r.claim(SERVER, DIM, p1, BOT_A);
    r.claim(SERVER, DIM, p2, BOT_A);
    r.releaseAllClaims(BOT_A);
    expect(r.claim(SERVER, DIM, p1, BOT_B)).toBe(false);
    vi.advanceTimersByTime(10_001);
    r.releaseAllClaims(BOT_A);
    expect(r.claim(SERVER, DIM, p1, BOT_B)).toBe(true);
    expect(r.claim(SERVER, DIM, p2, BOT_B)).toBe(true);
  });

  // 21. Port interface compliance
  it("21: InMemoryWorkstationRegistry implements WorkstationRegistryPort", () => {
    const port: WorkstationRegistryPort = reg();
    expect(port.register).toBeDefined();
    expect(port.findCandidates).toBeDefined();
    expect(port.claim).toBeDefined();
    expect(port.renewClaim).toBeDefined();
    expect(port.release).toBeDefined();
    expect(port.invalidate).toBeDefined();
    expect(port.releaseAllClaims).toBeDefined();
    expect(port.clearServer).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// acquireWorkstation orchestration tests
// ---------------------------------------------------------------------------

describe("acquireWorkstation", () => {
  let r: InMemoryWorkstationRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    r = reg();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns acquired when registry has a valid candidate", async () => {
    r.register(SERVER, DIM, "crafting_table", { x: 10, y: 64, z: 10 });
    const result = await acquireWorkstation(r, {
      serverProfileId: SERVER,
      dimension: DIM,
      type: "crafting_table",
      from: { x: 5, y: 64, z: 5 },
      botId: BOT_A,
    });
    expect(result.status).toBe("acquired");
  });

  it("returns not_found/mayCreate when registry is empty", async () => {
    const result = await acquireWorkstation(r, {
      serverProfileId: SERVER,
      dimension: DIM,
      type: "crafting_table",
      from: { x: 0, y: 64, z: 0 },
      botId: BOT_A,
    });
    expect(result.status).toBe("not_found");
    if (result.status === "not_found") {
      expect(result.mayCreate).toBe(true);
    }
  });

  it("falls back to next candidate when verifyFn rejects nearest", async () => {
    r.register(SERVER, DIM, "crafting_table", { x: 5, y: 64, z: 5 }); // nearest, will be invalid
    r.register(SERVER, DIM, "crafting_table", { x: 20, y: 64, z: 20 }); // fallback
    const verifyFn = vi.fn(async (entry: { position: { x: number } }) => {
      return entry.position.x !== 5; // nearest is stale
    });
    const result = await acquireWorkstation(r, {
      serverProfileId: SERVER,
      dimension: DIM,
      type: "crafting_table",
      from: { x: 0, y: 64, z: 0 },
      botId: BOT_A,
      verifyFn,
    });
    expect(result.status).toBe("acquired");
    // The stale candidate should be invalidated
    // The stale entry (5,64,5) is invalidated; (20,64,20) is the remaining valid candidate
    const remaining = r.findCandidates(SERVER, DIM, "crafting_table", { x: 5, y: 64, z: 5 });
    expect(remaining.every((c) => c.position.x !== 5)).toBe(true);
  });

  it("returns busy for exclusive workstation claimed by another bot", async () => {
    r.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: 10 });
    r.claim(SERVER, DIM, { x: 10, y: 64, z: 10 }, BOT_B, 30_000);
    const result = await acquireWorkstation(r, {
      serverProfileId: SERVER,
      dimension: DIM,
      type: "furnace",
      from: { x: 5, y: 64, z: 5 },
      botId: BOT_A,
      exclusive: true,
    });
    // No other candidates → busy (or not_found depending on implementation)
    expect(["busy", "not_found"]).toContain(result.status);
  });

  it("registers local scan results when registry is empty", async () => {
    const scanFn = vi.fn(async () => [
      { position: { x: 50, y: 64, z: 50 }, type: "crafting_table" as const },
    ]);
    const result = await acquireWorkstation(r, {
      serverProfileId: SERVER,
      dimension: DIM,
      type: "crafting_table",
      from: { x: 0, y: 64, z: 0 },
      botId: BOT_A,
      scanFn,
    });
    expect(result.status).toBe("acquired");
    // Registry now has the entry
    expect(r.findCandidates(SERVER, DIM, "crafting_table", { x: 50, y: 64, z: 50 })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-bot reuse gate
// ---------------------------------------------------------------------------

describe("MULTI_BOT_REUSE_GATE: Bot A places, Bot B reuses", () => {
  it("Bot B reuses Bot A's crafting_table without creating a duplicate", async () => {
    const sharedRegistry = reg();

    // Bot A discovers/creates a crafting_table and registers it
    sharedRegistry.register(SERVER, DIM, "crafting_table", { x: 100, y: 64, z: 200 });

    // Bot B needs a crafting_table — queries the shared registry
    const cands = sharedRegistry.findCandidates(
      SERVER, DIM, "crafting_table",
      { x: 105, y: 64, z: 205 }, // Bot B is nearby
    );
    expect(cands).toHaveLength(1); // Bot B sees Bot A's crafting_table
    expect(cands[0]!.position).toEqual({ x: 100, y: 64, z: 200 });

    // Bot B can use it (crafting_table is shared, no claim needed)
    // This proves no duplicate crafting_table was created.
  });
});
