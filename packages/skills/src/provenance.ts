// ---------------------------------------------------------------------------
// provenance.ts —— Material Provenance：bot.dig 边界 HarvestAuthorization。
//
// 纪律（MASTER ROUND Phase 3）：
//   1. 普通 collect/mine 最终 adapter 必须验证 HarvestAuthorization。
//   2. 不允许下层 bot.dig 绕过。
//   3. unknown near own base fail-closed。
//   4. explicit deconstruction/salvage 与普通采集分离。
//   5. Build placement server verify 后写 provenance。
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const provenanceSourceSchema = z.enum([
  "natural", "bot_placed", "team_placed", "external_placed", "generated", "unknown",
]);
export type ProvenanceSource = z.infer<typeof provenanceSourceSchema>;

export const provenanceOwnerSchema = z.enum([
  "own_bot", "own_team", "external", "none", "unknown",
]);
export type ProvenanceOwner = z.infer<typeof provenanceOwnerSchema>;

export const provenancePurposeSchema = z.enum([
  "structural", "facility", "storage", "farm", "portal", "redstone",
  "navigation", "temporary", "sacrificial", "resource",
]);
export type ProvenancePurpose = z.infer<typeof provenancePurposeSchema>;

export const provenanceRecordSchema = z
  .object({
    /** 全局唯一记录 ID。 */
    recordId: z.string().min(1).max(128),
    serverProfileId: z.string().min(1).max(128),
    dimension: z.string().min(1).max(128),
    position: z.object({
      x: z.number().int(),
      y: z.number().int(),
      z: z.number().int(),
    }).strict(),
    source: provenanceSourceSchema,
    owner: provenanceOwnerSchema,
    purpose: provenancePurposeSchema.optional(),
    /** 放置该方块的 bot（bot_placed/team_placed 时）。 */
    placedByBotId: z.string().max(128).optional(),
    /** 关联的 build/facility/plan。 */
    buildId: z.string().max(128).optional(),
    facilityId: z.string().max(128).optional(),
    /** 记录时间（epoch ms）。 */
    recordedAtMs: z.number().int(),
    /** 服务器验证过（非仅客户端预测）。 */
    serverVerified: z.boolean().default(false),
  })
  .strict();
export type ProvenanceRecord = z.infer<typeof provenanceRecordSchema>;

// ---------------------------------------------------------------------------
// HarvestAuthorization 决策
// ---------------------------------------------------------------------------

export type HarvestDecision =
  | { allowed: true; reason: "unprotected" | "natural" | "authorized_salvage" }
  | { allowed: false; reason: string; code: "HARVEST_PROTECTED_OWN" | "HARVEST_PROTECTED_TEAM" | "HARVEST_UNKNOWN_NEAR_BASE" };

/**
 * 判定是否允许采集/挖掘指定位置的方块。
 *
 * 规则（fail-closed）：
 *   1. 无 provenance 记录 → allowed（natural/未标记区域）
 *   2. owner=own_bot 或 own_team → 拒绝（除非 explicit salvage 授权）
 *   3. purpose 在保护列表中（facility/storage/farm/portal）→ 拒绝
 *   4. unknown 且位于 own base 保护范围内 → 拒绝（fail-closed）
 */
export function authorizeHarvest(input: {
  record: ProvenanceRecord | null;
  /** 是否有显式拆除/回收授权（salvage mode）。 */
  explicitSalvageAuthorized: boolean;
  /** 位置是否在己方基地保护范围内（空间检查）。 */
  nearOwnBase: boolean;
}): HarvestDecision {
  if (input.record === null) {
    // 无记录 + 在己方保护范围内 → fail-closed
    if (input.nearOwnBase) {
      return { allowed: false, reason: "unknown block near own base (fail-closed)", code: "HARVEST_UNKNOWN_NEAR_BASE" };
    }
    return { allowed: true, reason: "unprotected" };
  }
  if (input.explicitSalvageAuthorized) {
    return { allowed: true, reason: "authorized_salvage" };
  }
  if (input.record.owner === "own_bot" || input.record.owner === "own_team") {
    return {
      allowed: false,
      reason: `block owned by ${input.record.owner} (purpose=${input.record.purpose ?? "unknown"})`,
      code: input.record.owner === "own_bot" ? "HARVEST_PROTECTED_OWN" : "HARVEST_PROTECTED_TEAM",
    };
  }
  // purpose 为保护类且 owner 不明 → 保守拒绝
  const protectedPurposes: ReadonlySet<string> = new Set(["facility", "storage", "farm", "portal"]);
  if (input.record.purpose !== undefined && protectedPurposes.has(input.record.purpose) && input.record.owner !== "external") {
    return { allowed: false, reason: `protected purpose=${input.record.purpose}`, code: "HARVEST_PROTECTED_OWN" };
  }
  return { allowed: true, reason: input.record.source === "natural" ? "natural" : "unprotected" };
}

// ---------------------------------------------------------------------------
// In-memory ProvenanceStore（bounded, chunk-indexed）
// ---------------------------------------------------------------------------

export interface ProvenanceStoreOptions {
  maxRecords?: number;
}

const DEFAULT_MAX_RECORDS = 8192;

export class ProvenanceStore {
  private readonly records = new Map<string, ProvenanceRecord>();
  private readonly maxRecords: number;
  /** chunk key → Set<recordKey> 空间索引。 */
  private readonly chunkIndex = new Map<string, Set<string>>();

  constructor(options: ProvenanceStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  }

  private static key(pos: { x: number; y: number; z: number }, dimension: string): string {
    return `${dimension}:${pos.x},${pos.y},${pos.z}`;
  }

  private static chunkKey(pos: { x: number; z: number }, dimension: string): string {
    return `${dimension}:${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`;
  }

  /** 记录一个方块的 provenance（build placement server verify 后调用）。 */
  record(entry: Omit<ProvenanceRecord, "recordId" | "recordedAtMs"> & { recordId?: string }): ProvenanceRecord {
    const key = ProvenanceStore.key(entry.position, entry.dimension);
    const existing = this.records.get(key);
    if (existing !== undefined) {
      const updated: ProvenanceRecord = { ...existing, ...entry, recordId: existing.recordId, recordedAtMs: existing.recordedAtMs };
      this.records.set(key, updated);
      return updated;
    }
    if (this.records.size >= this.maxRecords) {
      this.evictOldest();
    }
    const now = Date.now();
    const record: ProvenanceRecord = {
      ...entry,
      recordId: entry.recordId ?? `prov-${now}-${this.records.size}`,
      recordedAtMs: now,
    } as ProvenanceRecord;
    this.records.set(key, record);
    const ck = ProvenanceStore.chunkKey(entry.position, entry.dimension);
    const set = this.chunkIndex.get(ck) ?? new Set<string>();
    set.add(key);
    this.chunkIndex.set(ck, set);
    return record;
  }

  /** 查询指定位置的 provenance（无则 null）。 */
  get(position: { x: number; y: number; z: number }, dimension: string): ProvenanceRecord | null {
    return this.records.get(ProvenanceStore.key(position, dimension)) ?? null;
  }

  /** 查询 chunk 内所有记录。 */
  getChunk(chunkX: number, chunkZ: number, dimension: string): readonly ProvenanceRecord[] {
    const ck = `${dimension}:${chunkX},${chunkZ}`;
    const keys = this.chunkIndex.get(ck);
    if (keys === undefined) return [];
    return [...keys].map((key) => this.records.get(key)).filter((r): r is ProvenanceRecord => r !== undefined);
  }

  get size(): number {
    return this.records.size;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, record] of this.records) {
      if (record.recordedAtMs < oldestTime) {
        oldestKey = key;
        oldestTime = record.recordedAtMs;
      }
    }
    if (oldestKey !== null) {
      const record = this.records.get(oldestKey);
      this.records.delete(oldestKey);
      if (record !== undefined) {
        const ck = ProvenanceStore.chunkKey(record.position, record.dimension);
        this.chunkIndex.get(ck)?.delete(oldestKey);
      }
    }
  }
}
