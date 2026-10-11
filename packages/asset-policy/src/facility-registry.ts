// ---------------------------------------------------------------------------
// FacilityRegistry + PlacementPattern + FacilitySlot state machine
//
// Facility 是比单个 workstation 更高一级的概念：一个逻辑区域（如
// smelting_zone）包含多个同类型工作站 + 预留扩建空间。
//
// 本模块契约（foundation upgrade Phase 2-4）：
//   1. FacilitySlot 是 7 状态机，非法跳变被拒绝（返回 false + statusReason），
//      永不静默吞掉；表驱动 canTransition() 是唯一权威。
//   2. facilityId 由 (server, dimension, type, anchor) 确定性派生，
//      跨进程/重启稳定；create() 幂等。
//   3. 局部坐标系标准：local +z = 朝向方向（forward），local +x = 面朝方向的右手侧。
//      north: forward=-z right=+x / south: forward=+z right=-x
//      east:  forward=+x right=+z / west:  forward=-x right=-z
//   4. 读取 API（nextPlannableSlot 等）是纯读，不做惰性过期；
//      过期必须显式 expireReservations()。
//   5. serialize()/restore() 提供跨进程快照（Phase 5/6 持久化基础）。
//   6. 时钟可注入（options.now），测试与 coordinator 共享时钟。
// ---------------------------------------------------------------------------

import type { BlockPosition, WorkstationType } from "./workstation-registry.js";
import { normalizeBlockPos } from "./workstation-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Stable facility identities shared by planning, persistence and production
 * telemetry. A type only describes the facility class; commissioning and
 * output must still be proven through metadata and server readback.
 */
export type FacilityType =
  | "smelting_zone"
  | "crafting_zone"
  | "storage_zone"
  | "crop_farm"
  | "iron_farm"
  | "mob_farm"
  | "gunpowder_farm"
  | "tree_farm"
  | "cobblestone_generator"
  | "trading_hall"
  | "storage_system";

export type Orientation = "north" | "south" | "east" | "west";

/**
 * Slot 生命周期 7 状态（权威定义）：
 *   planned              蓝图规划，从未放置；可被 reserve
 *   placement_reserved   某个 bot 正要放置（TTL 防呆，防止 bot 崩溃后永久卡住）
 *   occupied             方块确认存在（lastVerifiedAtMs 记录最后确认）
 *   missing              曾 occupied，方块消失（被破坏/被拾取）→ 需 re-plan
 *   temporarily_blocked  位置被外来方块占据 / 暂时不可放置 → 可重试
 *   invalid              永久不可放置（bedrock/悬空/被其他建筑占用）→ 不可逆
 *   unknown              发现的 facility 中尚未观测过的 slot
 */
export type FacilitySlotStatus =
  | "planned"
  | "placement_reserved"
  | "occupied"
  | "missing"
  | "temporarily_blocked"
  | "invalid"
  | "unknown";

/** Facility-level lifecycle. Slot occupancy alone never implies production. */
export type FacilityOperationalState =
  | "PLANNED"
  | "BUILDING"
  | "COMMISSIONING"
  | "ACTIVE"
  | "DEGRADED"
  | "STOPPED";

export const FACILITY_OPERATIONAL_TRANSITIONS: Readonly<Record<FacilityOperationalState, readonly FacilityOperationalState[]>> = {
  PLANNED: ["BUILDING", "STOPPED"],
  BUILDING: ["COMMISSIONING", "DEGRADED", "STOPPED"],
  COMMISSIONING: ["ACTIVE", "DEGRADED", "STOPPED"],
  ACTIVE: ["DEGRADED", "STOPPED"],
  DEGRADED: ["COMMISSIONING", "ACTIVE", "STOPPED"],
  STOPPED: ["BUILDING", "COMMISSIONING"],
};

export function canTransitionFacilityOperationalState(
  from: FacilityOperationalState,
  to: FacilityOperationalState,
): boolean {
  return FACILITY_OPERATIONAL_TRANSITIONS[from].includes(to);
}

export type FacilityProductionLedger = Readonly<{
  state: FacilityOperationalState;
  lastTransitionAtMs: number;
  lastTransitionReason: string | null;
  produced: Readonly<Record<string, number>>;
  consumed: Readonly<Record<string, number>>;
  blockedReason: string | null;
}>;

export function readFacilityProductionLedger(facility: Facility): FacilityProductionLedger {
  const raw = facility.metadata.productionLedger;
  if (!raw || typeof raw !== "object") {
    return { state: "PLANNED", lastTransitionAtMs: 0, lastTransitionReason: null, produced: {}, consumed: {}, blockedReason: null };
  }
  const value = raw as Record<string, unknown>;
  const state = typeof value.state === "string" && value.state in FACILITY_OPERATIONAL_TRANSITIONS
    ? value.state as FacilityOperationalState
    : "PLANNED";
  const counts = (input: unknown): Record<string, number> => {
    if (!input || typeof input !== "object") return {};
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, count]) => Number.isSafeInteger(count) && Number(count) >= 0).map(([name, count]) => [name, Number(count)]));
  };
  return {
    state,
    lastTransitionAtMs: Number.isSafeInteger(value.lastTransitionAtMs) ? Number(value.lastTransitionAtMs) : 0,
    lastTransitionReason: typeof value.lastTransitionReason === "string" ? value.lastTransitionReason : null,
    produced: counts(value.produced), consumed: counts(value.consumed),
    blockedReason: typeof value.blockedReason === "string" ? value.blockedReason : null,
  };
}

export function transitionFacilityOperationalState(
  facility: Facility,
  next: FacilityOperationalState,
  atMs: number,
  reason: string | null = null,
): FacilityProductionLedger {
  if (!Number.isSafeInteger(atMs) || atMs < 0) throw new RangeError("facility transition time must be a non-negative safe integer");
  const current = readFacilityProductionLedger(facility);
  if (current.state !== next && !canTransitionFacilityOperationalState(current.state, next)) throw new Error(`FACILITY_INVALID_OPERATIONAL_TRANSITION:${current.state}->${next}`);
  const updated: FacilityProductionLedger = { ...current, state: next, lastTransitionAtMs: atMs, lastTransitionReason: reason, blockedReason: next === "DEGRADED" ? reason : null };
  facility.metadata.productionLedger = updated;
  facility.lastObservedAt = new Date(atMs).toISOString();
  return updated;
}

export function recordFacilityProduction(
  facility: Facility,
  itemName: string,
  count: number,
  atMs: number,
  direction: "produced" | "consumed",
): FacilityProductionLedger {
  if (!/^[a-z0-9_.-]{1,96}$/u.test(itemName) || !Number.isSafeInteger(count) || count <= 0) throw new TypeError("facility production entry is malformed");
  const current = readFacilityProductionLedger(facility);
  const bucket = { ...(current[direction] as Record<string, number>) };
  bucket[itemName] = (bucket[itemName] ?? 0) + count;
  const updated: FacilityProductionLedger = { ...current, [direction]: bucket };
  facility.metadata.productionLedger = updated;
  facility.lastObservedAt = new Date(atMs).toISOString();
  return updated;
}

/** 非法跳变表。key=from, value=允许的 to 集合。 */
export const TRANSITIONS: Readonly<Record<FacilitySlotStatus, readonly FacilitySlotStatus[]>> = {
  planned: ["placement_reserved", "invalid"],
  placement_reserved: ["occupied", "planned", "temporarily_blocked", "invalid"],
  occupied: ["missing", "temporarily_blocked", "invalid"],
  missing: ["planned", "placement_reserved", "invalid"],
  temporarily_blocked: ["planned", "placement_reserved", "invalid"],
  invalid: [],
  unknown: ["planned", "occupied", "temporarily_blocked", "invalid"],
};

export function canTransition(from: FacilitySlotStatus, to: FacilitySlotStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface FacilitySlot {
  readonly index: number;
  /** 稳定 slot 标识 `${facilityId}#${index}`——不依赖数组位置。 */
  readonly slotId: string;
  readonly localOffset: { x: number; y: number; z: number };
  readonly worldPosition: BlockPosition;
  readonly workstationType: WorkstationType;
  status: FacilitySlotStatus;
  reservedBy: string | null;
  reservedUntilMs: number | null;
  readonly workstationEntryKey: string | null;
  /** occupied 状态下最后一次确认方块存在的 epoch ms。 */
  lastVerifiedAtMs: number | null;
  /** 进入当前状态的原因（missing/blocked/invalid 必填，其余可空）。 */
  statusReason: string | null;
  /** 累计施工失败次数（成功 occupied 时清零）。 */
  failureCount: number;
  /** 最后一次施工失败时间（退避计算用）。 */
  lastFailureAtMs: number | null;
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
  /** planned：全新规划；observed_existing：从世界上发现并登记。 */
  readonly discovery: "planned" | "observed_existing";
  /** 所属 Base（可空；Base→Facility→Workstation 层级，不靠距离猜）。 */
  readonly baseId: string | null;
  createdAt: string;
  lastObservedAt: string;
  confidence: number;
  slots: FacilitySlot[];
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stable facility id
// ---------------------------------------------------------------------------

/** FNV-1a 32bit —— 短、确定性、无需依赖。 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 确定性 facilityId：同一 (server, dimension, type, anchor) 永远相同。
 * 坐标直接编码（人可读、可 grep），server+dimension 用哈希折叠。
 */
export function facilityId(
  serverProfileId: string,
  dimension: string,
  facilityType: FacilityType,
  anchor: BlockPosition,
): string {
  const scope = fnv1a(`${serverProfileId}|${dimension}`);
  return `facility-${facilityType}-${scope}_${anchor.x}_${anchor.y}_${anchor.z}`;
}

// ---------------------------------------------------------------------------
// PlacementPattern —— anchor + orientation + local offset → world position
// ---------------------------------------------------------------------------

export type PatternLayoutName = "line_v1" | "wall_grid_v1";

export interface PatternSlot {
  readonly localOffset: { x: number; y: number; z: number };
  readonly workstationType: WorkstationType;
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
 * 局部偏移 → 世界偏移。
 * 标准：local +z = 朝向方向（forward），local +x = 面朝方向的右手侧。
 *   north (facing -z): dx=+x, dz=-z
 *   south (facing +z): dx=-x, dz=+z
 *   east  (facing +x): dx=+z, dz=+x
 *   west  (facing -x): dz=-x, dx=-z
 */
export function transformOffset(
  offset: { x: number; y: number; z: number },
  orientation: Orientation,
): { dx: number; dz: number } {
  switch (orientation) {
    case "north": return { dx: offset.x, dz: -offset.z };
    case "south": return { dx: -offset.x, dz: offset.z };
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
// FacilityRegistryPort —— 注册表端口（InMemory 与 Coordinator 远端实现共同遵守）
// ---------------------------------------------------------------------------

export interface FacilityRegistryPort {
  create(params: Readonly<{
    facilityType: FacilityType;
    serverProfileId: string;
    dimension: string;
    anchor: BlockPosition;
    orientation: Orientation;
    layoutVersion: string;
    patternSlots: readonly PatternSlot[];
    /** observed_existing：发现的既有设施（slot 初始 unknown）。默认 planned。 */
    discovery?: "planned" | "observed_existing";
    /** 所属 Base（Base→Facility→Workstation 层级绑定）。 */
    baseId?: string;
  }>): Facility;
  get(facilityId: string): Facility | null;
  /** 同 server+dimension+type 的全部 facility，按与 reference 的距离升序。 */
  findCandidates(
    serverProfileId: string,
    dimension: string,
    facilityType: FacilityType,
    reference: BlockPosition,
  ): readonly Facility[];
  /** 查询绑定到某 Base 的全部 facility。 */
  findByBase(baseId: string): readonly Facility[];
  /** 纯读：第一个 planned 状态 slot（不做过期释放）。 */
  nextPlannableSlot(facilityId: string): FacilitySlot | null;
  reserveSlot(facilityId: string, slotIndex: number, botId: string, ttlMs?: number): boolean;
  /** owner-safe：botId 提供时必须匹配 reservedBy，否则拒绝。 */
  releaseReservation(facilityId: string, slotIndex: number, reason: string, botId?: string): boolean;
  /** owner-safe 续约：仅 reservation 持有者可延长 TTL。 */
  renewSlotReservation(facilityId: string, slotIndex: number, botId: string, ttlMs?: number): boolean;
  markSlotOccupied(
    facilityId: string,
    slotIndex: number,
    workstationEntryKey: string,
    opts?: Readonly<{ reservationOwner?: string }>,
  ): boolean;
  /** 施工失败：placement_reserved → temporarily_blocked，累计 failureCount。 */
  markPlacementFailed(facilityId: string, slotIndex: number, reason: string, botId: string): boolean;
  markSlotMissing(facilityId: string, slotIndex: number, reason: string): boolean;
  markSlotTemporarilyBlocked(facilityId: string, slotIndex: number, reason: string): boolean;
  markSlotInvalid(facilityId: string, slotIndex: number, reason: string): boolean;
  /** missing/temporarily_blocked → planned（显式重新规划；退避期内拒绝）。 */
  replanSlot(facilityId: string, slotIndex: number): boolean;
  /** 观测驱动更新（unknown/occupied 的现实同步）。 */
  observeSlot(
    facilityId: string,
    slotIndex: number,
    observation: Readonly<{ blockPresent: boolean; blockName: string | null }>,
  ): boolean;
  /** 显式释放过期 placement reservations，返回释放数量。 */
  expireReservations(facilityId: string): number;
}

// ---------------------------------------------------------------------------
// FacilityRegistry（InMemory 实现）
// ---------------------------------------------------------------------------

export interface FacilityRegistryOptions {
  maxFacilitiesPerServer?: number;
  /** 可注入时钟（测试 / coordinator 共享时钟）。 */
  now?: () => number;
}

interface MutableSlotFields {
  status: FacilitySlotStatus;
  reservedBy: string | null;
  reservedUntilMs: number | null;
  workstationEntryKey: string | null;
  lastVerifiedAtMs: number | null;
  statusReason: string | null;
  failureCount: number;
  lastFailureAtMs: number | null;
}

/** 施工失败退避基数：10s * 2^(failureCount-1)，封顶 5 分钟。 */
export const PLACEMENT_BACKOFF_BASE_MS = 10_000;
export const PLACEMENT_BACKOFF_MAX_MS = 300_000;

export function placementBackoffMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  const ms = PLACEMENT_BACKOFF_BASE_MS * 2 ** (failureCount - 1);
  return Math.min(PLACEMENT_BACKOFF_MAX_MS, ms);
}

export class FacilityRegistry implements FacilityRegistryPort {
  private readonly facilities = new Map<string, Facility>();
  private readonly maxPerServer: number;
  private readonly now: () => number;

  constructor(options: FacilityRegistryOptions = {}) {
    this.maxPerServer = options.maxFacilitiesPerServer ?? 16;
    this.now = options.now ?? (() => Date.now());
  }

  /** 创建（或幂等返回）facility。同一身份重复 create 返回已有实例。
   *  超出 maxFacilitiesPerServer（scope = server+dimension）时抛错——绝不静默超限。 */
  create(params: Readonly<{
    facilityType: FacilityType;
    serverProfileId: string;
    dimension: string;
    anchor: BlockPosition;
    orientation: Orientation;
    layoutVersion: string;
    patternSlots: readonly PatternSlot[];
    discovery?: "planned" | "observed_existing";
    baseId?: string;
  }>): Facility {
    const id = facilityId(params.serverProfileId, params.dimension, params.facilityType, params.anchor);
    const existing = this.facilities.get(id);
    if (existing) return existing;

    let sameScope = 0;
    for (const facility of this.facilities.values()) {
      if (facility.serverProfileId === params.serverProfileId && facility.dimension === params.dimension) {
        sameScope += 1;
      }
    }
    if (sameScope >= this.maxPerServer) {
      throw new Error(
        `maxFacilitiesPerServer exceeded for ${params.serverProfileId}|${params.dimension} (limit ${this.maxPerServer})`,
      );
    }

    const discovery = params.discovery ?? "planned";
    const initialStatus: FacilitySlotStatus = discovery === "observed_existing" ? "unknown" : "planned";
    const slots: FacilitySlot[] = params.patternSlots.map((ps, index) => ({
      index,
      slotId: `${id}#${index}`,
      localOffset: ps.localOffset,
      worldPosition: toWorldPosition(params.anchor, ps.localOffset, params.orientation),
      workstationType: ps.workstationType,
      status: initialStatus,
      reservedBy: null,
      reservedUntilMs: null,
      workstationEntryKey: null,
      lastVerifiedAtMs: null,
      statusReason: null,
      failureCount: 0,
      lastFailureAtMs: null,
    }));
    const facility: Facility = {
      id,
      facilityType: params.facilityType,
      serverProfileId: params.serverProfileId,
      dimension: params.dimension,
      anchor: params.anchor,
      orientation: params.orientation,
      layoutVersion: params.layoutVersion,
      discovery,
      baseId: params.baseId ?? null,
      createdAt: new Date(this.now()).toISOString(),
      lastObservedAt: new Date(this.now()).toISOString(),
      confidence: discovery === "observed_existing" ? 0.7 : 1,
      slots,
      metadata: {},
    };
    this.facilities.set(id, facility);
    return facility;
  }

  get(facilityId: string): Facility | null {
    return this.facilities.get(facilityId) ?? null;
  }

  findCandidates(
    serverProfileId: string,
    dimension: string,
    facilityType: FacilityType,
    reference: BlockPosition,
  ): readonly Facility[] {
    const matches: Array<{ facility: Facility; distSq: number }> = [];
    for (const facility of this.facilities.values()) {
      if (
        facility.serverProfileId === serverProfileId &&
        facility.dimension === dimension &&
        facility.facilityType === facilityType
      ) {
        const dx = facility.anchor.x - reference.x;
        const dy = facility.anchor.y - reference.y;
        const dz = facility.anchor.z - reference.z;
        matches.push({ facility, distSq: dx * dx + dy * dy + dz * dz });
      }
    }
    matches.sort((a, b) => a.distSq - b.distSq);
    return matches.map((m) => m.facility);
  }

  findByBase(baseId: string): readonly Facility[] {
    const results: Facility[] = [];
    for (const facility of this.facilities.values()) {
      if (facility.baseId === baseId) results.push(facility);
    }
    return results;
  }

  nextPlannableSlot(facilityId: string): FacilitySlot | null {
    const facility = this.facilities.get(facilityId);
    if (!facility) return null;
    return facility.slots.find((slot) => slot.status === "planned") ?? null;
  }

  /** 预约 TTL 纪律（与 workstation-registry 的 boundedTtl 同款）：有限、
   *  ≥1ms、上界 120s。此前无任何校验——RPC 直通的巨大 TTL 会让
   *  expireReservations 永远无法回收该施工位（owner-safe 的释放又不能
   *  代执行），一次坏调用 = 设施永久损失该 slot。续租机制本就支持按需
   *  延长，上界只约束单次粒度。 */
  private boundedReservationTtl(ttlMs: number): number {
    if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 120_000) throw new Error("FACILITY_TTL_INVALID");
    return ttlMs;
  }

  reserveSlot(facilityId: string, slotIndex: number, botId: string, ttlMs = 30_000): boolean {
    const slot = this.mutableSlot(facilityId, slotIndex);
    if (!slot) return false;
    if (!canTransition(slot.fields.status, "placement_reserved")) return false;
    if (slot.fields.status === "placement_reserved") return false; // 同状态不可重复 reserve
    const ttl = this.boundedReservationTtl(ttlMs); // 先校验后变更：越界调用不留半套状态
    slot.fields.status = "placement_reserved";
    slot.fields.reservedBy = botId;
    slot.fields.reservedUntilMs = this.now() + ttl;
    slot.fields.statusReason = null;
    return true;
  }

  releaseReservation(facilityId: string, slotIndex: number, reason: string, botId?: string): boolean {
    const slot = this.mutableSlot(facilityId, slotIndex);
    if (!slot) return false;
    if (!canTransition(slot.fields.status, "planned")) return false;
    // owner-safe：非持有者不得释放他人的 reservation
    if (botId !== undefined && slot.fields.reservedBy !== null && slot.fields.reservedBy !== botId) return false;
    slot.fields.status = "planned";
    slot.fields.reservedBy = null;
    slot.fields.reservedUntilMs = null;
    slot.fields.statusReason = reason;
    return true;
  }

  renewSlotReservation(facilityId: string, slotIndex: number, botId: string, ttlMs = 30_000): boolean {
    const slot = this.mutableSlot(facilityId, slotIndex);
    if (!slot) return false;
    if (slot.fields.status !== "placement_reserved") return false;
    if (slot.fields.reservedBy !== botId) return false;
    const ttl = this.boundedReservationTtl(ttlMs); // 先校验后变更
    slot.fields.reservedUntilMs = this.now() + ttl;
    return true;
  }

  markSlotOccupied(
    facilityId: string,
    slotIndex: number,
    workstationEntryKey: string,
    opts?: Readonly<{ reservationOwner?: string }>,
  ): boolean {
    const slot = this.mutableSlot(facilityId, slotIndex);
    if (!slot) return false;
    if (!canTransition(slot.fields.status, "occupied")) return false;
    // owner-safe：指定 reservationOwner 时必须是当前持有者
    if (opts?.reservationOwner !== undefined) {
      if (slot.fields.status !== "placement_reserved") return false;
      if (slot.fields.reservedBy !== opts.reservationOwner) return false;
    }
    slot.fields.status = "occupied";
    slot.fields.reservedBy = null;
    slot.fields.reservedUntilMs = null;
    slot.fields.workstationEntryKey = workstationEntryKey;
    slot.fields.lastVerifiedAtMs = this.now();
    slot.fields.statusReason = null;
    slot.fields.failureCount = 0;
    slot.fields.lastFailureAtMs = null;
    return true;
  }

  /** 施工失败：placement_reserved → temporarily_blocked，累计 failureCount。仅预约持有者可上报。 */
  markPlacementFailed(facilityId: string, slotIndex: number, reason: string, botId: string): boolean {
    const slot = this.mutableSlot(facilityId, slotIndex);
    if (!slot) return false;
    if (slot.fields.status !== "placement_reserved") return false;
    if (slot.fields.reservedBy !== botId) return false;
    if (!canTransition(slot.fields.status, "temporarily_blocked")) return false;
    slot.fields.status = "temporarily_blocked";
    slot.fields.reservedBy = null;
    slot.fields.reservedUntilMs = null;
    slot.fields.failureCount += 1;
    slot.fields.lastFailureAtMs = this.now();
    slot.fields.statusReason = reason;
    return true;
  }

  markSlotMissing(facilityId: string, slotIndex: number, reason: string): boolean {
    const slot = this.mutableSlot(facilityId, slotIndex);
    if (!slot) return false;
    if (!canTransition(slot.fields.status, "missing")) return false;
    slot.fields.status = "missing";
    slot.fields.reservedBy = null;
    slot.fields.reservedUntilMs = null;
    slot.fields.workstationEntryKey = null;
    slot.fields.statusReason = reason;
    return true;
  }

  markSlotTemporarilyBlocked(facilityId: string, slotIndex: number, reason: string): boolean {
    const slot = this.mutableSlot(facilityId, slotIndex);
    if (!slot) return false;
    if (!canTransition(slot.fields.status, "temporarily_blocked")) return false;
    slot.fields.status = "temporarily_blocked";
    slot.fields.reservedBy = null;
    slot.fields.reservedUntilMs = null;
    slot.fields.statusReason = reason;
    return true;
  }

  markSlotInvalid(facilityId: string, slotIndex: number, reason: string): boolean {
    const slot = this.mutableSlot(facilityId, slotIndex);
    if (!slot) return false;
    if (!canTransition(slot.fields.status, "invalid")) return false;
    slot.fields.status = "invalid";
    slot.fields.reservedBy = null;
    slot.fields.reservedUntilMs = null;
    slot.fields.workstationEntryKey = null;
    slot.fields.statusReason = reason;
    return true;
  }

  replanSlot(facilityId: string, slotIndex: number): boolean {
    const slot = this.mutableSlot(facilityId, slotIndex);
    if (!slot) return false;
    if (!canTransition(slot.fields.status, "planned")) return false;
    // 退避期保护：失败后必须等待 10s * 2^(failureCount-1)，防止热循环浪费
    if (
      slot.fields.status === "temporarily_blocked" &&
      slot.fields.lastFailureAtMs !== null
    ) {
      const backoffUntil = slot.fields.lastFailureAtMs + placementBackoffMs(slot.fields.failureCount);
      if (this.now() < backoffUntil) return false;
    }
    slot.fields.status = "planned";
    slot.fields.statusReason = "replanned";
    return true;
  }

  observeSlot(
    facilityId: string,
    slotIndex: number,
    observation: Readonly<{ blockPresent: boolean; blockName: string | null }>,
  ): boolean {
    const slot = this.mutableSlot(facilityId, slotIndex);
    if (!slot) return false;
    const facility = this.facilities.get(facilityId)!;
    facility.lastObservedAt = new Date(this.now()).toISOString();

    if (observation.blockPresent) {
      if (observation.blockName === slot.slot.workstationType) {
        if (canTransition(slot.fields.status, "occupied")) {
          slot.fields.status = "occupied";
          slot.fields.reservedBy = null;
          slot.fields.reservedUntilMs = null;
          slot.fields.lastVerifiedAtMs = this.now();
          slot.fields.statusReason = null;
          return true;
        }
        return false;
      }
      // 位置上有别的方块 → 外来占据
      if (canTransition(slot.fields.status, "temporarily_blocked")) {
        slot.fields.status = "temporarily_blocked";
        slot.fields.reservedBy = null;
        slot.fields.reservedUntilMs = null;
        slot.fields.workstationEntryKey = null;
        slot.fields.statusReason = `foreign_block:${observation.blockName}`;
        return true;
      }
      return false;
    }
    // 方块不在：unknown → 可规划；occupied → missing
    if (slot.fields.status === "unknown") {
      slot.fields.status = "planned";
      slot.fields.statusReason = "observed_empty";
      return true;
    }
    if (canTransition(slot.fields.status, "missing")) {
      slot.fields.status = "missing";
      slot.fields.workstationEntryKey = null;
      slot.fields.statusReason = "block_absent";
      return true;
    }
    return false;
  }

  expireReservations(facilityId: string): number {
    const facility = this.facilities.get(facilityId);
    if (!facility) return 0;
    const now = this.now();
    let released = 0;
    for (const slot of facility.slots) {
      if (
        slot.status === "placement_reserved" &&
        slot.reservedUntilMs !== null &&
        now >= slot.reservedUntilMs
      ) {
        slot.status = "planned";
        slot.reservedBy = null;
        slot.reservedUntilMs = null;
        slot.statusReason = "reservation_expired";
        released += 1;
      }
    }
    return released;
  }

  // -- 兼容别名（老调用点逐步迁移） ----------------------------------------

  /** @deprecated 用 findCandidates */
  find(serverProfileId: string, dimension: string, facilityType: FacilityType): Facility | null {
    let first: Facility | null = null;
    for (const facility of this.facilities.values()) {
      if (
        facility.serverProfileId === serverProfileId &&
        facility.dimension === dimension &&
        facility.facilityType === facilityType
      ) {
        if (!first || facility.createdAt < first.createdAt) first = facility;
      }
    }
    return first;
  }

  get size(): number {
    return this.facilities.size;
  }

  // -- 快照（Phase 5/6：跨进程 / 持久化） -----------------------------------

  serialize(): { facilities: Facility[] } {
    return { facilities: [...this.facilities.values()] };
  }

  static restore(snapshot: unknown, options: FacilityRegistryOptions = {}): FacilityRegistry {
    const reg = new FacilityRegistry(options);
    const root = snapshot as { facilities?: Facility[] };
    for (const facility of root?.facilities ?? []) {
      if (!facility || typeof facility.id !== "string" || !Array.isArray(facility.slots)) continue;
      reg.facilities.set(facility.id, facility);
    }
    return reg;
  }

  /** 合并快照：同 id 以 incoming 为准（服务端恢复用）。 */
  absorb(other: { serialize(): { facilities: Facility[] } }): number {
    let merged = 0;
    for (const facility of other.serialize().facilities) {
      if (!facility || typeof facility.id !== "string" || !Array.isArray(facility.slots)) continue;
      this.facilities.set(facility.id, facility);
      merged += 1;
    }
    return merged;
  }

  // -- 内部：可变字段访问（slots 是浅 readonly，集中在此处理） ---------------

  private mutableSlot(
    facilityId: string,
    slotIndex: number,
  ): { slot: FacilitySlot; fields: MutableSlotFields } | null {
    const facility = this.facilities.get(facilityId);
    if (!facility) return null;
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= facility.slots.length) return null;
    const slot = facility.slots[slotIndex]!;
    return { slot, fields: slot as unknown as MutableSlotFields };
  }
}
