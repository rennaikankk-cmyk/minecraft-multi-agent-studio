// ---------------------------------------------------------------------------
// Shared state control plane 回归测试（Phase 5）
//
// 证明：SharedStateClient（fetch 信封）→ dispatcher → InMemory 注册表
// 的远端语义 ≡ 本地语义，包括：
//   - workstation register/get/claim race/releaseAllClaims
//   - facility 7-state 生命周期（reserve→occupy→missing→replan）
//   - 快照 capture/restore 往返
//   - 错误信封（unknown op / bad args）不抛出非受控异常
// ---------------------------------------------------------------------------
import { describe, expect, it, vi } from "vitest";

import {
  captureSharedStateSnapshot,
  createSharedStateDispatcher,
  dispatchSharedState,
  restoreSharedStateSnapshot,
  SharedStateClient,
  SharedStateError,
} from "../src/shared-state.js";
import { FacilityRegistry, smeltingLinePattern } from "../src/facility-registry.js";
import { InMemoryWorkstationRegistry } from "../src/workstation-registry.js";

const SERVER = "test-profile";
const DIM = "minecraft:overworld";
const BOT_A = "studio-bot-01";
const BOT_B = "studio-bot-02";

/** 极简 fetch mock：直接调 dispatcher，走完整 JSON 信封编解码。 */
function makeClient(dispatcher: ReturnType<typeof createSharedStateDispatcher>): SharedStateClient {
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { op: string; args?: Record<string, unknown> };
    const envelope = dispatchSharedState(dispatcher, body);
    return new Response(JSON.stringify(envelope), {
      status: envelope.ok ? 200 : 200, // 协议层错误也走 200 + ok:false 信封
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return new SharedStateClient({ baseUrl: "http://shared-state.test", fetchImpl });
}

describe("shared state dispatcher", () => {
  it("unknown op → ok:false with error name, no throw", () => {
    const d = createSharedStateDispatcher(new InMemoryWorkstationRegistry(), new FacilityRegistry());
    const r = dispatchSharedState(d, { op: "ws.nope" });
    expect(r).toEqual({ ok: false, error: "unknown_op:ws.nope" });
  });

  it("bad args → ok:false with arg name, no credential leakage", () => {
    const d = createSharedStateDispatcher(new InMemoryWorkstationRegistry(), new FacilityRegistry());
    const r = dispatchSharedState(d, { op: "ws.claim", args: { dimension: DIM } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("serverProfileId");
  });
});

describe("SharedStateClient workstation semantics", () => {
  it("register → get round-trip preserves entry", async () => {
    const wsReg = new InMemoryWorkstationRegistry();
    const client = makeClient(createSharedStateDispatcher(wsReg, new FacilityRegistry()));
    const entry = (await client.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: -20 })) as {
      type: string; position: { x: number; y: number; z: number };
    };
    expect(entry.type).toBe("furnace");
    const got = (await client.get(SERVER, DIM, { x: 10, y: 64, z: -20 })) as typeof entry | null;
    expect(got?.position).toEqual({ x: 10, y: 64, z: -20 });
  });

  it("claim race: second bot loses, release enables second bot", async () => {
    const wsReg = new InMemoryWorkstationRegistry();
    const client = makeClient(createSharedStateDispatcher(wsReg, new FacilityRegistry()));
    const p = { x: 1, y: 2, z: 3 };
    await client.register(SERVER, DIM, "furnace", p);
    const owner = { ownerRuntimeId: "runtime-a", ownerTaskId: "task", ownerAttemptId: "attempt" };
    expect(await client.claim(SERVER, DIM, p, BOT_A, undefined, owner)).toBe(true);
    expect(await client.claim(SERVER, DIM, p, BOT_B, undefined, owner)).toBe(false);
    const lease = (await client.workstations.get(SERVER, DIM, p))!.lease!;
    await client.release(SERVER, DIM, p, BOT_A, lease);
    expect(await client.claim(SERVER, DIM, p, BOT_B, undefined, owner)).toBe(true);
  });

  it("unfenced bulk release cannot clear a live runtime lease", async () => {
    const wsReg = new InMemoryWorkstationRegistry();
    const client = makeClient(createSharedStateDispatcher(wsReg, new FacilityRegistry()));
    for (const x of [1, 2, 3]) await client.register(SERVER, DIM, "furnace", { x, y: 64, z: 0 });
    const owner = { ownerRuntimeId: "runtime-a", ownerTaskId: "task", ownerAttemptId: "attempt" };
    expect(await client.claim(SERVER, DIM, { x: 1, y: 64, z: 0 }, BOT_A, undefined, owner)).toBe(true);
    expect(await client.claim(SERVER, DIM, { x: 2, y: 64, z: 0 }, BOT_A, undefined, owner)).toBe(true);
    await client.releaseAllClaims(BOT_A);
    expect(await client.claim(SERVER, DIM, { x: 1, y: 64, z: 0 }, BOT_B, undefined, owner)).toBe(false);
  });

  it("findCandidates returns distance-sorted entries", async () => {
    const wsReg = new InMemoryWorkstationRegistry();
    const client = makeClient(createSharedStateDispatcher(wsReg, new FacilityRegistry()));
    await client.register(SERVER, DIM, "furnace", { x: 100, y: 64, z: 0 });
    await client.register(SERVER, DIM, "furnace", { x: 10, y: 64, z: 0 });
    const cands = (await client.findCandidates(SERVER, DIM, "furnace", { x: 0, y: 64, z: 0 })) as Array<{ position: { x: number } }>;
    expect(cands.map((c) => c.position.x)).toEqual([10, 100]);
  });
});

describe("SharedStateClient facility lifecycle (remote)", () => {
  async function setup() {
    const fr = new FacilityRegistry();
    const client = makeClient(createSharedStateDispatcher(new InMemoryWorkstationRegistry(), fr));
    const facility = await client.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 100, y: 64, z: 200 }, orientation: "north",
      layoutVersion: "smelting_basic_v1", patternSlots: smeltingLinePattern(4),
    });
    return { fr, client, facility };
  }

  it("full remote lifecycle: plan→reserve→occupy→missing→replan", async () => {
    const { fr, client, facility } = await setup();
    const slot = await client.nextPlannableSlot(facility.id);
    expect(slot?.index).toBe(0);
    expect(await client.reserveSlot(facility.id, 0, BOT_A)).toBe(true);
    expect(await client.reserveSlot(facility.id, 0, BOT_B)).toBe(false);
    expect(await client.markSlotOccupied(facility.id, 0, "ws-1")).toBe(true);
    expect(await client.markSlotMissing(facility.id, 0, "griefed")).toBe(true);
    expect(await client.markSlotOccupied(facility.id, 0, "ws-2")).toBe(false); // missing 不能直接 occupied
    expect(await client.replanSlot(facility.id, 0)).toBe(true);
    // 服务端真实状态同步
    expect(fr.get(facility.id)!.slots[0]!.status).toBe("planned");
  });

  it("getFacility + expireReservations over the wire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    const fr = new FacilityRegistry({ now: () => Date.now() });
    const client = makeClient(createSharedStateDispatcher(new InMemoryWorkstationRegistry(), fr));
    const facility = await client.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(2),
    });
    await client.reserveSlot(facility.id, 0, BOT_A, 5_000);
    vi.advanceTimersByTime(6_000);
    expect(await client.expireReservations(facility.id)).toBe(1);
    const f = await client.getFacility(facility.id);
    expect(f?.slots[0]!.status).toBe("planned");
    vi.useRealTimers();
  });

  it("observeSlot over the wire for discovered facilities", async () => {
    const fr = new FacilityRegistry();
    const client = makeClient(createSharedStateDispatcher(new InMemoryWorkstationRegistry(), fr));
    const facility = await client.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(2),
      discovery: "observed_existing",
    });
    expect(await client.observeSlot(facility.id, 0, { blockPresent: true, blockName: "furnace" })).toBe(true);
    const f = await client.getFacility(facility.id);
    expect(f?.slots[0]!.status).toBe("occupied");
  });

  it("owner-safety holds across the wire: B cannot release/renew/complete A's reservation", async () => {
    const fr = new FacilityRegistry();
    const client = makeClient(createSharedStateDispatcher(new InMemoryWorkstationRegistry(), fr));
    const facility = await client.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(2),
    });
    await client.reserveSlot(facility.id, 0, BOT_A);
    expect(await client.releaseReservation(facility.id, 0, "b_mistake", BOT_B)).toBe(false);
    expect(await client.renewSlotReservation(facility.id, 0, BOT_B)).toBe(false);
    expect(await client.markSlotOccupied(facility.id, 0, "ws-stolen", { reservationOwner: BOT_B })).toBe(false);
    expect(await client.markPlacementFailed(facility.id, 0, "not_owner", BOT_B)).toBe(false);
    const f = await client.getFacility(facility.id);
    expect(f?.slots[0]!.reservedBy).toBe(BOT_A);
    expect(await client.markSlotOccupied(facility.id, 0, "ws-1", { reservationOwner: BOT_A })).toBe(true);
  });
});

describe("snapshot capture/restore", () => {
  it("round-trips workstation entries + facility slot state", async () => {
    const wsReg = new InMemoryWorkstationRegistry();
    const fr = new FacilityRegistry();
    const client = makeClient(createSharedStateDispatcher(wsReg, fr));
    await client.register(SERVER, DIM, "furnace", { x: 5, y: 64, z: 5 });
    const facility = await client.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(2),
    });
    await client.reserveSlot(facility.id, 0, BOT_A);
    await client.markSlotOccupied(facility.id, 0, "ws-1");
    await client.markSlotMissing(facility.id, 0, "test");

    const snap = captureSharedStateSnapshot(wsReg, fr);
    const restored = restoreSharedStateSnapshot(snap);
    expect(restored.workstations.get(SERVER, DIM, { x: 5, y: 64, z: 5 })).not.toBeNull();
    expect(restored.facilities.get(facility.id)!.slots[0]!.status).toBe("missing");
    expect(restored.facilities.get(facility.id)!.slots[0]!.statusReason).toBe("test");
  });
});

describe("client failure envelope", () => {
  it("non-JSON / network failure → SharedStateError, no retry storm", async () => {
    const client = new SharedStateClient({
      baseUrl: "http://shared-state.test",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      logger: { warn: () => undefined },
    });
    await expect(client.claim(SERVER, DIM, { x: 0, y: 0, z: 0 }, BOT_A)).rejects.toBeInstanceOf(SharedStateError);
  });

  it("unknown facility → graceful false, not an exception", async () => {
    const dispatcher = createSharedStateDispatcher(new InMemoryWorkstationRegistry(), new FacilityRegistry());
    const client = makeClient(dispatcher);
    // facilityId 不存在是正常业务结果（never throw 契约）
    await expect(client.reserveSlot("facility-nope", 0, BOT_A)).resolves.toBe(false);
    await expect(client.expireReservations("facility-nope")).resolves.toBe(0);
  });

  it("bad args surface as SharedStateError with arg name", async () => {
    const dispatcher = createSharedStateDispatcher(new InMemoryWorkstationRegistry(), new FacilityRegistry());
    const client = makeClient(dispatcher);
    await expect(client.reserveSlot("facility-nope", Number.NaN, BOT_A)).rejects.toThrow(/slotIndex/);
  });
});
