import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  FacilityRegistry,
  smeltingLinePattern,
  smeltingWallGridPattern,
} from "../src/facility-registry.js";
import {
  assessCapacity,
  creationPolicyFor,
} from "../src/capacity-planner.js";
import {
  InMemoryWorkstationRegistry,
} from "../src/workstation-registry.js";

const SERVER = "test-profile";
const DIM = "minecraft:overworld";
const BOT_A = "studio-bot-01";
const BOT_B = "studio-bot-02";

// ---------------------------------------------------------------------------
// FacilityRegistry
// ---------------------------------------------------------------------------

describe("FacilityRegistry", () => {
  let fr: FacilityRegistry;

  beforeEach(() => {
    fr = new FacilityRegistry();
  });

  function createZone(anchor = { x: 100, y: 64, z: 200 }, slots = 6) {
    return fr.create({
      facilityType: "smelting_zone",
      serverProfileId: SERVER,
      dimension: DIM,
      anchor,
      orientation: "north",
      layoutVersion: "smelting_basic_v1",
      patternSlots: smeltingLinePattern(slots),
    });
  }

  it("creates smelting_zone with all slots initially available", () => {
    const f = createZone();
    expect(f.slots).toHaveLength(6);
    expect(f.slots[0]!.status).toBe("available");
  });

  it("north orientation: local +x maps to world +x", () => {
    const f = createZone({ x: 100, y: 64, z: 200 });
    expect(f.slots[0]!.worldPosition).toEqual({ x: 100, y: 64, z: 200 });
    expect(f.slots[1]!.worldPosition).toEqual({ x: 101, y: 64, z: 200 });
  });

  it("west orientation: local +x maps to world -z", () => {
    const f = fr.create({
      facilityType: "smelting_zone",
      serverProfileId: SERVER,
      dimension: DIM,
      anchor: { x: 100, y: 64, z: 200 },
      orientation: "west",
      layoutVersion: "smelting_basic_v1",
      patternSlots: smeltingLinePattern(3),
    });
    expect(f.slots[1]!.worldPosition).toEqual({ x: 100, y: 64, z: 199 });
  });

  it("nextAvailableSlot returns first available", () => {
    const f = createZone({ x: 100, y: 64, z: 200 }, 3);
    expect(fr.nextAvailableSlot(f)).not.toBeNull();
  });

  it("reserve → markOccupied → next available is different", () => {
    const f = createZone({ x: 100, y: 64, z: 200 }, 3);
    const s1 = fr.nextAvailableSlot(f)!;
    fr.reserveSlot(f, s1, BOT_A);
    fr.markOccupied(f, s1, "ws-1");
    expect(s1.status).toBe("occupied");
    expect(fr.nextAvailableSlot(f)).not.toBe(s1);
  });

  it("double reserve same slot fails", () => {
    const f = createZone({ x: 100, y: 64, z: 200 }, 1);
    const slot = fr.nextAvailableSlot(f)!;
    expect(fr.reserveSlot(f, slot, BOT_A)).toBe(true);
    expect(fr.reserveSlot(f, slot, BOT_B)).toBe(false);
  });

  it("reservation expires → available again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    const f = createZone({ x: 100, y: 64, z: 200 }, 1);
    const slot = fr.nextAvailableSlot(f)!;
    fr.reserveSlot(f, slot, BOT_A, 5_000);
    vi.advanceTimersByTime(6_000);
    expect(fr.nextAvailableSlot(f)!.status).toBe("available");
    vi.useRealTimers();
  });

  it("markSlotAvailable after destruction", () => {
    const f = createZone({ x: 100, y: 64, z: 200 }, 3);
    const slot = fr.nextAvailableSlot(f)!;
    fr.markOccupied(f, slot, "ws-1");
    console.error("[DBG] slot:", JSON.stringify(slot));
    console.error("[DBG] allSlots:", JSON.stringify(f.slots.map(s => ({pos: s.worldPosition, st: s.status}))));
    const r = fr.markSlotAvailable(f, slot.worldPosition);
    expect(r).toBe(true);
    expect(slot.status).toBe("available");
  });

  it("wall grid 4x2 → 8 slots, expansion to row 1 after row 0 full", () => {
    const f = fr.create({
      facilityType: "smelting_zone",
      serverProfileId: SERVER,
      dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 },
      orientation: "north",
      layoutVersion: "smelting_wall_v1",
      patternSlots: smeltingWallGridPattern(4, 2),
    });
    expect(f.slots).toHaveLength(8);
    for (let i = 0; i < 4; i += 1) fr.markOccupied(f, f.slots[i]!, `ws-${i}`);
    expect(fr.nextAvailableSlot(f)!.localOffset).toEqual({ x: 0, y: 1, z: 0 });
  });
});

// ---------------------------------------------------------------------------
// CapacityPlanner
// ---------------------------------------------------------------------------

describe("CapacityPlanner", () => {
  it("create_first: no workstations", () => {
    expect(assessCapacity({
      policy: "reuse_preferred", totalWorkstations: 0, busyWorkstations: 0,
      pendingItems: 8, throughputPerWorkstationPerMin: 8,
    }).decision).toBe("create_first");
  });

  it("reuse: free available", () => {
    expect(assessCapacity({
      policy: "scale_out", totalWorkstations: 2, busyWorkstations: 1,
      pendingItems: 16, throughputPerWorkstationPerMin: 8,
    }).decision).toBe("reuse");
  });

  it("wait: reuse_only all busy", () => {
    expect(assessCapacity({
      policy: "reuse_only", totalWorkstations: 1, busyWorkstations: 1,
      pendingItems: 8, throughputPerWorkstationPerMin: 8,
    }).decision).toBe("wait");
  });

  it("scale_out: all busy + long wait (furnace)", () => {
    expect(assessCapacity({
      policy: "scale_out", totalWorkstations: 1, busyWorkstations: 1,
      pendingItems: 64, throughputPerWorkstationPerMin: 8,
    }).decision).toBe("scale_out");
  });

  it("wait: all busy but short wait", () => {
    expect(assessCapacity({
      policy: "scale_out", totalWorkstations: 4, busyWorkstations: 4,
      pendingItems: 4, throughputPerWorkstationPerMin: 64,
    }).decision).toBe("wait");
  });

  it("creationPolicyFor mapping", () => {
    expect(creationPolicyFor("furnace")).toBe("scale_out");
    expect(creationPolicyFor("crafting_table")).toBe("reuse_preferred");
  });
});

// ---------------------------------------------------------------------------
// SmeltingZone vertical slice
// ---------------------------------------------------------------------------

describe("SmeltingZone vertical slice", () => {
  let wsReg: InMemoryWorkstationRegistry;
  let fr: FacilityRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    wsReg = new InMemoryWorkstationRegistry({ entryTtlMs: 300_000, leaseTtlMs: 30_000 });
    fr = new FacilityRegistry();
  });

  afterEach(() => { vi.useRealTimers(); });

  function createZone() {
    return fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 100, y: 64, z: 200 }, orientation: "north",
      layoutVersion: "smelting_basic_v1", patternSlots: smeltingLinePattern(8),
    });
  }

  it("s1: create zone → place first furnace → register", () => {
    expect(fr.find(SERVER, DIM, "smelting_zone")).toBeNull();
    const facility = createZone();
    const slot = fr.nextAvailableSlot(facility)!;
    fr.reserveSlot(facility, slot, BOT_A);
    wsReg.register(SERVER, DIM, "furnace", slot.worldPosition);
    fr.markOccupied(facility, slot, "ws-entry-1");
    expect(slot.status).toBe("occupied");
    expect(wsReg.get(SERVER, DIM, slot.worldPosition)).not.toBeNull();
  });

  it("s2: existing furnace → reuse", () => {
    createZone();
    wsReg.register(SERVER, DIM, "furnace", { x: 100, y: 64, z: 200 });
    expect(wsReg.findCandidates(SERVER, DIM, "furnace", { x: 102, y: 64, z: 200 })).toHaveLength(1);
    expect(wsReg.size).toBe(1);
  });

  it("s3-4: busy furnace → small waits, large scales out", () => {
    const facility = createZone();
    wsReg.register(SERVER, DIM, "furnace", { x: 100, y: 64, z: 200 });
    wsReg.claim(SERVER, DIM, { x: 100, y: 64, z: 200 }, BOT_A, 60_000);
    // Sync facility slot status with workstation registry claim
    const firstSlot = facility.slots.find(
      (s) => s.worldPosition.x === 100 && s.worldPosition.z === 200,
    );
    if (firstSlot) fr.markOccupied(facility, firstSlot, "ws-busy-1");

    expect(assessCapacity({
      policy: "scale_out", totalWorkstations: 1, busyWorkstations: 1,
      pendingItems: 8, throughputPerWorkstationPerMin: 8,
    }).decision).toBe("wait");

    expect(assessCapacity({
      policy: "scale_out", totalWorkstations: 1, busyWorkstations: 1,
      pendingItems: 128, throughputPerWorkstationPerMin: 8,
    }).decision).toBe("scale_out");

    const nextSlot = fr.nextAvailableSlot(facility)!;
    fr.reserveSlot(facility, nextSlot, BOT_B);
    expect(nextSlot.worldPosition).toEqual({ x: 101, y: 64, z: 200 });
  });

  it("s5: 4 full row → expansion to second row", () => {
    const facility = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "smelting_wall_v1",
      patternSlots: smeltingWallGridPattern(4, 2),
    });
    for (let i = 0; i < 4; i += 1) fr.markOccupied(facility, facility.slots[i]!, `ws-${i}`);
    expect(fr.nextAvailableSlot(facility)!.localOffset).toEqual({ x: 0, y: 1, z: 0 });
  });

  it("s6: two bots cannot reserve same slot", () => {
    const facility = createZone();
    const s1 = fr.nextAvailableSlot(facility)!;
    fr.reserveSlot(facility, s1, BOT_A);
    expect(fr.reserveSlot(facility, s1, BOT_B)).toBe(false);
    const s2 = fr.nextAvailableSlot(facility)!;
    expect(s2).not.toBe(s1);
    fr.reserveSlot(facility, s2, BOT_B);
    expect(s2.status).toBe("reserved");
  });

  it("s7: blocked slot skipped", () => {
    const facility = createZone({ x: 100, y: 64, z: 200 }, 3);
    fr.markBlocked(facility, facility.slots[1]!);
    // createZone creates 8 slots; blocking 1 → 7 available
    expect(facility.slots.filter((s) => s.status === "available")).toHaveLength(7);
  });

  it("s8: destroyed furnace → slot reused", () => {
    const facility = createZone({ x: 100, y: 64, z: 200 }, 2);
    const slot0 = facility.slots[0]!;
    fr.markOccupied(facility, slot0, "ws-1");
    wsReg.register(SERVER, DIM, "furnace", slot0.worldPosition);
    wsReg.invalidate(SERVER, DIM, slot0.worldPosition);
    fr.markSlotAvailable(facility, slot0.worldPosition);
    expect(slot0.status).toBe("available");
  });

  it("s9: reservation TTL expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    const facility = createZone({ x: 100, y: 64, z: 200 }, 1);
    const slot = fr.nextAvailableSlot(facility)!;
    fr.reserveSlot(facility, slot, BOT_A, 5_000);
    vi.advanceTimersByTime(6_000);
    expect(fr.nextAvailableSlot(facility)!.status).toBe("available");
    vi.useRealTimers();
  });

  it("s10: restart → re-discover from workstation registry", () => {
    createZone();
    wsReg.register(SERVER, DIM, "furnace", { x: 100, y: 64, z: 200 });
    wsReg.register(SERVER, DIM, "furnace", { x: 101, y: 64, z: 200 });
    const cands = wsReg.findCandidates(SERVER, DIM, "furnace", { x: 100, y: 64, z: 200 });
    expect(cands).toHaveLength(2);
  });
});
