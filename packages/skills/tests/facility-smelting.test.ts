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
// FacilityRegistry（7-state 语义下的 smelting 场景）
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

  it("creates smelting_zone with all slots initially planned", () => {
    const f = createZone();
    expect(f.slots).toHaveLength(6);
    expect(f.slots[0]!.status).toBe("planned");
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

  it("nextPlannableSlot returns first planned", () => {
    const f = createZone({ x: 100, y: 64, z: 200 }, 3);
    expect(fr.nextPlannableSlot(f.id)).not.toBeNull();
  });

  it("reserve → markSlotOccupied → next plannable is different", () => {
    const f = createZone({ x: 100, y: 64, z: 200 }, 3);
    const s1 = fr.nextPlannableSlot(f.id)!;
    fr.reserveSlot(f.id, s1.index, BOT_A);
    fr.markSlotOccupied(f.id, s1.index, "ws-1");
    expect(s1.status).toBe("occupied");
    expect(fr.nextPlannableSlot(f.id)).not.toBe(s1);
  });

  it("double reserve same slot fails", () => {
    const f = createZone({ x: 100, y: 64, z: 200 }, 1);
    const slot = fr.nextPlannableSlot(f.id)!;
    expect(fr.reserveSlot(f.id, slot.index, BOT_A)).toBe(true);
    expect(fr.reserveSlot(f.id, slot.index, BOT_B)).toBe(false);
  });

  it("reservation expires → planned again (explicit expire)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    const f = createZone({ x: 100, y: 64, z: 200 }, 1);
    const slot = fr.nextPlannableSlot(f.id)!;
    fr.reserveSlot(f.id, slot.index, BOT_A, 5_000);
    vi.advanceTimersByTime(6_000);
    expect(fr.expireReservations(f.id)).toBe(1);
    expect(fr.nextPlannableSlot(f.id)!.status).toBe("planned");
    vi.useRealTimers();
  });

  it("destroyed furnace → missing → replan → available again", () => {
    const f = createZone({ x: 100, y: 64, z: 200 }, 3);
    const slot = fr.nextPlannableSlot(f.id)!;
    fr.reserveSlot(f.id, slot.index, BOT_A);
    fr.markSlotOccupied(f.id, slot.index, "ws-1");
    expect(fr.markSlotMissing(f.id, slot.index, "block_removed")).toBe(true);
    expect(slot.status).toBe("missing");
    expect(fr.replanSlot(f.id, slot.index)).toBe(true);
    expect(slot.status).toBe("planned");
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
    for (let i = 0; i < 4; i += 1) {
      fr.reserveSlot(f.id, i, BOT_A);
      fr.markSlotOccupied(f.id, i, `ws-${i}`);
    }
    expect(fr.nextPlannableSlot(f.id)!.localOffset).toEqual({ x: 0, y: 1, z: 0 });
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
    fr = new FacilityRegistry({ now: () => Date.now() });
  });

  afterEach(() => { vi.useRealTimers(); });

  function createZone(anchor = { x: 100, y: 64, z: 200 }, slots = 8) {
    return fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor, orientation: "north",
      layoutVersion: "smelting_basic_v1", patternSlots: smeltingLinePattern(slots),
    });
  }

  it("s1: create zone → place first furnace → register", () => {
    expect(fr.find(SERVER, DIM, "smelting_zone")).toBeNull();
    const facility = createZone();
    const slot = fr.nextPlannableSlot(facility.id)!;
    fr.reserveSlot(facility.id, slot.index, BOT_A);
    wsReg.register(SERVER, DIM, "furnace", slot.worldPosition);
    fr.markSlotOccupied(facility.id, slot.index, "ws-entry-1");
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
    const firstSlot = facility.slots.find(
      (s) => s.worldPosition.x === 100 && s.worldPosition.z === 200,
    );
    if (firstSlot) {
      fr.reserveSlot(facility.id, firstSlot.index, BOT_A);
      fr.markSlotOccupied(facility.id, firstSlot.index, "ws-busy-1");
    }

    expect(assessCapacity({
      policy: "scale_out", totalWorkstations: 1, busyWorkstations: 1,
      pendingItems: 8, throughputPerWorkstationPerMin: 8,
    }).decision).toBe("wait");

    expect(assessCapacity({
      policy: "scale_out", totalWorkstations: 1, busyWorkstations: 1,
      pendingItems: 128, throughputPerWorkstationPerMin: 8,
    }).decision).toBe("scale_out");

    const nextSlot = fr.nextPlannableSlot(facility.id)!;
    fr.reserveSlot(facility.id, nextSlot.index, BOT_B);
    expect(nextSlot.worldPosition).toEqual({ x: 101, y: 64, z: 200 });
  });

  it("s5: 4 full row → expansion to second row", () => {
    const facility = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "smelting_wall_v1",
      patternSlots: smeltingWallGridPattern(4, 2),
    });
    for (let i = 0; i < 4; i += 1) {
      fr.reserveSlot(facility.id, i, BOT_A);
      fr.markSlotOccupied(facility.id, i, `ws-${i}`);
    }
    expect(fr.nextPlannableSlot(facility.id)!.localOffset).toEqual({ x: 0, y: 1, z: 0 });
  });

  it("s6: two bots cannot reserve same slot", () => {
    const facility = createZone();
    const s1 = fr.nextPlannableSlot(facility.id)!;
    fr.reserveSlot(facility.id, s1.index, BOT_A);
    expect(fr.reserveSlot(facility.id, s1.index, BOT_B)).toBe(false);
    const s2 = fr.nextPlannableSlot(facility.id)!;
    expect(s2).not.toBe(s1);
    fr.reserveSlot(facility.id, s2.index, BOT_B);
    expect(s2.status).toBe("placement_reserved");
  });

  it("s7: temporarily blocked slot skipped", () => {
    const facility = createZone({ x: 100, y: 64, z: 200 }, 8);
    fr.reserveSlot(facility.id, 1, BOT_A);
    fr.markSlotTemporarilyBlocked(facility.id, 1, "foreign_block:dirt");
    expect(facility.slots.filter((s) => s.status === "planned")).toHaveLength(7);
    expect(fr.nextPlannableSlot(facility.id)!.index).not.toBe(1);
  });

  it("s8: destroyed furnace → missing → replan → reuse slot", () => {
    const facility = createZone({ x: 100, y: 64, z: 200 }, 2);
    const slot0 = facility.slots[0]!;
    fr.reserveSlot(facility.id, 0, BOT_A);
    fr.markSlotOccupied(facility.id, 0, "ws-1");
    wsReg.register(SERVER, DIM, "furnace", slot0.worldPosition);
    wsReg.invalidate(SERVER, DIM, slot0.worldPosition);
    fr.markSlotMissing(facility.id, 0, "invalidated");
    expect(slot0.status).toBe("missing");
    expect(fr.replanSlot(facility.id, 0)).toBe(true);
    expect(slot0.status).toBe("planned");
  });

  it("s9: reservation TTL expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    const facility = createZone({ x: 100, y: 64, z: 200 }, 1);
    const slot = fr.nextPlannableSlot(facility.id)!;
    fr.reserveSlot(facility.id, slot.index, BOT_A, 5_000);
    vi.advanceTimersByTime(6_000);
    expect(fr.expireReservations(facility.id)).toBe(1);
    expect(fr.nextPlannableSlot(facility.id)!.status).toBe("planned");
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
