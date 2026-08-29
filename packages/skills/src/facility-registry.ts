// ---------------------------------------------------------------------------
// FacilityRegistry + PlacementPattern + PlacementPlanner
//
// Facility 是比单个 workstation 更高一级的概念：一个逻辑区域（如
// smelting_zone）包含多个同类型工作站 + 预留扩建空间。
//
// 职责：
//   FacilityRegistry: 管理 facility 生命周期（创建/查询/成员管理）
//   PlacementPattern: anchor+orientation → 世界坐标 slot 序列
//   PlacementPlanner: 选下一个合法 slot，检查 reserved space
// ---------------------------------------------------------------------------

import type { BlockPosition } from "./workstation-registry.js";
import { normalizeBlockPos } from "./workstation-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FacilityType = "smelting_zone" | "crafting_zone" | "storage_zone";

export type Orientation = "north" | "south" | "east" | "west";

export interface FacilitySlot {
  readonly localOffset: { x: number; y: number; z: number };
  readonly worldPosition: BlockPosition;
  readonly workstationType: string;
  status: "reserved" | "occupied" | "available" | "blocked";
  reservedBy: string | null;
  reservedUntilMs: number | null;
  readonly workstationEntryKey: string | null;
}

export interface Facility {
  readonly id: string;
  readonly facilityType: FacilityType;
  readonly serverProfileId: string;
  readonly dimension: string;
  /** Facility 的锚点（第一个 workstation 的位置或规划起点）。 */
  readonly anchor: BlockPosition;
  readonly orientation: Orientation;
  /** Pattern 版本标识，允许未来升级布局。 */
  readonly layoutVersion: string;
  createdAt: string;
  lastObservedAt: string;
  confidence: number;
  slots: FacilitySlot[];
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PlacementPattern —— anchor + orientation + local offset → world position
// ---------------------------------------------------------------------------

export type PatternLayoutName = "line_v1" | "wall_grid_v1";

export interface PatternSlot {
  readonly localOffset: { x: number; y: number; z: number };
  readonly workstationType: string;
}

/**
 * 生成 smelting_zone LINE pattern 的 slot 序列。
 * F F F F F F  → 单排沿 orientation 方向扩展。
 */
export function smeltingLinePattern(maxSlots: number): readonly PatternSlot[] {
  const slots: PatternSlot[] = [];
  for (let i = 0; i < maxSlots; i += 1) {
    slots.push({ localOffset: { x: i, y: 0, z: 0 }, workstationType: "furnace" });
  }
  return slots;
}

/**
 * 生成 WALL_GRID pattern：4 宽 × N 高。
 * F F F F
 * F F F F
 */
export function smeltingWallGridPattern(columns: number, rows: number): readonly PatternSlot[] {
  const slots: PatternSlot[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      slots.push({ localOffset: { x: col, y: row, z: 0 }, workstationType: "furnace" });
    }
  }
  return slots;
}

/**
 * 把 local offset + orientation 转换为世界坐标偏移。
 *
 * north: +x → world -z, +z → world -x
 * south: +x → world +z, +z → world +x
 * east:  +x → world +x, +z → world +z
 * west:  +x → world -x, +z → world -z
 */
export function transformOffset(
  offset: { x: number; y: number; z: number },
  orientation: Orientation,
): { dx: number; dz: number } {
  switch (orientation) {
    case "north": return { dx: offset.x, dz: -offset.z };
    case "south": return { dx: offset.x, dz: offset.z };
    case "east": return { dx: offset.z, dz: offset.x };
    case "west": return { dx: -offset.z, dz: -offset.x };
  }
}

export function toWorldPosition(
  anchor: BlockPosition,
  offset: { x: number; y: number; z: number },
  orientation: Orientation,
): BlockPosition {
  const { dx, dz } = transformOffset(offset, orientation);
  return normalizeBlockPos({
    x: anchor.x + dx,
    y: anchor.y + offset.y,
    z: anchor.z + dz,
  });
}

// ---------------------------------------------------------------------------
// FacilityRegistry
// ---------------------------------------------------------------------------

export interface FacilityRegistryOptions {
  maxFacilitiesPerServer?: number;
}

export class FacilityRegistry {
  private readonly facilities = new Map<string, Facility>();
  private readonly maxPerServer: number;
  private counter = 0;

  constructor(options: FacilityRegistryOptions = {}) {
    this.maxPerServer = options.maxFacilitiesPerServer ?? 16;
  }

  /** 创建新 facility。 */
  create(params: Readonly<{
    facilityType: FacilityType;
    serverProfileId: string;
    dimension: string;
    anchor: BlockPosition;
    orientation: Orientation;
    layoutVersion: string;
    patternSlots: readonly PatternSlot[];
  }>): Facility {
    const id = `facility-${params.facilityType}-${++this.counter}`;
    const slots: FacilitySlot[] = params.patternSlots.map((ps) => ({
      localOffset: ps.localOffset,
      worldPosition: toWorldPosition(params.anchor, ps.localOffset, params.orientation),
      workstationType: ps.workstationType,
      status: "available",
      reservedBy: null,
      reservedUntilMs: null,
      workstationEntryKey: null,
    }));
    const facility: Facility = {
      id,
      facilityType: params.facilityType,
      serverProfileId: params.serverProfileId,
      dimension: params.dimension,
      anchor: params.anchor,
      orientation: params.orientation,
      layoutVersion: params.layoutVersion,
      createdAt: new Date().toISOString(),
      lastObservedAt: new Date().toISOString(),
      confidence: 1,
      slots,
      metadata: {},
    };
    this.facilities.set(id, facility);
    return facility;
  }

  /** 查找指定 server+dimension+type 的第一个 facility。 */
  find(
    serverProfileId: string,
    dimension: string,
    facilityType: FacilityType,
  ): Facility | null {
    for (const facility of this.facilities.values()) {
      if (
        facility.serverProfileId === serverProfileId &&
        facility.dimension === dimension &&
        facility.facilityType === facilityType
      ) {
        return facility;
      }
    }
    return null;
  }

  /** 获取下一个可用的 slot（reserved+expired → available, occupied 跳过, available 优先）。 */
  nextAvailableSlot(facility: Facility): FacilitySlot | null {
    const now = Date.now();
    // 先释放过期 reservations
    for (const slot of facility.slots) {
      if (slot.status === "reserved" && slot.reservedUntilMs !== null && now >= slot.reservedUntilMs) {
        slot.status = "available";
        slot.reservedBy = null;
        slot.reservedUntilMs = null;
      }
    }
    return facility.slots.find((slot) => slot.status === "available") ?? null;
  }

  /** 预约一个 slot（placement reservation race 防护）。 */
  reserveSlot(facility: Facility, slot: FacilitySlot, botId: string, ttlMs = 30_000): boolean {
    if (slot.status !== "available") return false;
    slot.status = "reserved";
    slot.reservedBy = botId;
    slot.reservedUntilMs = Date.now() + ttlMs;
    return true;
  }

  /** slot 放置成功 → 标记 occupied + 关联 workstation entry。 */
  markOccupied(facility: Facility, slot: FacilitySlot, workstationEntryKey: string): void {
    (slot as { status: string }).status = "occupied";
    (slot as { reservedBy: string | null }).reservedBy = null;
    (slot as { reservedUntilMs: number | null }).reservedUntilMs = null;
    (slot as { workstationEntryKey: string | null }).workstationEntryKey = workstationEntryKey;
  }

  /** slot 放置失败 → 释放 reservation，标记 blocked（暂时不可用）。 */
  markBlocked(facility: Facility, slot: FacilitySlot): void {
    (slot as { status: string }).status = "blocked";
    (slot as { reservedBy: string | null }).reservedBy = null;
    (slot as { reservedUntilMs: number | null }).reservedUntilMs = null;
  }

  /** 工作站被破坏 → slot 从 occupied 变回 available（可重新放置）。 */
  markSlotAvailable(facility: Facility, worldPos: BlockPosition): boolean {
    for (const slot of facility.slots) {
      if (
        slot.worldPosition.x === worldPos.x &&
        slot.worldPosition.y === worldPos.y &&
        slot.worldPosition.z === worldPos.z &&
        slot.status === "occupied"
      ) {
        (slot as { status: string }).status = "available";
        (slot as { workstationEntryKey: string | null }).workstationEntryKey = null;
        return true;
      }
    }
    return false;
  }

  get size(): number {
    return this.facilities.size;
  }
}
