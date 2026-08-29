// ---------------------------------------------------------------------------
// FacilitySlot 7-state machine 回归测试（先写失败测试，再改实现）
//
// 状态机要求（Phase 2/3 of foundation upgrade）：
//   planned → placement_reserved → occupied
//   occupied → missing（方块消失）/ temporarily_blocked（被外来方块占据）
//   missing → planned（重新规划）/ placement_reserved（直接补放）
//   temporarily_blocked → planned / placement_reserved
//   any → invalid（永久不可放置）
//   unknown → { occupied | temporarily_blocked | invalid }（观测驱动）
// 非法跳变必须被拒绝并给出原因，禁止静默吞掉。
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FacilityRegistry,
  canTransition,
  facilityId,
  smeltingLinePattern,
  toWorldPosition,
  TRANSITIONS,
  type FacilitySlotStatus,
} from "../src/facility-registry.js";

const SERVER = "test-profile";
const DIM = "minecraft:overworld";
const BOT_A = "studio-bot-01";
const BOT_B = "studio-bot-02";

describe("FacilitySlot state machine (pure transitions table)", () => {
  it("covers exactly the 7 required statuses", () => {
    const statuses = new Set(Object.keys(TRANSITIONS));
    expect(statuses).toEqual(
      new Set(["planned", "placement_reserved", "occupied", "missing", "temporarily_blocked", "invalid", "unknown"]),
    );
  });

  it("allows the legal lifecycle path planned→reserved→occupied→missing→planned", () => {
    expect(canTransition("planned", "placement_reserved")).toBe(true);
    expect(canTransition("placement_reserved", "occupied")).toBe(true);
    expect(canTransition("occupied", "missing")).toBe(true);
    expect(canTransition("missing", "planned")).toBe(true);
    expect(canTransition("missing", "placement_reserved")).toBe(true);
  });

  it("allows occupied→temporarily_blocked (foreign block) and retry from blocked", () => {
    expect(canTransition("occupied", "temporarily_blocked")).toBe(true);
    expect(canTransition("temporarily_blocked", "planned")).toBe(true);
    expect(canTransition("temporarily_blocked", "placement_reserved")).toBe(true);
  });

  it("allows any → invalid but nothing leaves invalid", () => {
    for (const from of Object.keys(TRANSITIONS) as FacilitySlotStatus[]) {
      if (from === "invalid") continue; // invalid 无自环
      expect(canTransition(from, "invalid")).toBe(true);
    }
    expect(canTransition("invalid", "invalid")).toBe(false);
    expect(canTransition("invalid", "planned")).toBe(false);
    expect(canTransition("invalid", "placement_reserved")).toBe(false);
    expect(canTransition("invalid", "occupied")).toBe(false);
  });

  it("allows unknown → observed realities only", () => {
    expect(canTransition("unknown", "occupied")).toBe(true);
    expect(canTransition("unknown", "temporarily_blocked")).toBe(true);
    expect(canTransition("unknown", "invalid")).toBe(true);
    expect(canTransition("unknown", "planned")).toBe(true); // 观测到空位 → 可规划
    expect(canTransition("unknown", "placement_reserved")).toBe(false);
    expect(canTransition("unknown", "missing")).toBe(false); // 从未 occupied 谈不上 missing
  });

  it("rejects skipping placement_reserved on the way to occupied from planned", () => {
    expect(canTransition("planned", "occupied")).toBe(false);
    expect(canTransition("planned", "missing")).toBe(false);
  });

  it("rejects occupied → planned directly (must pass through missing)", () => {
    expect(canTransition("occupied", "planned")).toBe(false);
  });
});

describe("stable facilityId", () => {
  it("is deterministic across process restarts (no counter)", () => {
    const a = facilityId(SERVER, DIM, "smelting_zone", { x: 100, y: 64, z: 200 });
    const b = facilityId(SERVER, DIM, "smelting_zone", { x: 100, y: 64, z: 200 });
    expect(a).toBe(b);
    expect(a).toContain("smelting_zone");
    expect(a).not.toMatch(/-\d+$/); // 无自增计数器尾巴
  });

  it("differs by anchor / server / dimension / type", () => {
    const base = facilityId(SERVER, DIM, "smelting_zone", { x: 100, y: 64, z: 200 });
    expect(facilityId(SERVER, DIM, "smelting_zone", { x: 101, y: 64, z: 200 })).not.toBe(base);
    expect(facilityId("other", DIM, "smelting_zone", { x: 100, y: 64, z: 200 })).not.toBe(base);
    expect(facilityId(SERVER, "minecraft:nether", "smelting_zone", { x: 100, y: 64, z: 200 })).not.toBe(base);
    expect(facilityId(SERVER, DIM, "storage_zone", { x: 100, y: 64, z: 200 })).not.toBe(base);
  });

  it("negative coordinates stay unambiguous", () => {
    const a = facilityId(SERVER, DIM, "smelting_zone", { x: -1, y: 64, z: -10 });
    const b = facilityId(SERVER, DIM, "smelting_zone", { x: 1, y: 64, z: 10 });
    expect(a).not.toBe(b);
  });
});

describe("FacilityRegistry 7-state slot machine", () => {
  let fr: FacilityRegistry;

  beforeEach(() => {
    fr = new FacilityRegistry();
  });

  function createZone(anchor = { x: 100, y: 64, z: 200 }, slots = 3, orientation: "north" | "south" | "east" | "west" = "north") {
    return fr.create({
      facilityType: "smelting_zone",
      serverProfileId: SERVER,
      dimension: DIM,
      anchor,
      orientation,
      layoutVersion: "smelting_basic_v1",
      patternSlots: smeltingLinePattern(slots),
    });
  }

  it("new planned facility: slots start as planned, not available", () => {
    const f = createZone();
    expect(f.slots.every((s) => s.status === "planned")).toBe(true);
  });

  it("create is idempotent by identity: same anchor returns same facility", () => {
    const f1 = createZone();
    const f2 = createZone();
    expect(f2.id).toBe(f1.id);
    expect(fr.size).toBe(1);
  });

  it("discovered facility: slots start as unknown until observed", () => {
    const f = fr.create({
      facilityType: "smelting_zone",
      serverProfileId: SERVER,
      dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 },
      orientation: "north",
      layoutVersion: "smelting_basic_v1",
      patternSlots: smeltingLinePattern(2),
      discovery: "observed_existing",
    });
    expect(f.slots.every((s) => s.status === "unknown")).toBe(true);
  });

  it("nextPlannableSlot is pure: does not mutate expired reservations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    const f = createZone(undefined, 2);
    const s0 = fr.nextPlannableSlot(f.id)!;
    fr.reserveSlot(f.id, s0.index, BOT_A, 5_000);
    vi.advanceTimersByTime(6_000);
    // 惰性过期被禁止：未调用 expireReservations 前 slot 仍是 placement_reserved
    expect(f.slots[0]!.status).toBe("placement_reserved");
    // 纯读：slot 1 仍可规划，且不会顺手释放 slot 0
    expect(fr.nextPlannableSlot(f.id)!.index).toBe(1);
    expect(f.slots[0]!.status).toBe("placement_reserved");
    expect(fr.expireReservations(f.id)).toBe(1);
    expect(f.slots[0]!.status).toBe("planned");
    expect(fr.nextPlannableSlot(f.id)!.index).toBe(0);
    vi.useRealTimers();
  });

  it("reserve → occupy records lastVerifiedAt and workstation key", () => {
    const f = createZone(undefined, 2);
    const s0 = fr.nextPlannableSlot(f.id)!;
    expect(fr.reserveSlot(f.id, s0.index, BOT_A)).toBe(true);
    expect(f.slots[0]!.status).toBe("placement_reserved");
    expect(f.slots[0]!.reservedBy).toBe(BOT_A);
    expect(fr.markSlotOccupied(f.id, 0, "ws-entry-1")).toBe(true);
    expect(f.slots[0]!.status).toBe("occupied");
    expect(f.slots[0]!.workstationEntryKey).toBe("ws-entry-1");
    expect(f.slots[0]!.lastVerifiedAtMs).not.toBeNull();
  });

  it("second bot cannot reserve the same slot", () => {
    const f = createZone(undefined, 1);
    fr.reserveSlot(f.id, 0, BOT_A);
    expect(fr.reserveSlot(f.id, 0, BOT_B)).toBe(false);
  });

  it("releaseReservation returns slot to planned and stores reason", () => {
    const f = createZone(undefined, 1);
    fr.reserveSlot(f.id, 0, BOT_A);
    expect(fr.releaseReservation(f.id, 0, "path_blocked")).toBe(true);
    expect(f.slots[0]!.status).toBe("planned");
    expect(f.slots[0]!.statusReason).toBe("path_blocked");
  });

  it("placement obstruction → temporarily_blocked with reason", () => {
    const f = createZone(undefined, 2);
    fr.reserveSlot(f.id, 0, BOT_A);
    expect(fr.markSlotTemporarilyBlocked(f.id, 0, "foreign_block:stone")).toBe(true);
    expect(f.slots[0]!.status).toBe("temporarily_blocked");
    expect(f.slots[0]!.statusReason).toBe("foreign_block:stone");
    // 下一个可规划 slot 跳过 blocked
    expect(fr.nextPlannableSlot(f.id)!.index).toBe(1);
  });

  it("occupied furnace destroyed → missing (not silently plannable)", () => {
    const f = createZone(undefined, 2);
    fr.reserveSlot(f.id, 0, BOT_A);
    fr.markSlotOccupied(f.id, 0, "ws-1");
    expect(fr.markSlotMissing(f.id, 0, "block_removed")).toBe(true);
    expect(f.slots[0]!.status).toBe("missing");
    expect(f.slots[0]!.workstationEntryKey).toBeNull();
    // missing 不会出现在 nextPlannableSlot：必须显式 re-plan
    expect(fr.nextPlannableSlot(f.id)!.index).toBe(1);
    expect(fr.replanSlot(f.id, 0)).toBe(true);
    expect(f.slots[0]!.status).toBe("planned");
    expect(fr.nextPlannableSlot(f.id)!.index).toBe(0);
  });

  it("invalid transition is rejected with reason, never silently coerced", () => {
    const f = createZone(undefined, 2);
    // planned 不能直接 occupied
    expect(fr.markSlotOccupied(f.id, 0, "ws-1")).toBe(false);
    expect(f.slots[0]!.status).toBe("planned");
    // occupied 后不能直接回到 planned
    fr.reserveSlot(f.id, 0, BOT_A);
    fr.markSlotOccupied(f.id, 0, "ws-1");
    expect(fr.markSlotTemporarilyBlocked(f.id, 0, "x")).toBe(true);
    // invalid 不可逆
    expect(fr.markSlotInvalid(f.id, 1, "bedrock")).toBe(true);
    expect(fr.markSlotOccupied(f.id, 1, "ws-2")).toBe(false);
    expect(f.slots[1]!.status).toBe("invalid");
  });

  it("observeSlot drives unknown → occupied / temporarily_blocked / invalid", () => {
    let clockMs = Date.parse("2026-08-29T12:00:00Z");
    const clockFr = new FacilityRegistry({ now: () => clockMs });
    const f = clockFr.create({
      facilityType: "smelting_zone",
      serverProfileId: SERVER,
      dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 },
      orientation: "north",
      layoutVersion: "smelting_basic_v1",
      patternSlots: smeltingLinePattern(3),
      discovery: "observed_existing",
    });
    clockMs += 60_000;
    expect(clockFr.observeSlot(f.id, 0, { blockPresent: true, blockName: "furnace" })).toBe(true);
    expect(f.slots[0]!.status).toBe("occupied");
    expect(clockFr.observeSlot(f.id, 1, { blockPresent: true, blockName: "stone" })).toBe(true);
    expect(f.slots[1]!.status).toBe("temporarily_blocked");
    expect(clockFr.observeSlot(f.id, 2, { blockPresent: false, blockName: null })).toBe(true);
    expect(f.slots[2]!.status).toBe("planned"); // 空位可规划
    expect(f.lastObservedAt).not.toBe(f.createdAt);
  });

  it("operations on unknown facility id return false / null, never throw", () => {
    expect(fr.get("facility-nonexistent")).toBeNull();
    expect(fr.reserveSlot("facility-nonexistent", 0, BOT_A)).toBe(false);
    expect(fr.nextPlannableSlot("facility-nonexistent")).toBeNull();
    expect(fr.expireReservations("facility-nonexistent")).toBe(0);
  });

  it("slot indices are validated (no out-of-range mutation)", () => {
    const f = createZone(undefined, 2);
    expect(fr.reserveSlot(f.id, 99, BOT_A)).toBe(false);
    expect(fr.reserveSlot(f.id, -1, BOT_A)).toBe(false);
    expect(fr.markSlotOccupied(f.id, 99, "ws")).toBe(false);
  });
});

describe("orientation standard (local +z = forward, +x = right of facing)", () => {
  const anchor = { x: 0, y: 64, z: 0 };

  it("north (facing -z): local(1,0,0)→world(+1 x), local(0,0,1)→world(-1 z)", () => {
    expect(toWorldPosition(anchor, { x: 1, y: 0, z: 0 }, "north")).toEqual({ x: 1, y: 64, z: 0 });
    expect(toWorldPosition(anchor, { x: 0, y: 0, z: 1 }, "north")).toEqual({ x: 0, y: 64, z: -1 });
  });

  it("south (facing +z): local(1,0,0)→world(-1 x), local(0,0,1)→world(+1 z)", () => {
    expect(toWorldPosition(anchor, { x: 1, y: 0, z: 0 }, "south")).toEqual({ x: -1, y: 64, z: 0 });
    expect(toWorldPosition(anchor, { x: 0, y: 0, z: 1 }, "south")).toEqual({ x: 0, y: 64, z: 1 });
  });

  it("east (facing +x): local(1,0,0)→world(+1 z), local(0,0,1)→world(+1 x)", () => {
    expect(toWorldPosition(anchor, { x: 1, y: 0, z: 0 }, "east")).toEqual({ x: 0, y: 64, z: 1 });
    expect(toWorldPosition(anchor, { x: 0, y: 0, z: 1 }, "east")).toEqual({ x: 1, y: 64, z: 0 });
  });

  it("west (facing -x): local(1,0,0)→world(-1 z), local(0,0,1)→world(-1 x)", () => {
    expect(toWorldPosition(anchor, { x: 1, y: 0, z: 0 }, "west")).toEqual({ x: 0, y: 64, z: -1 });
    expect(toWorldPosition(anchor, { x: 0, y: 0, z: 1 }, "west")).toEqual({ x: -1, y: 64, z: 0 });
  });

  it("right-hand rule holds for all four orientations (right × forward consistent)", () => {
    // forward vector F, right vector R: R must equal F rotated -90° around Y (R = F×up)
    const cases: Array<["north" | "south" | "east" | "west", { x: number; z: number }, { x: number; z: number }]> = [
      ["north", { x: 0, z: -1 }, { x: 1, z: 0 }],
      ["south", { x: 0, z: 1 }, { x: -1, z: 0 }],
      ["east", { x: 1, z: 0 }, { x: 0, z: 1 }],
      ["west", { x: -1, z: 0 }, { x: 0, z: -1 }],
    ];
    for (const [o, forward, right] of cases) {
      expect(toWorldPosition(anchor, { x: 0, y: 0, z: 1 }, o)).toEqual({ x: forward.x, y: 64, z: forward.z });
      expect(toWorldPosition(anchor, { x: 1, y: 0, z: 0 }, o)).toEqual({ x: right.x, y: 64, z: right.z });
    }
  });
});

describe("FacilityRegistryPort + findCandidates + serialization", () => {
  it("exposes the port interface and findCandidates returns all matches ordered by distance", () => {
    const fr: FacilityRegistry = new FacilityRegistry();
    fr.create({ facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM, anchor: { x: 100, y: 64, z: 100 }, orientation: "north", layoutVersion: "v1", patternSlots: smeltingLinePattern(1) });
    fr.create({ facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM, anchor: { x: 200, y: 64, z: 200 }, orientation: "north", layoutVersion: "v1", patternSlots: smeltingLinePattern(1) });
    fr.create({ facilityType: "smelting_zone", serverProfileId: "other", dimension: DIM, anchor: { x: 150, y: 64, z: 150 }, orientation: "north", layoutVersion: "v1", patternSlots: smeltingLinePattern(1) });
    fr.create({ facilityType: "storage_zone", serverProfileId: SERVER, dimension: DIM, anchor: { x: 150, y: 64, z: 150 }, orientation: "north", layoutVersion: "v1", patternSlots: smeltingLinePattern(1) });

    const near = fr.findCandidates(SERVER, DIM, "smelting_zone", { x: 190, y: 64, z: 190 });
    expect(near).toHaveLength(2);
    expect(near[0]!.anchor).toEqual({ x: 200, y: 64, z: 200 });
    expect(near[1]!.anchor).toEqual({ x: 100, y: 64, z: 100 });
  });

  it("serializes to JSON snapshot and restores with slot state intact", () => {
    const fr = new FacilityRegistry();
    const f = fr.create({ facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM, anchor: { x: 10, y: 64, z: 10 }, orientation: "north", layoutVersion: "v1", patternSlots: smeltingLinePattern(2) });
    fr.reserveSlot(f.id, 0, BOT_A);
    fr.markSlotOccupied(f.id, 0, "ws-1");
    fr.markSlotMissing(f.id, 0, "griefed");

    const snapshot = fr.serialize();
    const fr2 = FacilityRegistry.restore(snapshot);
    const restored = fr2.get(f.id)!;
    expect(restored.slots[0]!.status).toBe("missing");
    expect(restored.slots[0]!.statusReason).toBe("griefed");
    expect(restored.slots[1]!.status).toBe("planned");
    // restore 后 id 稳定（幂等 create 不重复）
    const again = fr2.create({ facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM, anchor: { x: 10, y: 64, z: 10 }, orientation: "north", layoutVersion: "v1", patternSlots: smeltingLinePattern(2) });
    expect(again.id).toBe(f.id);
    expect(fr2.size).toBe(1);
  });
});
