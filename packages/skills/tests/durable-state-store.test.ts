// ---------------------------------------------------------------------------
// DurableStateStore 回归测试（Phase 6：durable world-memory / persistence）
//
// 契约（十六节）：
//   Durable（必须持久化）：Base 身份/进度、Facility 身份/slot 语义状态、
//                         workstation 观测（不含 lease）
//   Ephemeral（绝不持久化，重启即弃）：workstation lease、placement reservation、
//                         cell build reservation
//   原子写：tmp + rename，进程崩溃不留半截文件
// ---------------------------------------------------------------------------
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BaseRegistry,
  starterBaseV1,
} from "../src/base-registry.js";
import {
  DurableStateStore,
  durableSnapshotFrom,
  registriesFromDurableSnapshot,
  stripEphemeralState,
} from "../src/durable-state-store.js";
import { FacilityRegistry, smeltingLinePattern } from "../src/facility-registry.js";
import { InMemoryWorkstationRegistry } from "../src/workstation-registry.js";

const SERVER = "persist-profile";
const DIM = "minecraft:overworld";
const BOT_A = "studio-bot-01";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-durable-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("stripEphemeralState (durable vs ephemeral split)", () => {
  it("strips workstation leases but keeps observations", () => {
    const wsReg = new InMemoryWorkstationRegistry();
    wsReg.register(SERVER, DIM, "furnace", { x: 1, y: 64, z: 1 });
    wsReg.claim(SERVER, DIM, { x: 1, y: 64, z: 1 }, BOT_A, 60_000);

    const snapshot = stripEphemeralState(durableSnapshotFrom(wsReg, new FacilityRegistry(), new BaseRegistry()));
    expect(snapshot.workstations.entries).toHaveLength(1);
    expect(snapshot.workstations.entries[0]!.lease).toBeNull();
    expect(snapshot.workstations.entries[0]!.lastSeenAt).toBeGreaterThan(0);
  });

  it("strips facility placement reservations: placement_reserved → planned (reason recorded)", () => {
    const fr = new FacilityRegistry();
    const f = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(2),
    });
    fr.reserveSlot(f.id, 0, BOT_A, 60_000);

    const snapshot = stripEphemeralState(durableSnapshotFrom(new InMemoryWorkstationRegistry(), fr, new BaseRegistry()));
    const restored = snapshot.facilities.facilities[0]!;
    expect(restored.slots[0]!.status).toBe("planned");
    expect(restored.slots[0]!.reservedBy).toBeNull();
    expect(restored.slots[0]!.reservedUntilMs).toBeNull();
    // 语义状态保留
    expect(restored.slots[0]!.failureCount).toBe(0);
  });

  it("keeps semantic slot states (occupied/missing/invalid/temporarily_blocked)", () => {
    const fr = new FacilityRegistry();
    const f = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(4),
    });
    fr.reserveSlot(f.id, 0, BOT_A); fr.markSlotOccupied(f.id, 0, "ws-1");
    fr.reserveSlot(f.id, 1, BOT_A); fr.markSlotOccupied(f.id, 1, "ws-2");
    fr.markSlotMissing(f.id, 1, "griefed");
    fr.markSlotInvalid(f.id, 2, "bedrock");

    const snapshot = stripEphemeralState(durableSnapshotFrom(new InMemoryWorkstationRegistry(), fr, new BaseRegistry()));
    const slots = snapshot.facilities.facilities[0]!.slots;
    expect(slots[0]!.status).toBe("occupied");
    expect(slots[0]!.workstationEntryKey).toBe("ws-1");
    expect(slots[1]!.status).toBe("missing");
    expect(slots[2]!.status).toBe("invalid");
  });

  it("keeps base records and progress", () => {
    const bases = new BaseRegistry();
    const base = bases.create({
      name: "hideout", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 100, y: 64, z: 100 }, blueprintId: "starter_base_v1",
    });
    bases.markBuilding(base.id, BOT_A);
    const bp = starterBaseV1({ serverProfileId: SERVER, dimension: DIM, anchor: { x: 100, y: 64, z: 100 } });
    bases.setTotalCells(base.id, bp.cells.length);
    bases.markCellPlaced(base.id, 3);

    const snapshot = stripEphemeralState(durableSnapshotFrom(new InMemoryWorkstationRegistry(), new FacilityRegistry(), bases));
    expect(snapshot.bases.bases).toHaveLength(1);
    expect(snapshot.bases.bases[0]!.status).toBe("building");
    expect(snapshot.bases.bases[0]!.placedCells).toBe(1);
    expect(snapshot.bases.bases[0]!.placedCellIndices).toEqual([3]);
  });
});

describe("DurableStateStore atomic persistence", () => {
  it("save → load round-trips across 'restart'", () => {
    const dir = tmpDir();
    const store = new DurableStateStore(join(dir, "state.json"));

    const wsReg = new InMemoryWorkstationRegistry();
    const fr = new FacilityRegistry();
    const bases = new BaseRegistry();
    wsReg.register(SERVER, DIM, "furnace", { x: 5, y: 64, z: 5 });
    wsReg.claim(SERVER, DIM, { x: 5, y: 64, z: 5 }, BOT_A); // ephemeral
    const f = fr.create({
      facilityType: "smelting_zone", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north",
      layoutVersion: "v1", patternSlots: smeltingLinePattern(2),
    });
    fr.reserveSlot(f.id, 0, BOT_A); fr.markSlotOccupied(f.id, 0, "ws-1");

    store.save(durableSnapshotFrom(wsReg, fr, bases));

    // “重启”：全新实例从磁盘恢复
    const restored = registriesFromDurableSnapshot(store.load()!);
    expect(restored.workstations.get(SERVER, DIM, { x: 5, y: 64, z: 5 })).not.toBeNull();
    expect(restored.workstations.get(SERVER, DIM, { x: 5, y: 64, z: 5 })!.lease).toBeNull();
    const restoredFacility = restored.facilities.get(f.id)!;
    expect(restoredFacility.slots[0]!.status).toBe("occupied");
    expect(restoredFacility.slots[1]!.status).toBe("planned");
  });

  it("load on missing file returns null (first boot)", () => {
    const store = new DurableStateStore(join(tmpDir(), "nonexistent.json"));
    expect(store.load()).toBeNull();
  });

  it("atomic write: no tmp file left behind; file is valid JSON after save", () => {
    const dir = tmpDir();
    const path = join(dir, "state.json");
    const store = new DurableStateStore(path);
    store.save(durableSnapshotFrom(new InMemoryWorkstationRegistry(), new FacilityRegistry(), new BaseRegistry()));
    JSON.parse(readFileSync(path, "utf8")); // 不抛即合法
    const leftovers = join(dir, "state.json.tmp");
    expect(existsSync(leftovers)).toBe(false);
  });

  it("corruption is observable and retains the original file", () => {
    const dir = tmpDir();
    const path = join(dir, "state.json");
    const store = new DurableStateStore(path);
    writeFileSync(path, "{corrupt!!", "utf8");
    expect(() => store.load()).toThrow("DURABLE_STATE_INVALID");
    expect(existsSync(path)).toBe(true);
  });

  it("repeated saves are idempotent in content structure", () => {
    const dir = tmpDir();
    const store = new DurableStateStore(join(dir, "state.json"));
    const snap = durableSnapshotFrom(new InMemoryWorkstationRegistry(), new FacilityRegistry(), new BaseRegistry());
    store.save(snap);
    store.save(snap);
    const loaded = store.load()!;
    expect(loaded.facilities.facilities).toHaveLength(0);
  });
});

describe("BaseRegistry restore preserves abandoned history (inactive but remembered)", () => {
  it("abandoned base survives persistence as historical record", () => {
    const bases = new BaseRegistry();
    const base = bases.create({
      name: "old-hideout", serverProfileId: SERVER, dimension: DIM,
      anchor: { x: 1, y: 64, z: 1 }, blueprintId: "starter_base_v1",
    });
    bases.markBuilding(base.id, BOT_A);
    bases.markOperational(base.id);
    bases.markAbandoned(base.id, "moved_away");

    const snapshot = stripEphemeralState(durableSnapshotFrom(new InMemoryWorkstationRegistry(), new FacilityRegistry(), bases));
    const restored = BaseRegistry.restore(snapshot.bases);
    const record = restored.get(base.id)!;
    expect(record.status).toBe("abandoned"); // 历史保留
    expect(record.lastStatusReason).toBe("moved_away");
    // abandoned 是终态：恢复后不能再 building
    expect(restored.markBuilding(base.id, BOT_A)).toBe(false);
  });
});
