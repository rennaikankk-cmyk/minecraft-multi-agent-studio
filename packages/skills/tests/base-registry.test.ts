// ---------------------------------------------------------------------------
// BaseRegistry + starter_base_v1 + MaterialResolver + BlueprintReconciler
// 回归测试（Phase 9-12，先写失败测试）
// ---------------------------------------------------------------------------
import { describe, expect, it, vi } from "vitest";

import {
  BaseRegistry,
  type BaseRecord,
  reconcileBlueprint,
  resolveMaterials,
  starterBaseV1,
  type StarterBaseParams,
} from "../src/base-registry.js";
import {
  isIntermediateBlueprintSafe,
  orderBlueprintCells,
  type Blueprint,
} from "../src/planning/blueprint-planner.js";

const SERVER = "base-test-profile";
const DIM = "minecraft:overworld";
const BOT_A = "studio-bot-01";
const BOT_B = "studio-bot-02";
const ANCHOR = { x: 1000, y: 64, z: -2000 };

function baseParams(overrides: Partial<StarterBaseParams> = {}): StarterBaseParams {
  return { serverProfileId: SERVER, dimension: DIM, anchor: ANCHOR, ...overrides };
}

describe("starter_base_v1 blueprint shape", () => {
  it("generates a valid Blueprint with anchor/dimension/server bound", () => {
    const bp = starterBaseV1(baseParams());
    expect(bp.anchor).toEqual(ANCHOR);
    expect(bp.dimension).toBe(DIM);
    expect(bp.serverProfileId).toBe(SERVER);
    expect(bp.cells.length).toBeGreaterThan(40);
  });

  it("has a full foundation floor (5x5) and a complete roof", () => {
    const bp = starterBaseV1(baseParams());
    const floor = bp.cells.filter((c) => c.offset.y === 0);
    const roof = bp.cells.filter((c) => c.offset.y === 3);
    expect(floor).toHaveLength(25);
    expect(roof).toHaveLength(25);
  });

  it("has walls with a 2-high doorway gap at south center", () => {
    const bp = starterBaseV1(baseParams());
    const wallAt = (x: number, z: number, y: number) =>
      bp.cells.find((c) => c.offset.x === x && c.offset.z === z && c.offset.y === y);
    // 门口 (x=2, z=4) y=1..2 必须为空
    expect(wallAt(2, 4, 1)).toBeUndefined();
    expect(wallAt(2, 4, 2)).toBeUndefined();
    // 门侧立柱存在
    expect(wallAt(1, 4, 1)).toBeDefined();
    expect(wallAt(3, 4, 1)).toBeDefined();
  });

  it("includes survival workstations: crafting table, furnace, chest, torches", () => {
    const bp = starterBaseV1(baseParams());
    const items = new Set(bp.cells.map((c) => c.itemName));
    expect(items.has("crafting_table")).toBe(true);
    expect(items.has("furnace")).toBe(true);
    expect(items.has("chest")).toBe(true);
    expect(items.has("torch")).toBe(true);
  });

  it("orders safely: floor → walls → roof → workstations → torches (prefix-safe)", () => {
    const bp = starterBaseV1(baseParams());
    const ordered = orderBlueprintCells(bp);
    expect(isIntermediateBlueprintSafe(ordered)).toBe(true);
    // 屋顶（shell）在工作站（utility）之前完成？不：utility 优先于 shell
    // （CLASS_RANK: structural < utility < shell < decoration）
    const ranks = ordered.map((c) => c.blockClass);
    const firstRoof = ranks.indexOf("shell");
    const firstTorch = ranks.indexOf("decoration");
    expect(firstRoof).toBeGreaterThanOrEqual(0);
    expect(firstTorch).toBeGreaterThan(firstRoof);
  });

  it("is deterministic: same params → identical cells", () => {
    const a = starterBaseV1(baseParams());
    const b = starterBaseV1(baseParams());
    expect(a.cells).toEqual(b.cells);
  });

  it("anchors are absolute: cell offsets translate to world via anchor", () => {
    const bp = starterBaseV1(baseParams());
    const cell = bp.cells.find((c) => c.offset.x === 0 && c.offset.y === 0 && c.offset.z === 0);
    expect(cell).toBeDefined();
  });
});

describe("resolveMaterials (MaterialResolver)", () => {
  it("aggregates per-item counts for the full blueprint", () => {
    const bp = starterBaseV1(baseParams());
    const materials = resolveMaterials(bp);
    expect(materials.get("cobblestone")).toBe(25);
    expect((materials.get("oak_planks") ?? 0)).toBeGreaterThanOrEqual(50);
    expect(materials.get("crafting_table")).toBe(1);
    expect(materials.get("furnace")).toBe(1);
    expect(materials.get("chest")).toBe(1);
    expect((materials.get("torch") ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it("returns shortfall against available inventory", () => {
    const bp = starterBaseV1(baseParams());
    const available = new Map([
      ["cobblestone", 25],
      ["oak_planks", 10],
    ]);
    const shortfall = resolveMaterials(bp, available);
    expect(shortfall.get("oak_planks")).toBe((resolveMaterials(bp).get("oak_planks") ?? 0) - 10);
    expect(shortfall.get("crafting_table")).toBe(1);
    expect(shortfall.has("cobblestone")).toBe(false);
  });
});

describe("BaseRegistry lifecycle", () => {
  function makeRegistry() {
    return new BaseRegistry();
  }

  it("creates a base with stable id bound to server+dimension+anchor", () => {
    const reg = makeRegistry();
    const base = reg.create({
      name: "hideout-1", serverProfileId: SERVER, dimension: DIM,
      anchor: ANCHOR, blueprintId: "starter_base_v1",
    });
    expect(base.id).toContain("base");
    expect(base.status).toBe("planned");
    // 幂等：同 anchor 再 create 返回同一记录
    const again = reg.create({
      name: "hideout-1b", serverProfileId: SERVER, dimension: DIM,
      anchor: ANCHOR, blueprintId: "starter_base_v1",
    });
    expect(again.id).toBe(base.id);
  });

  it("different anchor or server → different id", () => {
    const reg = makeRegistry();
    const a = reg.create({ name: "a", serverProfileId: SERVER, dimension: DIM, anchor: { x: 1, y: 64, z: 1 }, blueprintId: "starter_base_v1" });
    const b = reg.create({ name: "b", serverProfileId: SERVER, dimension: DIM, anchor: { x: 2, y: 64, z: 1 }, blueprintId: "starter_base_v1" });
    const c = reg.create({ name: "c", serverProfileId: "other", dimension: DIM, anchor: { x: 1, y: 64, z: 1 }, blueprintId: "starter_base_v1" });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("lifecycle: planned → building → operational → damaged → operational", () => {
    const reg = makeRegistry();
    const base = reg.create({ name: "x", serverProfileId: SERVER, dimension: DIM, anchor: ANCHOR, blueprintId: "starter_base_v1" });
    expect(reg.markBuilding(base.id, BOT_A)).toBe(true);
    expect(reg.get(base.id)!.status).toBe("building");
    expect(reg.markOperational(base.id)).toBe(true);
    expect(reg.get(base.id)!.status).toBe("operational");
    expect(reg.markDamaged(base.id, "griefed_south_wall")).toBe(true);
    const damaged = reg.get(base.id)!;
    expect(damaged.status).toBe("damaged");
    expect(damaged.integrity01).toBeLessThan(1);
    expect(reg.markOperational(base.id)).toBe(true);
  });

  it("rejects illegal transitions", () => {
    const reg = makeRegistry();
    const base = reg.create({ name: "x", serverProfileId: SERVER, dimension: DIM, anchor: ANCHOR, blueprintId: "starter_base_v1" });
    expect(reg.markOperational(base.id)).toBe(false); // planned 不能直接 operational
    expect(reg.markBuilding(base.id, BOT_A)).toBe(true);
    expect(reg.markDamaged(base.id, "x")).toBe(false); // building 不能直接 damaged
  });

  it("abandon is terminal", () => {
    const reg = makeRegistry();
    const base = reg.create({ name: "x", serverProfileId: SERVER, dimension: DIM, anchor: ANCHOR, blueprintId: "starter_base_v1" });
    reg.markBuilding(base.id, BOT_A);
    reg.markOperational(base.id);
    expect(reg.markAbandoned(base.id, "moved_away")).toBe(true);
    expect(reg.markBuilding(base.id, BOT_A)).toBe(false);
  });

  it("findBases returns server+dimension bases ordered by distance", () => {
    const reg = makeRegistry();
    reg.create({ name: "near", serverProfileId: SERVER, dimension: DIM, anchor: { x: 110, y: 64, z: 0 }, blueprintId: "starter_base_v1" });
    reg.create({ name: "far", serverProfileId: SERVER, dimension: DIM, anchor: { x: 900, y: 64, z: 0 }, blueprintId: "starter_base_v1" });
    reg.create({ name: "other-server", serverProfileId: "other", dimension: DIM, anchor: { x: 100, y: 64, z: 0 }, blueprintId: "starter_base_v1" });
    const bases = reg.findBases(SERVER, DIM, { x: 100, y: 64, z: 0 });
    expect(bases.map((b) => b.name)).toEqual(["near", "far"]);
  });

  it("serializes/restores with state intact", () => {
    const reg = makeRegistry();
    const base = reg.create({ name: "x", serverProfileId: SERVER, dimension: DIM, anchor: ANCHOR, blueprintId: "starter_base_v1" });
    reg.markBuilding(base.id, BOT_A);
    const restored = BaseRegistry.restore(reg.serialize());
    expect(restored.get(base.id)!.status).toBe("building");
  });

  it("multi-bot cell reservation: no double-claim, TTL expiry, release", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    const reg = makeRegistry({ now: () => Date.now() });
    const base = reg.create({ name: "x", serverProfileId: SERVER, dimension: DIM, anchor: ANCHOR, blueprintId: "starter_base_v1" });
    reg.markBuilding(base.id, BOT_A);
    expect(reg.reserveCell(base.id, 0, BOT_A)).toBe(true);
    expect(reg.reserveCell(base.id, 0, BOT_B)).toBe(false); // 双占失败
    expect(reg.reserveCell(base.id, 1, BOT_B)).toBe(true); // 不同 cell 各自可占
    reg.releaseCell(base.id, 0, BOT_A);
    expect(reg.reserveCell(base.id, 0, BOT_B)).toBe(true); // 释放后可被他人占
    vi.advanceTimersByTime(61_000);
    expect(reg.reserveCell(base.id, 2, BOT_A)).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(reg.expireCellReservations(base.id)).toBeGreaterThan(0); // TTL 过期释放
    vi.useRealTimers();
  });

  it("markCellPlaced tracks progress and flips status at completion", () => {
    const reg = makeRegistry();
    const base = reg.create({ name: "x", serverProfileId: SERVER, dimension: DIM, anchor: ANCHOR, blueprintId: "starter_base_v1" });
    reg.markBuilding(base.id, BOT_A);
    const bp = starterBaseV1(baseParams());
    const total = bp.cells.length;
    expect(reg.setTotalCells(base.id, total)).toBe(true);
    for (let i = 0; i < total - 1; i += 1) reg.markCellPlaced(base.id, i);
    expect(reg.get(base.id)!.status).toBe("building");
    reg.markCellPlaced(base.id, total - 1);
    const done = reg.get(base.id)!;
    expect(done.status).toBe("operational");
    expect(done.integrity01).toBe(1);
  });
});

describe("reconcileBlueprint (BlueprintReconciler core)", () => {
  const bp: Blueprint = starterBaseV1(baseParams());

  it("classifies placed / missing / wrong; unobserved cells stay out of the verdict", () => {
    const floorOffset = bp.cells[0]!.offset;
    const observations = new Map<string, string | null>([
      // 第一个 cell 放对了
      [JSON.stringify(floorOffset), bp.cells[0]!.itemName],
      // 某个 cell 位置放了错方块
      [JSON.stringify({ x: 4, y: 0, z: 4 }), "dirt"],
    ]);
    const result = reconcileBlueprint(bp, observations);
    expect(result.placed).toHaveLength(1);
    expect(result.wrong).toHaveLength(1);
    expect(result.wrong[0]!.expectedItemName).toBe("cobblestone");
    expect(result.wrong[0]!.observedItemName).toBe("dirt");
    // 未观测的不猜测：missing=0，unobserved=其余
    expect(result.missing).toHaveLength(0);
    expect(result.unobserved).toBe(bp.cells.length - 2);
  });

  it("treats observed null (air) on unbuilt cell as missing, and computes integrity01", () => {
    const observations = new Map<string, string | null>([
      [JSON.stringify(bp.cells[0]!.offset), bp.cells[0]!.itemName],
      [JSON.stringify(bp.cells[1]!.offset), null],
    ]);
    const result = reconcileBlueprint(bp, observations);
    expect(result.missing.length).toBe(1);
    expect(result.integrity01).toBeCloseTo(1 / bp.cells.length, 5);
  });

  it("repair plan: only observed wrong/missing cells, in build order", () => {
    const observations = new Map<string, string | null>([
      [JSON.stringify(bp.cells[0]!.offset), bp.cells[0]!.itemName],
      // 一个放错的位置
      [JSON.stringify({ x: 4, y: 0, z: 4 }), "dirt"],
      // 一个缺失的位置（空气）
      [JSON.stringify({ x: 3, y: 0, z: 4 }), null],
    ]);
    const result = reconcileBlueprint(bp, observations);
    expect(result.repairOrder).toHaveLength(2);
    // 修复顺序遵循 class rank（两个都是 foundation，按 order 字段稳定排序）
    expect(result.repairOrder.every((c) => c.blockClass === "foundation")).toBe(true);
  });
});
