// ---------------------------------------------------------------------------
// Facility P0 hardening 回归测试（先写失败测试）
//
// 覆盖提示词五/七/十一/十二/十三/三十三节：
//   - owner-safe release/renew/occupy（Bot B 不能动 Bot A 的预约）
//   - temporarily_blocked 需要 failureCount/lastFailureAtMs + 指数退避
//   - slot 稳定 slotId（不靠 array index）
//   - maxFacilitiesPerServer 真实执行（per server+dimension scope）
//   - workstationType 使用统一 WorkstationType（编译期约束）
//   - Facility 可绑定 baseId（Base→Facility→Workstation 层级）
// ---------------------------------------------------------------------------
import { describe, expect, it, vi } from "vitest";

import {
  FacilityRegistry,
  smeltingLinePattern,
  type FacilitySlot,
} from "../src/facility-registry.js";
import type { WorkstationType } from "../src/workstation-registry.js";

const SERVER = "test-profile";
const SERVER_2 = "test-profile-2";
const DIM = "minecraft:overworld";
const DIM_NETHER = "minecraft:the_nether";
const BOT_A = "studio-bot-01";
const BOT_B = "studio-bot-02";

describe("owner-safe slot operations (十一)", () => {
  function setup() {
    const fr = new FacilityRegistry();
    const f = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(4),
    });
    return { fr, f };
  }

  it("Bot B cannot release Bot A's reservation", () => {
    const { fr, f } = setup();
    fr.reserveSlot(f.id, 0, BOT_A);
    expect(fr.releaseReservation(f.id, 0, "bot_b_mistake", BOT_B)).toBe(false);
    expect(f.slots[0]!.status).toBe("placement_reserved");
    expect(f.slots[0]!.reservedBy).toBe(BOT_A);
  });

  it("owner can release own reservation", () => {
    const { fr, f } = setup();
    fr.reserveSlot(f.id, 0, BOT_A);
    expect(fr.releaseReservation(f.id, 0, "done", BOT_A)).toBe(true);
    expect(f.slots[0]!.status).toBe("planned");
  });

  it("renewSlotReservation is owner-safe", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    const fr = new FacilityRegistry({ now: () => Date.now() });
    const f = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(1),
    });
    fr.reserveSlot(f.id, 0, BOT_A, 10_000);
    vi.advanceTimersByTime(5_000);
    expect(fr.renewSlotReservation(f.id, 0, BOT_B, 10_000)).toBe(false);
    expect(fr.renewSlotReservation(f.id, 0, BOT_A, 10_000)).toBe(true);
    vi.advanceTimersByTime(9_000); // 原始 TTL 早已过期，续约后仍持有
    expect(f.slots[0]!.status).toBe("placement_reserved");
    expect(fr.expireReservations(f.id)).toBe(0);
    vi.useRealTimers();
  });

  it("markSlotOccupied enforces reservation owner when provided", () => {
    const { fr, f } = setup();
    fr.reserveSlot(f.id, 0, BOT_A);
    // BOT_B 拿别人的预约完工 → 拒绝
    expect(fr.markSlotOccupied(f.id, 0, "ws-1", { reservationOwner: BOT_B })).toBe(false);
    expect(f.slots[0]!.status).toBe("placement_reserved");
    // 真正的 owner 完工 → 成功
    expect(fr.markSlotOccupied(f.id, 0, "ws-1", { reservationOwner: BOT_A })).toBe(true);
    expect(f.slots[0]!.status).toBe("occupied");
  });

  it("rejects reservation TTLs that could lock a slot beyond recovery (FACILITY_TTL_INVALID)", () => {
    // TTL 此前完全无校验且经 RPC 直通（shared-state 的 optNum 只查有限数）：
    // 巨大 TTL（如 24h）会让 expireReservations 永远无法回收该施工位，
    // owner-safe 的释放又不能代执行——一次坏调用 = 设施永久损失该 slot。
    // 与 workstation-registry 的 boundedTtl 同款纪律：[1, 120_000]。
    const { fr, f } = setup();
    const invalid = [Number.NaN, 0, -5, 120_001, 24 * 3_600_000, Number.POSITIVE_INFINITY];
    // reserveSlot：planned 状态下越界 TTL 直接拒绝，且不留半套状态。
    for (const ttl of invalid) {
      expect(() => fr.reserveSlot(f.id, 0, BOT_A, ttl)).toThrowError("FACILITY_TTL_INVALID");
    }
    expect(f.slots[0]!.status).toBe("planned");
    // renewSlotReservation：持有人预约后，越界 TTL 同样拒绝（预约保持原状）。
    expect(fr.reserveSlot(f.id, 0, BOT_A, 120_000)).toBe(true);
    for (const ttl of invalid) {
      expect(() => fr.renewSlotReservation(f.id, 0, BOT_A, ttl)).toThrowError("FACILITY_TTL_INVALID");
    }
    expect(f.slots[0]!.status).toBe("placement_reserved");
    // 合法粒度与缺省不受影响。
    expect(fr.renewSlotReservation(f.id, 0, BOT_A, 1)).toBe(true);
    expect(fr.reserveSlot(f.id, 1, BOT_B)).toBe(true); // 缺省 30s 不受影响
  });
});

describe("temporarily_blocked backoff (五)", () => {
  it("records failureCount / lastFailureAtMs on placement failure", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    const fr = new FacilityRegistry({ now: () => Date.now() });
    const f = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(3),
    });
    fr.reserveSlot(f.id, 0, BOT_A);
    expect(fr.markPlacementFailed(f.id, 0, "entity_blocking", BOT_A)).toBe(true);
    expect(f.slots[0]!.status).toBe("temporarily_blocked");
    expect(f.slots[0]!.failureCount).toBe(1);
    expect(f.slots[0]!.lastFailureAtMs).not.toBeNull();

    // 退避期内 nextPlannableSlot 跳过该 slot
    vi.advanceTimersByTime(1_000);
    expect(fr.nextPlannableSlot(f.id)!.index).toBe(1);

    // 退避期过后可以重试（replanSlot → planned）
    vi.advanceTimersByTime(baseBackoffMs(1) + 1_000);
    expect(fr.replanSlot(f.id, 0)).toBe(true);
    expect(f.slots[0]!.status).toBe("planned");

    function baseBackoffMs(failures: number): number {
      return 10_000 * 2 ** Math.max(0, failures - 1); // 10s, 20s, 40s...
    }
  });

  it("repeated failures escalate backoff (failureCount grows, delay doubles)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    const fr = new FacilityRegistry({ now: () => Date.now() });
    const f = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(1),
    });
    fr.reserveSlot(f.id, 0, BOT_A);
    fr.markPlacementFailed(f.id, 0, "fail-1", BOT_A);
    fr.replanSlot(f.id, 0);
    fr.reserveSlot(f.id, 0, BOT_A);
    fr.markPlacementFailed(f.id, 0, "fail-2", BOT_A);
    fr.replanSlot(f.id, 0);
    fr.reserveSlot(f.id, 0, BOT_A);
    fr.markPlacementFailed(f.id, 0, "fail-3", BOT_A);
    expect(f.slots[0]!.failureCount).toBe(3);
    // 第 3 次失败退避 40s：10s 内 replan 被拒
    vi.advanceTimersByTime(10_000);
    expect(fr.replanSlot(f.id, 0)).toBe(false);
    vi.advanceTimersByTime(31_000);
    expect(fr.replanSlot(f.id, 0)).toBe(true);
    vi.useRealTimers();
  });

  it("success clears failure history", () => {
    const fr = new FacilityRegistry();
    const f = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(1),
    });
    fr.reserveSlot(f.id, 0, BOT_A);
    fr.markPlacementFailed(f.id, 0, "fail", BOT_A);
    fr.replanSlot(f.id, 0);
    fr.reserveSlot(f.id, 0, BOT_A);
    fr.markSlotOccupied(f.id, 0, "ws-1");
    expect(f.slots[0]!.failureCount).toBe(0);
    expect(f.slots[0]!.lastFailureAtMs).toBeNull();
  });
});

describe("stable slotId (十二)", () => {
  it("every slot has a stable id containing facility identity + position, not just index", () => {
    const fr = new FacilityRegistry();
    const f = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 5, y: 64, z: 7 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(2),
    });
    const [s0, s1] = f.slots as FacilitySlot[];
    expect(s0.slotId).toBe(`${f.id}#0`);
    expect(s1.slotId).toBe(`${f.id}#1`);
    expect(new Set([s0.slotId, s1.slotId]).size).toBe(2);
    // 重启恢复后 id 不变
    const restored = FacilityRegistry.restore(fr.serialize());
    expect(restored.get(f.id)!.slots[0]!.slotId).toBe(s0.slotId);
  });
});

describe("maxFacilitiesPerServer enforcement (十三)", () => {
  it("enforces the limit per server+dimension and rejects beyond it", () => {
    const fr = new FacilityRegistry({ maxFacilitiesPerServer: 2 });
    const mk = (x: number, server = SERVER, dim = DIM) =>
      fr.create({
        facilityType: "smelting_zone", serverProfileId: server, dimension: dim,
        anchor: { x, y: 64, z: 0 }, orientation: "north",
        layoutVersion: "v1", patternSlots: smeltingLinePattern(1),
      });
    mk(0);
    mk(1);
    expect(() => mk(2)).toThrow(/maxFacilities/);
    // scope 是 server+dimension：别的 dimension / 别的 server 不受限
    expect(() => mk(0, SERVER, DIM_NETHER)).not.toThrow();
    expect(() => mk(0, SERVER_2, DIM)).not.toThrow();
    // 幂等 create（同 anchor）不算新 facility
    expect(() => mk(0)).not.toThrow();
    expect(fr.size).toBe(4);
  });
});

describe("WorkstationType unification (七)", () => {
  it("FacilitySlot.workstationType is the shared WorkstationType union", () => {
    const fr = new FacilityRegistry();
    const f = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(1),
    });
    // 编译期即约束；运行时再验证一次值域
    const type: WorkstationType = f.slots[0]!.workstationType;
    expect(type).toBe("furnace");
  });
});

describe("Facility → Base binding (三十三)", () => {
  it("facility can be bound to a baseId and queried back", () => {
    const fr = new FacilityRegistry();
    const f = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(1),
      baseId: "base-abc123",
    });
    expect(f.baseId).toBe("base-abc123");
    expect(fr.findByBase("base-abc123")).toEqual([f]);

    const unbound = fr.create({
      facilityType: "crafting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 10, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(1),
    });
    expect(unbound.baseId).toBeNull();
    expect(fr.findByBase("base-none")).toEqual([]);
  });
});
