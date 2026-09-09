import { blueprintSchema, type Blueprint } from './blueprint-contracts.js';
import { bedSiteSchema, residenceCheckOutputSchema, residenceRecordSchema, type BedSite,
  type ResidenceRecord } from './residence.js';
import type { BlockPosition } from '@minecraft-studio/asset-policy/workstation-registry';
import { baseLayoutSchema, planBaseLayout, type BaseLayout } from './base-layout.js';
export type BaseStatus = "planned" | "building" | "operational" | "damaged" | "abandoned";

export type BaseAvailability = "UNVERIFIED" | "AVAILABLE" | "DAMAGED" | "RECOVERING";
export interface BasePhaseFact {
  availability: BaseAvailability;
  everCompleted: boolean;
  evidence: string;
  observedAt: string;
  validator: string;
}

export interface BaseRecord {
  readonly worldId?: string | null;
  readonly id: string;
  readonly name: string;
  readonly serverProfileId: string;
  readonly dimension: string;
  readonly anchor: BlockPosition;
  readonly blueprintId: string;
  readonly blueprintVersion: number;
  source?: "bot_built" | "operator_adopted";
  protectedBounds?: { min: BlockPosition; max: BlockPosition };
  memberBotIds?: string[];
  phaseFacts?: Record<string, BasePhaseFact>;
  layout?: BaseLayout;
  status: BaseStatus;
  /** 已确认放置的 cell 数（0..totalCells）。 */
  placedCells: number;
  placedCellIndices?: number[];
  totalCells?: number;
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
export function baseId(serverProfileId: string, dimension: string, anchor: BlockPosition, worldId?: string | null): string {
  const scope = fnv1a(worldId ? JSON.stringify([serverProfileId, worldId, dimension]) : `${serverProfileId}|${dimension}`);
  return `base-${scope}_${anchor.x}_${anchor.y}_${anchor.z}`;
}

export class BaseRegistry {
  private readonly bases = new Map<string, BaseRecord>();
  private readonly residences = new Map<string, ResidenceRecord>();
  private readonly cellReservations = new Map<string, Map<number, BaseCellReservation>>();
  private readonly defaultCellTtlMs: number;
  private readonly now: () => number;

  constructor(options: BaseRegistryOptions = {}) {
    this.defaultCellTtlMs = options.defaultCellTtlMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  protectBlueprint(id: string, raw: Blueprint): void {
    const blueprint = blueprintSchema.parse(raw);
    const base = this.bases.get(id);
    if (!base || base.serverProfileId !== blueprint.serverProfileId || base.dimension !== blueprint.dimension) {
      throw new Error("BASE_PROTECTION_SCOPE_MISMATCH");
    }
    const positions = blueprint.cells.map((cell) => ({ x: blueprint.anchor.x + cell.offset.x,
      y: blueprint.anchor.y + cell.offset.y, z: blueprint.anchor.z + cell.offset.z }));
    const previous = base.protectedBounds;
    const bounds = { min: { ...blueprint.anchor }, max: { ...blueprint.anchor } };
    for (const axis of ["x", "y", "z"] as const) {
      bounds.min[axis] = Math.min(...positions.map((p) => p[axis] - 1), previous?.min[axis] ?? Infinity);
      bounds.max[axis] = Math.max(...positions.map((p) => p[axis] + 1), previous?.max[axis] ?? -Infinity);
    }
    base.protectedBounds = bounds;
    base.updatedAt = new Date(this.now()).toISOString();
  }

  ensureLayout(id: string): BaseLayout {
    const base = this.bases.get(id);
    if (!base || base.source === "operator_adopted") throw new Error("BASE_LAYOUT_NOT_AUTONOMOUS");
    const layout = baseLayoutSchema.parse(base.layout ?? planBaseLayout(base));
    if (layout.mainArea.serverProfileId !== base.serverProfileId || layout.mainArea.dimension !== base.dimension ||
        ["x", "y", "z"].some((axis) => layout.anchor[axis as keyof BlockPosition] !== base.anchor[axis as keyof BlockPosition])) {
      throw new Error("BASE_LAYOUT_SCOPE_INVALID");
    }
    base.layout = layout;
    return layout;
  }

  create(params: Readonly<{
    name: string;
    serverProfileId: string;
    worldId?: string | null | undefined;
    dimension: string;
    anchor: BlockPosition;
    blueprintId: string;
    blueprintVersion?: number;
    createdByBotId?: string;
  }>): BaseRecord {
    const id = baseId(params.serverProfileId, params.dimension, params.anchor, params.worldId);
    const existing = this.bases.get(id);
    if (existing) return existing;
    const iso = new Date(this.now()).toISOString();
    const record: BaseRecord = {
      id,
      name: params.name,
      serverProfileId: params.serverProfileId,
      ...(params.worldId === undefined ? {} : { worldId: params.worldId }),
      dimension: params.dimension,
      anchor: params.anchor,
      blueprintId: params.blueprintId,
      blueprintVersion: params.blueprintVersion ?? 1,
      memberBotIds: params.createdByBotId ? [params.createdByBotId] : [],
      phaseFacts: {},
      status: "planned",
      placedCells: 0,
      placedCellIndices: [],
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

  addMember(baseId: string, serverProfileId: string, dimension: string, botId: string): boolean {
    const base = this.bases.get(baseId);
    if (!base || base.serverProfileId !== serverProfileId || base.dimension !== dimension) return false;
    base.memberBotIds ??= base.createdByBotId ? [base.createdByBotId] : [];
    if (!base.memberBotIds.includes(botId)) base.memberBotIds.push(botId);
    base.updatedAt = new Date(this.now()).toISOString();
    return true;
  }

  assignMember(baseId: string, serverProfileId: string, dimension: string, botId: string): boolean {
    const target = this.bases.get(baseId);
    if (!target || target.serverProfileId !== serverProfileId || target.dimension !== dimension || target.status === "abandoned") return false;
    for (const base of this.bases.values()) {
      if (base.id === baseId || base.serverProfileId !== serverProfileId || base.dimension !== dimension) continue;
      base.memberBotIds = (base.memberBotIds ?? (base.createdByBotId ? [base.createdByBotId] : [])).filter((id) => id !== botId);
    }
    return this.addMember(baseId, serverProfileId, dimension, botId);
  }

  forMember(botId: string, serverProfileId: string, dimension: string, worldId: string | null = null): BaseRecord | null {
    const residence = worldId !== null ? this.residences.get(JSON.stringify([serverProfileId, worldId, botId])) : undefined;
    if (residence?.homeBaseId) {
      const home = this.bases.get(residence.homeBaseId);
      if (home && home.dimension === dimension && home.serverProfileId === serverProfileId &&
          home.worldId === worldId && home.status !== "abandoned") return home;
    }
    const matches = [...this.bases.values()].filter((base) => base.serverProfileId === serverProfileId &&
      base.dimension === dimension && (base.worldId ?? null) === worldId && base.status !== "abandoned" &&
      (base.memberBotIds ?? [base.createdByBotId]).includes(botId));
    if (matches.length > 1) throw new Error("BASE_MEMBERSHIP_AMBIGUOUS");
    return matches[0] ?? null;
  }

  recordPhaseEvidence(baseId: string, phase: string, availability: BaseAvailability, evidence: string, validator: string): boolean {
    const base = this.bases.get(baseId);
    if (!base || !evidence || !validator) return false;
    const prior = base.phaseFacts?.[phase];
    base.phaseFacts ??= {};
    base.phaseFacts[phase] = {
      availability, everCompleted: prior?.everCompleted === true || availability === "AVAILABLE",
      evidence, validator, observedAt: new Date(this.now()).toISOString(),
    };
    base.updatedAt = new Date(this.now()).toISOString();
    return true;
  }

  currentPhaseFact(baseId: string, phase: string, maxAgeMs = 60_000): BasePhaseFact | null {
    const fact = this.bases.get(baseId)?.phaseFacts?.[phase];
    if (!fact) return null;
    if (phase !== "BASE_SITE_RESERVED" && this.now() - Date.parse(fact.observedAt) > maxAgeMs) {
      return { ...fact, availability: "UNVERIFIED" };
    }
    return { ...fact };
  }

  markFactsUnverified(baseId?: string): void {
    for (const base of this.bases.values()) {
      if (baseId && base.id !== baseId) continue;
      for (const [phase, fact] of Object.entries(base.phaseFacts ?? {})) {
        if (phase !== "BASE_SITE_RESERVED") fact.availability = "UNVERIFIED";
      }
    }
    // A reconnect or world reload invalidates live bed/sign evidence. Keep the
    // durable site and operation so the coordinator can reconcile it, but never
    // continue presenting the old server confirmation as current.
    for (const [key, record] of this.residences) {
      if (baseId && record.site.baseId !== baseId) continue;
      const next = structuredClone(record);
      next.bindingReceipt = null;
      next.markerReceipt = null;
      next.lastError = "RESIDENCE_REVERIFY_REQUIRED";
      if (next.status === "SETTLED") next.status = "RECONCILING";
      this.residences.set(key, next);
    }
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
    if (base.totalCells !== undefined && cellIndex >= base.totalCells) return false;
    base.placedCellIndices ??= [];
    if (!base.placedCellIndices.includes(cellIndex)) base.placedCellIndices.push(cellIndex);
    base.placedCells = base.placedCellIndices.length;
    base.updatedAt = new Date(this.now()).toISOString();
    this.cellReservations.get(baseId)?.delete(cellIndex);
    const total = base.totalCells;
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
    base.totalCells = totalCells;
    return true;
  }

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

  residence(botId: string, serverProfileId: string, worldId: string): ResidenceRecord | null {
    const value = this.residences.get(JSON.stringify([serverProfileId, worldId, botId]));
    return value ? structuredClone(value) : null;
  }

  /** Reserve a verified/explicitly assigned site before any world operation.
   * Both records and membership persist through the same shared-state commit. */
  reserveResidence(raw: BedSite, taskId: string, operationId: string, persist: () => void): ResidenceRecord {
    const site = bedSiteSchema.parse(raw);
    const base = this.bases.get(site.baseId);
    if (!base || base.serverProfileId !== site.scope.serverProfileId || base.worldId !== site.scope.worldId)
      throw new Error("RESIDENCE_BASE_SCOPE_MISMATCH");
    for (const value of this.residences.values()) {
      if (value.site.scope.serverProfileId === site.scope.serverProfileId && value.site.scope.worldId === site.scope.worldId &&
          value.site.scope.dimension === site.scope.dimension && value.site.scope.botId !== site.scope.botId &&
          [value.site.head, value.site.foot, value.site.marker].some((p) =>
            [site.head, site.foot, site.marker].some((q) => p.x === q.x && p.y === q.y && p.z === q.z)))
        throw new Error("RESIDENCE_SITE_RESERVED");
    }
    const key = JSON.stringify([site.scope.serverProfileId, site.scope.worldId, site.scope.botId]);
    const prior = this.residences.get(key);
    if (prior?.operationId === operationId) {
      if (JSON.stringify(prior.site) !== JSON.stringify(site) || prior.taskId !== taskId) throw new Error("RESIDENCE_OPERATION_CONFLICT");
      return structuredClone(prior);
    }
    const record = residenceRecordSchema.parse({ site, revision: (prior?.revision ?? 0) + 1,
      homeBaseId: prior?.homeBaseId ?? null, targetHomeBaseId: site.baseId, status: "SETTLING", taskId, operationId,
      bindingReceipt: null, markerReceipt: null, lastObservedAt: null, lastError: null });
    this.residences.set(key, record);
    try { persist(); } catch (error) { if (prior) this.residences.set(key, prior); else this.residences.delete(key); throw error; }
    return structuredClone(record);
  }

  recordResidenceReceipt(taskId: string, raw: unknown, persist: () => void): ResidenceRecord {
    const receipt = residenceCheckOutputSchema.parse(raw);
    const key = JSON.stringify([receipt.serverProfileId, receipt.worldId, receipt.botId]);
    const prior = this.residences.get(key);
    if (!prior || prior.taskId !== taskId || prior.operationId !== receipt.operationId ||
        prior.site.siteId !== receipt.siteId || prior.site.revision !== receipt.siteRevision ||
        prior.site.scope.dimension !== receipt.dimension) throw new Error("RESIDENCE_RECEIPT_SCOPE_MISMATCH");
    if (prior.lastObservedAt && Date.parse(receipt.observedAt) < Date.parse(prior.lastObservedAt))
      throw new Error("RESIDENCE_RECEIPT_STALE");
    const next = structuredClone(prior);
    next.revision++; next.lastObservedAt = receipt.observedAt; next.lastError = receipt.reason;
    if (receipt.binding === "SERVER_CONFIRMED") next.bindingReceipt = receipt;
    else if (receipt.binding === "INVALID" || !receipt.bedPresent || !receipt.usable) next.bindingReceipt = null;
    if (receipt.marker === "SERVER_CONFIRMED") next.markerReceipt = receipt;
    else if (receipt.marker === "INVALID" || !receipt.markerPresent) next.markerReceipt = null;
    if (!receipt.bedPresent || !receipt.usable) { next.bindingReceipt = null; next.status = "INVALID"; }
    else if (!receipt.markerPresent) { next.markerReceipt = null; next.status = "SETTLING"; }
    if (next.bindingReceipt && next.markerReceipt && receipt.bedPresent && receipt.usable && receipt.markerPresent) {
      next.homeBaseId = next.targetHomeBaseId; next.targetHomeBaseId = null; next.status = "SETTLED";
    }
    const beforeMembers = [...this.bases.values()].map((b) => ({ id: b.id, members: b.memberBotIds && [...b.memberBotIds] }));
    if (next.status === "SETTLED" && next.homeBaseId) {
      const home = this.bases.get(next.homeBaseId)!;
      for (const b of this.bases.values()) {
        if (b.serverProfileId === receipt.serverProfileId && b.worldId === receipt.worldId)
          b.memberBotIds = (b.memberBotIds ?? []).filter((id) => id !== receipt.botId);
      }
      home.memberBotIds = [...(home.memberBotIds ?? []), receipt.botId];
    }
    this.residences.set(key, residenceRecordSchema.parse(next));
    try { persist(); } catch (error) {
      this.residences.set(key, prior);
      for (const previous of beforeMembers) {
        const b = this.bases.get(previous.id)!;
        if (previous.members) b.memberBotIds = previous.members; else delete b.memberBotIds;
      }
      throw error;
    }
    return structuredClone(next);
  }

  serialize(): { bases: BaseRecord[]; residences: ResidenceRecord[] } {
    return { bases: [...this.bases.values()], residences: [...this.residences.values()] };
  }

  static restore(snapshot: { bases?: BaseRecord[]; residences?: ResidenceRecord[] }, options: BaseRegistryOptions = {}): BaseRegistry {
    const reg = new BaseRegistry(options);
    for (const base of snapshot?.bases ?? []) {
      if (!base || typeof base.id !== "string") continue;
      reg.bases.set(base.id, base);
    }
    for (const raw of snapshot.residences ?? []) {
      const record = residenceRecordSchema.parse(raw), s = record.site.scope;
      const key = JSON.stringify([s.serverProfileId, s.worldId, s.botId]);
      if (reg.residences.has(key)) throw new Error("RESIDENCE_DUPLICATE_IDENTITY");
      reg.residences.set(key, record);
    }
    return reg;
  }

  /** 合并快照：同 id 以 incoming 为准（服务端恢复用）。cell 预约不恢复（ephemeral）。 */
  absorb(other: { serialize(): { bases: BaseRecord[]; residences?: ResidenceRecord[] } }): number {
    let merged = 0;
    for (const base of other.serialize().bases) {
      if (!base || typeof base.id !== "string") continue;
      this.bases.set(base.id, base);
      this.cellReservations.delete(base.id); // ephemeral：绝不恢复别人的预约
      merged += 1;
    }
    for (const record of other.serialize().residences ?? []) {
      const s = record.site.scope;
      this.residences.set(JSON.stringify([s.serverProfileId, s.worldId, s.botId]), structuredClone(record));
    }
    return merged;
  }

  get size(): number {
    return this.bases.size;
  }
}

// ---------------------------------------------------------------------------
// reconcileBlueprint（BlueprintReconciler 核心）
// ---------------------------------------------------------------------------
