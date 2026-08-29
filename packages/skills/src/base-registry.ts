// ---------------------------------------------------------------------------
// BaseRegistry + starter_base_v1 + MaterialResolver + BlueprintReconciler
//
// Phase 9-12 垂直切片：命名基地（Base）是 Facility 之上的最高层组织单位。
//
//   starterBaseV1()   确定性生成 starter_base_v1 蓝图（5x5 生存小屋）
//   resolveMaterials()  蓝图 → 材料需求 / 缺口（MaterialResolver）
//   BaseRegistry      基地生命周期 + 多 Bot cell 级施工预约（稳定 id）
//   reconcileBlueprint() 观测 vs 蓝图 → placed/missing/wrong + 修复顺序
//
// 契约：
//   1. baseId 确定性（server+dimension+anchor），create 幂等——同 Facility
//   2. 生命周期 planned→building→operational→(damaged⇄operational)→abandoned，
//      非法跳变拒绝；abandoned 终态
//   3. cell 预约有 TTL 防呆（bot 崩溃不永久卡死施工位）
//   4. 状态机与时钟可注入；serialize/restore 支持跨进程
//
// starter_base_v1 布局（local 坐标，x∈[0,4] z∈[0,4]，y 0=地板 1/2=墙 3=顶）：
//   - 地板 5x5 cobblestone（foundation）
//   - 周墙 oak_planks（structural），南墙中 (2,4) y1..2 留 2 高门洞
//   - 顶 5x5 oak_planks（shell）
//   - 室内工作站（utility）：furnace(1,1) crafting_table(3,1) chest(1,3)
//   - 火把（decoration）：室内 (3,3)、(2,2)
//   限制（v1 已知，不做虚假承诺）：bed 需要 2 格对齐放置，v1 不含床；
//   顶板中心 3x3 需要脚手架或逐圈向内放置（order 字段已按外圈→内圈排序）。
// ---------------------------------------------------------------------------

import {
  blueprintCellSchema,
  blueprintSchema,
  orderBlueprintCells,
  type Blueprint,
  type BlueprintCell,
} from "./planning/blueprint-planner.js";
import type { BlockPosition } from "./workstation-registry.js";

// ---------------------------------------------------------------------------
// starter_base_v1
// ---------------------------------------------------------------------------

export const STARTER_BASE_V1_ID = "starter_base_v1";
export const STARTER_BASE_V1_VERSION = 1;

export interface StarterBaseParams {
  readonly serverProfileId: string;
  readonly dimension: string;
  readonly anchor: BlockPosition;
}

/** 5x5 生存小屋蓝图（确定性：同参数同输出）。 */
export function starterBaseV1(params: StarterBaseParams): Blueprint {
  const cells: BlueprintCell[] = [];
  const WALL = "oak_planks";
  const FLOOR = "cobblestone";

  // 地板（foundation, order 0）——先于一切
  for (let x = 0; x <= 4; x += 1) {
    for (let z = 0; z <= 4; z += 1) {
      cells.push(cell({ x, y: 0, z }, FLOOR, "foundation", x * 5 + z));
    }
  }

  // 墙（structural, order 100+）：周界 y=1..2，南墙中心 (2,4) 留门
  let wallOrder = 100;
  for (let y = 1; y <= 2; y += 1) {
    for (let x = 0; x <= 4; x += 1) {
      for (let z = 0; z <= 4; z += 1) {
        const onPerimeter = x === 0 || x === 4 || z === 0 || z === 4;
        if (!onPerimeter) continue;
        const isDoorway = x === 2 && z === 4 && (y === 1 || y === 2);
        if (isDoorway) continue;
        cells.push(cell({ x, y, z }, WALL, "structural", wallOrder));
        wallOrder += 1;
      }
    }
  }

  // 顶（shell, order 300+）：外圈 → 内圈（向心放置，保持可依附）
  for (let ring = 0; ring <= 2; ring += 1) {
    for (let x = ring; x <= 4 - ring; x += 1) {
      for (let z = ring; z <= 4 - ring; z += 1) {
        const onRing =
          (x === ring || x === 4 - ring || z === ring || z === 4 - ring) &&
          !(x > ring && x < 4 - ring && z > ring && z < 4 - ring);
        if (!onRing) continue;
        cells.push(cell({ x, y: 3, z }, WALL, "shell", 300 + ring * 30 + x * 5 + z));
      }
    }
  }

  // 工作站（utility, order 500+）：室内角落
  cells.push(cell({ x: 1, y: 1, z: 1 }, "furnace", "utility", 500));
  cells.push(cell({ x: 3, y: 1, z: 1 }, "crafting_table", "utility", 501));
  cells.push(cell({ x: 1, y: 1, z: 3 }, "chest", "utility", 502));

  // 火把（decoration, order 900+）
  cells.push(cell({ x: 3, y: 1, z: 3 }, "torch", "decoration", 900));
  cells.push(cell({ x: 2, y: 1, z: 2 }, "torch", "decoration", 901));

  return blueprintSchema.parse({
    anchor: params.anchor,
    dimension: params.dimension,
    serverProfileId: params.serverProfileId,
    cells,
  });
}

function cell(
  offset: { x: number; y: number; z: number },
  itemName: string,
  blockClass: BlueprintCell["blockClass"],
  order: number,
): BlueprintCell {
  return blueprintCellSchema.parse({ offset, itemName, blockClass, order });
}

// ---------------------------------------------------------------------------
// MaterialResolver
// ---------------------------------------------------------------------------

/** 蓝图 → 每种物品需要数量；给定 available 时返回缺口（需要但不足的部分）。 */
export function resolveMaterials(
  blueprint: Blueprint,
  available?: ReadonlyMap<string, number>,
): Map<string, number> {
  const required = new Map<string, number>();
  for (const c of blueprint.cells) {
    required.set(c.itemName, (required.get(c.itemName) ?? 0) + 1);
  }
  if (!available) return required;
  const shortfall = new Map<string, number>();
  for (const [itemName, need] of required) {
    const have = available.get(itemName) ?? 0;
    if (have < need) shortfall.set(itemName, need - have);
  }
  return shortfall;
}

// ---------------------------------------------------------------------------
// BaseRegistry
// ---------------------------------------------------------------------------

export type BaseStatus = "planned" | "building" | "operational" | "damaged" | "abandoned";

export interface BaseRecord {
  readonly id: string;
  readonly name: string;
  readonly serverProfileId: string;
  readonly dimension: string;
  readonly anchor: BlockPosition;
  readonly blueprintId: string;
  readonly blueprintVersion: number;
  status: BaseStatus;
  /** 已确认放置的 cell 数（0..totalCells）。 */
  placedCells: number;
  /** 结构完整度 0..1（operational=1，damaged 时 <1）。 */
  integrity01: number;
  createdByBotId: string | null;
  lastStatusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BaseCellReservation {
  readonly botId: string;
  readonly expiresAtMs: number;
}

export interface BaseRegistryOptions {
  readonly defaultCellTtlMs?: number;
  readonly now?: () => number;
}

const BASE_LIFECYCLE: Readonly<Record<BaseStatus, readonly BaseStatus[]>> = {
  planned: ["building", "abandoned"],
  building: ["operational", "abandoned", "planned"],
  operational: ["damaged", "abandoned"],
  damaged: ["operational", "abandoned"],
  abandoned: [],
};

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** 确定性 baseId（同 facility 语义）。 */
export function baseId(serverProfileId: string, dimension: string, anchor: BlockPosition): string {
  const scope = fnv1a(`${serverProfileId}|${dimension}`);
  return `base-${scope}_${anchor.x}_${anchor.y}_${anchor.z}`;
}

export class BaseRegistry {
  private readonly bases = new Map<string, BaseRecord>();
  private readonly cellReservations = new Map<string, Map<number, BaseCellReservation>>();
  private readonly defaultCellTtlMs: number;
  private readonly now: () => number;

  constructor(options: BaseRegistryOptions = {}) {
    this.defaultCellTtlMs = options.defaultCellTtlMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  create(params: Readonly<{
    name: string;
    serverProfileId: string;
    dimension: string;
    anchor: BlockPosition;
    blueprintId: string;
    blueprintVersion?: number;
    createdByBotId?: string;
  }>): BaseRecord {
    const id = baseId(params.serverProfileId, params.dimension, params.anchor);
    const existing = this.bases.get(id);
    if (existing) return existing;
    const iso = new Date(this.now()).toISOString();
    const record: BaseRecord = {
      id,
      name: params.name,
      serverProfileId: params.serverProfileId,
      dimension: params.dimension,
      anchor: params.anchor,
      blueprintId: params.blueprintId,
      blueprintVersion: params.blueprintVersion ?? 1,
      status: "planned",
      placedCells: 0,
      integrity01: 0,
      createdByBotId: params.createdByBotId ?? null,
      lastStatusReason: null,
      createdAt: iso,
      updatedAt: iso,
    };
    this.bases.set(id, record);
    return record;
  }

  get(baseId: string): BaseRecord | null {
    return this.bases.get(baseId) ?? null;
  }

  /** 同 server+dimension 全部基地，按与 reference 距离升序。 */
  findBases(serverProfileId: string, dimension: string, reference: BlockPosition): readonly BaseRecord[] {
    const matches: Array<{ base: BaseRecord; distSq: number }> = [];
    for (const base of this.bases.values()) {
      if (base.serverProfileId !== serverProfileId || base.dimension !== dimension) continue;
      const dx = base.anchor.x - reference.x;
      const dy = base.anchor.y - reference.y;
      const dz = base.anchor.z - reference.z;
      matches.push({ base, distSq: dx * dx + dy * dy + dz * dz });
    }
    return matches.sort((a, b) => a.distSq - b.distSq).map((m) => m.base);
  }

  #transition(baseId: string, to: BaseStatus, reason: string | null): boolean {
    const base = this.bases.get(baseId);
    if (!base) return false;
    if (!BASE_LIFECYCLE[base.status].includes(to)) return false;
    base.status = to;
    base.lastStatusReason = reason;
    base.updatedAt = new Date(this.now()).toISOString();
    if (to === "operational") base.integrity01 = 1;
    if (to === "damaged") base.integrity01 = Math.min(0.99, Math.max(0, base.integrity01));
    return true;
  }

  markBuilding(baseId: string, botId: string): boolean {
    const base = this.bases.get(baseId);
    if (!base) return false;
    const ok = this.#transition(baseId, "building", `builder:${botId}`);
    if (ok) base.createdByBotId = base.createdByBotId ?? botId;
    return ok;
  }

  markOperational(baseId: string): boolean {
    return this.#transition(baseId, "operational", "all_cells_placed");
  }

  markDamaged(baseId: string, reason: string): boolean {
    return this.#transition(baseId, "damaged", reason);
  }

  markAbandoned(baseId: string, reason: string): boolean {
    return this.#transition(baseId, "abandoned", reason);
  }

  /** 记录 cell 施工完成；达到 setTotalCells 设定的总数时自动 operational。 */
  markCellPlaced(baseId: string, cellIndex: number): boolean {
    const base = this.bases.get(baseId);
    if (!base || base.status !== "building") return false;
    if (!Number.isInteger(cellIndex) || cellIndex < 0) return false;
    base.placedCells = Math.max(base.placedCells, cellIndex + 1);
    base.updatedAt = new Date(this.now()).toISOString();
    this.cellReservations.get(baseId)?.delete(cellIndex);
    const total = this.totals.get(baseId);
    if (total !== undefined) {
      base.integrity01 = Math.min(1, base.placedCells / Math.max(1, total));
      if (base.placedCells >= total) return this.#transition(baseId, "operational", "all_cells_placed");
    }
    return true;
  }

  /** 显式设置总 cell 数（markCellPlaced 判完工用；蓝图尺寸已知时调用）。 */
  setTotalCells(baseId: string, totalCells: number): boolean {
    const base = this.bases.get(baseId);
    if (!base || !Number.isInteger(totalCells) || totalCells <= 0) return false;
    this.totals.set(baseId, totalCells);
    return true;
  }

  private readonly totals = new Map<string, number>();

  // -- 多 Bot cell 级施工预约 ------------------------------------------------

  reserveCell(baseId: string, cellIndex: number, botId: string, ttlMs?: number): boolean {
    this.expireCellReservations(baseId);
    const base = this.bases.get(baseId);
    if (!base || base.status !== "building") return false;
    if (!Number.isInteger(cellIndex) || cellIndex < 0) return false;
    let reservations = this.cellReservations.get(baseId);
    if (!reservations) {
      reservations = new Map();
      this.cellReservations.set(baseId, reservations);
    }
    const existing = reservations.get(cellIndex);
    if (existing) {
      if (existing.botId === botId) return true; // 幂等续占
      return false;
    }
    reservations.set(cellIndex, { botId, expiresAtMs: this.now() + (ttlMs ?? this.defaultCellTtlMs) });
    return true;
  }

  releaseCell(baseId: string, cellIndex: number, botId: string): boolean {
    const reservations = this.cellReservations.get(baseId);
    const existing = reservations?.get(cellIndex);
    if (!reservations || !existing) return false;
    if (existing.botId !== botId) return false;
    reservations.delete(cellIndex);
    return true;
  }

  /** 释放全部过期预约，返回释放数。 */
  expireCellReservations(baseId: string): number {
    const reservations = this.cellReservations.get(baseId);
    if (!reservations) return 0;
    const now = this.now();
    let released = 0;
    for (const [cellIndex, reservation] of reservations) {
      if (now >= reservation.expiresAtMs) {
        reservations.delete(cellIndex);
        released += 1;
      }
    }
    return released;
  }

  // -- 快照 -------------------------------------------------------------------

  serialize(): { bases: BaseRecord[] } {
    return { bases: [...this.bases.values()] };
  }

  static restore(snapshot: { bases?: BaseRecord[] }, options: BaseRegistryOptions = {}): BaseRegistry {
    const reg = new BaseRegistry(options);
    for (const base of snapshot?.bases ?? []) {
      if (!base || typeof base.id !== "string") continue;
      reg.bases.set(base.id, base);
    }
    return reg;
  }

  get size(): number {
    return this.bases.size;
  }
}

// ---------------------------------------------------------------------------
// reconcileBlueprint（BlueprintReconciler 核心）
// ---------------------------------------------------------------------------

export interface ReconciledCell {
  readonly cell: BlueprintCell;
  readonly observedItemName: string | null;
  readonly expectedItemName: string;
  readonly blockClass: BlueprintCell["blockClass"];
}

export interface ReconcileResult {
  /** 已放置且方块正确。 */
  readonly placed: readonly ReconciledCell[];
  /** 位置为空（air）。 */
  readonly missing: readonly ReconciledCell[];
  /** 位置有方块但不是蓝图方块（需要先拆再放）。 */
  readonly wrong: readonly ReconciledCell[];
  /** 完整性 0..1 = placed / total。 */
  readonly integrity01: number;
  /** 修复顺序（wrong + missing，按建造 class rank 排序）。 */
  readonly repairOrder: readonly BlueprintCell[];
  /** 未观测 cell 数（不在 observations 里的不参与判定）。 */
  readonly unobserved: number;
}

/**
 * 观测 vs 蓝图。
 * observations: key = JSON.stringify(offset), value = 方块名（null = 空气）。
 */
export function reconcileBlueprint(
  blueprint: Blueprint,
  observations: ReadonlyMap<string, string | null>,
): ReconcileResult {
  const placed: ReconciledCell[] = [];
  const missing: ReconciledCell[] = [];
  const wrong: ReconciledCell[] = [];
  let unobserved = 0;

  for (const c of blueprint.cells) {
    const key = JSON.stringify(c.offset);
    if (!observations.has(key)) {
      unobserved += 1;
      continue;
    }
    const observed = observations.get(key)!;
    const entry: ReconciledCell = {
      cell: c,
      observedItemName: observed,
      expectedItemName: c.itemName,
      blockClass: c.blockClass,
    };
    if (observed === null) missing.push(entry);
    else if (observed === c.itemName) placed.push(entry);
    else wrong.push(entry);
  }

  const total = blueprint.cells.length;
  const repairCells = [...wrong.map((w) => w.cell), ...missing.map((m) => m.cell)];
  const repairOrder = orderBlueprintCells({
    ...blueprint,
    cells: repairCells,
  } as Blueprint);

  return Object.freeze({
    placed,
    missing,
    wrong,
    // 完整性按整个蓝图计算（未观测的部分不算已建）
    integrity01: placed.length / total,
    repairOrder,
    unobserved,
  });
}
