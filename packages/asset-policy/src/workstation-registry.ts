// ---------------------------------------------------------------------------
// WorkstationRegistry v1.1 — P0 correctness fixes
//
// Fixes from review:
//   P0-1: acquire returns authoritative entry via get(), not findCandidates re-query
//   P0-2: scan→claim race: check claim() return in scan path
//   P0-3: claim() must NOT refresh lastSeenAt (separate lastClaimedAt)
//   P0-4: shared workstation no lease penalty in findCandidates
//   P0-5: busy ≠ not_found (WorkstationAcquireResult gains "busy")
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

export type WorkstationType =
  | "crafting_table"
  | "furnace"
  | "blast_furnace"
  | "smoker"
  | "anvil"
  | "enchanting_table"
  | "brewing_stand"
  | "stonecutter"
  | "smithing_table"
  | "grindstone"
  | "chest"
  | "barrel";

export type WorkstationUsageMode = "shared" | "exclusive";

export type BlockPosition = Readonly<{ x: number; y: number; z: number }>;

export interface WorkstationLease {
  readonly leaseId: string;
  readonly generation: number;
  readonly ownerBotId: string;
  readonly ownerRuntimeId: string;
  readonly ownerTaskId: string;
  readonly ownerAttemptId: string;
  readonly expiresAtMs: number;
}

export type WorkstationLeaseOwner = Pick<WorkstationLease, "ownerRuntimeId" | "ownerTaskId" | "ownerAttemptId">;

export interface WorkstationEntry {
  readonly type: WorkstationType;
  readonly position: BlockPosition;
  readonly dimension: string;
  readonly serverProfileId: string;
  readonly usageMode: WorkstationUsageMode;
  /** 最后一次通过服务器观测确认方块存在的时间。claim 不刷新此字段。 */
  lastSeenAt: number;
  /** 最后一次被 claim/renew 的时间（区别于 lastSeenAt）。 */
  lastClaimedAt: number | null;
  confidence: number;
  lease: WorkstationLease | null;
}

/** acquire 结果：busy ≠ not_found——busy 意味着设备存在但被占用。 */
export type WorkstationAcquireResult =
  | Readonly<{ status: "acquired"; entry: WorkstationEntry }>
  | Readonly<{ status: "busy"; entry: WorkstationEntry; retryAfterMs: number }>
  | Readonly<{ status: "not_found"; mayCreate: true }>
  | Readonly<{ status: "unreachable" }>;

// ---------------------------------------------------------------------------

export function normalizeBlockPos(p: { x: number; y: number; z: number }): BlockPosition {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function posKey(serverProfileId: string, dimension: string, p: BlockPosition): string {
  return `${serverProfileId}|${dimension}|${p.x}|${p.y}|${p.z}`;
}

const USAGE_MODES: Readonly<Record<WorkstationType, WorkstationUsageMode>> = Object.freeze({
  crafting_table: "shared",
  stonecutter: "shared",
  smithing_table: "shared",
  anvil: "shared",
  enchanting_table: "shared",
  grindstone: "shared",
  furnace: "exclusive",
  blast_furnace: "exclusive",
  smoker: "exclusive",
  brewing_stand: "exclusive",
  chest: "exclusive",
  barrel: "exclusive",
});

export function usageModeFor(type: WorkstationType): WorkstationUsageMode {
  return USAGE_MODES[type] ?? "shared";
}

function decayedConfidence(entry: WorkstationEntry, ttlMs: number, now: number): number {
  const age = now - entry.lastSeenAt;
  if (age >= ttlMs) return 0;
  return entry.confidence * (1 - age / ttlMs);
}

// ---------------------------------------------------------------------------

export interface WorkstationRegistryOptions {
  readonly entryTtlMs?: number;
  readonly leaseTtlMs?: number;
  readonly maxEntries?: number;
}

export interface WorkstationRegistryPort {
  register(serverProfileId: string, dimension: string, type: WorkstationType, position: { x: number; y: number; z: number }, confidence?: number): WorkstationEntry;
  get(serverProfileId: string, dimension: string, position: BlockPosition): WorkstationEntry | null;
  findCandidates(serverProfileId: string, dimension: string, type: WorkstationType, from: { x: number; y: number; z: number }, maxDistance?: number): readonly WorkstationEntry[];
  claim(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, ttlMs?: number, owner?: WorkstationLeaseOwner): boolean;
  renewClaim(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, ttlMs?: number, lease?: WorkstationLease): boolean;
  release(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, lease?: WorkstationLease): void;
  commit(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, lease: WorkstationLease): boolean;
  invalidate(serverProfileId: string, dimension: string, position: BlockPosition): void;
  releaseAllClaims(botId: string): void;
  clearServer(serverProfileId: string): void;
}

export class InMemoryWorkstationRegistry implements WorkstationRegistryPort {
  private readonly entries = new Map<string, WorkstationEntry>();
  private readonly entryTtlMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxEntries: number;
  private generation = 0;

  constructor(options: WorkstationRegistryOptions = {}) {
    this.entryTtlMs = options.entryTtlMs ?? 5 * 60_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.maxEntries = options.maxEntries ?? 512;
  }

  register(serverProfileId: string, dimension: string, type: WorkstationType, position: { x: number; y: number; z: number }, confidence = 1.0): WorkstationEntry {
    const pos = normalizeBlockPos(position);
    const key = posKey(serverProfileId, dimension, pos);
    const existing = this.entries.get(key);
    this.entries.set(key, {
      type,
      position: pos,
      dimension,
      serverProfileId,
      usageMode: usageModeFor(type),
      lastSeenAt: Date.now(),
      lastClaimedAt: existing?.lastClaimedAt ?? null,
      confidence,
      lease: existing && existing.type === type ? existing.lease : null,
    });
    this.evictIfNeeded();
    return this.entries.get(key)!;
  }

  /** P0-1: 返回 Registry 中的 authoritative entry。 */
  get(serverProfileId: string, dimension: string, position: BlockPosition): WorkstationEntry | null {
    return this.entries.get(posKey(serverProfileId, dimension, normalizeBlockPos(position))) ?? null;
  }

  findCandidates(serverProfileId: string, dimension: string, type: WorkstationType, from: { x: number; y: number; z: number }, maxDistance?: number): readonly WorkstationEntry[] {
    const now = Date.now();
    const results: Array<{ entry: WorkstationEntry; sortKey: number }> = [];
    for (const entry of this.entries.values()) {
      if (entry.serverProfileId !== serverProfileId) continue;
      if (entry.dimension !== dimension) continue;
      if (entry.type !== type) continue;
      const conf = decayedConfidence(entry, this.entryTtlMs, now);
      if (conf <= 0) continue;
      const dist = Math.hypot(entry.position.x - from.x, entry.position.y - from.y, entry.position.z - from.z);
      if (maxDistance !== undefined && dist > maxDistance) continue;
      // P0-4: shared workstation 不受 lease penalty——多 bot 可同时用
      const isExclusive = usageModeFor(entry.type) === "exclusive";
      const hasActiveLease = entry.lease !== null && now < entry.lease.expiresAtMs;
      const leasePenalty = isExclusive && hasActiveLease ? 1000 : 0;
      const sortKey = dist - conf * 10 + leasePenalty;
      results.push({ entry, sortKey });
    }
    return results.sort((a, b) => a.sortKey - b.sortKey).map((r) => r.entry);
  }

  claim(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, ttlMs?: number, owner?: WorkstationLeaseOwner): boolean {
    const key = posKey(serverProfileId, dimension, normalizeBlockPos(position));
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.usageMode === "shared") return true;
    const now = Date.now();
    if (entry.lease !== null && now < entry.lease.expiresAtMs) {
      return owner !== undefined && entry.lease.ownerBotId === botId &&
        entry.lease.ownerRuntimeId === owner.ownerRuntimeId && entry.lease.ownerTaskId === owner.ownerTaskId &&
        entry.lease.ownerAttemptId === owner.ownerAttemptId;
    }
    const leaseId = randomUUID();
    entry.lease = { leaseId, generation: ++this.generation, ownerBotId: botId,
      ownerRuntimeId: owner?.ownerRuntimeId ?? "legacy-unbound",
      ownerTaskId: owner?.ownerTaskId ?? leaseId, ownerAttemptId: owner?.ownerAttemptId ?? leaseId,
      expiresAtMs: now + this.boundedTtl(ttlMs) };
    // P0-3: claim 不刷新 lastSeenAt（claim 是控制面仲裁，不是服务端观测）
    entry.lastClaimedAt = now;
    return true;
  }

  renewClaim(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, ttlMs?: number, lease?: WorkstationLease): boolean {
    const key = posKey(serverProfileId, dimension, normalizeBlockPos(position));
    const entry = this.entries.get(key);
    if (!entry || !lease || !this.commit(serverProfileId, dimension, position, botId, lease)) return false;
    entry.lease = { ...entry.lease!, expiresAtMs: Date.now() + this.boundedTtl(ttlMs) };
    entry.lastClaimedAt = Date.now();
    return true;
  }

  release(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, lease?: WorkstationLease): void {
    const key = posKey(serverProfileId, dimension, normalizeBlockPos(position));
    const entry = this.entries.get(key);
    if (entry && lease && this.sameLease(entry.lease, botId, lease)) entry.lease = null;
  }

  commit(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, lease: WorkstationLease): boolean {
    const current = this.get(serverProfileId, dimension, position)?.lease;
    return !!current && current.expiresAtMs > Date.now() && this.sameLease(current, botId, lease);
  }

  private sameLease(current: WorkstationLease | null | undefined, botId: string, expected: WorkstationLease): boolean {
    return !!current && current.ownerBotId === botId && current.leaseId === expected.leaseId &&
      current.generation === expected.generation && current.ownerRuntimeId === expected.ownerRuntimeId &&
      current.ownerTaskId === expected.ownerTaskId && current.ownerAttemptId === expected.ownerAttemptId;
  }

  private boundedTtl(ttlMs?: number): number {
    const ttl = ttlMs ?? this.leaseTtlMs;
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 120_000) throw new Error("WORKSTATION_TTL_INVALID");
    return ttl;
  }

  invalidate(serverProfileId: string, dimension: string, position: BlockPosition): void {
    this.entries.delete(posKey(serverProfileId, dimension, normalizeBlockPos(position)));
  }

  releaseAllClaims(botId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.lease !== null && entry.lease.ownerBotId === botId && entry.lease.expiresAtMs <= Date.now()) entry.lease = null;
    }
  }

  clearServer(serverProfileId: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${serverProfileId}|`)) this.entries.delete(key);
    }
  }

  get size(): number { return this.entries.size; }

  /** 快照（Phase 5/6：跨进程 / 持久化）。 */
  serialize(): { entries: WorkstationEntry[] } {
    return { entries: [...this.entries.values()] };
  }

  static restore(snapshot: { entries?: WorkstationEntry[] }, options: WorkstationRegistryOptions = {}): InMemoryWorkstationRegistry {
    const reg = new InMemoryWorkstationRegistry(options);
    for (const entry of snapshot?.entries ?? []) {
      if (!entry || typeof entry !== "object" || typeof entry.serverProfileId !== "string") continue;
      reg.entries.set(posKey(entry.serverProfileId, entry.dimension, entry.position), { ...entry, lease: null });
    }
    return reg;
  }

  /** 合并快照：同 key 以 incoming 为准（服务端恢复用）。 */
  absorb(other: { serialize(): { entries: WorkstationEntry[] } }): number {
    let merged = 0;
    for (const entry of other.serialize().entries) {
      if (!entry || typeof entry !== "object" || typeof entry.serverProfileId !== "string") continue;
      const key = posKey(entry.serverProfileId, entry.dimension, entry.position);
      const existing = this.entries.get(key);
      if (existing?.lease && existing.lease.expiresAtMs > Date.now()) continue;
      this.entries.set(key, { ...entry, lease: null });
      merged += 1;
    }
    this.evictIfNeeded();
    return merged;
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt > this.entryTtlMs && (!entry.lease || entry.lease.expiresAtMs <= now)) this.entries.delete(key);
    }
    if (this.entries.size <= this.maxEntries) return;
    const sorted = [...this.entries.entries()].filter(([, entry]) => !entry.lease || entry.lease.expiresAtMs <= now)
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    const toRemove = this.entries.size - this.maxEntries;
    for (let i = 0; i < toRemove && i < sorted.length; i += 1) this.entries.delete(sorted[i]![0]);
  }
}

// ---------------------------------------------------------------------------
// acquireWorkstation — P0 fixes applied
// ---------------------------------------------------------------------------

export type WorkstationVerifyFn = (entry: WorkstationEntry) => Promise<boolean | "unknown">;
export type WorkstationScanFn = (type: WorkstationType) => Promise<ReadonlyArray<{ position: BlockPosition; type: WorkstationType }>>;

/**
 * P1-1 Facility FailureSignal：库级 hook 只上报信号，不写 Incident JSON——
 * 上报与否、严重度与聚合由宿主（bot-runtime 的 incident reporter）决定。
 * - FACILITY_VERIFY_FAILED：registry 记录的工作站经 server 侧 verifyFn 证伪
 *   （方块被换/被挖——状态分歧证据，expected/actual 齐全）。
 * - FACILITY_RESERVATION_CORRUPT：lease 已过期却 claim 失败（注册表内部
 *   状态损坏；正常 contention（active lease → busy）绝不上报）。
 */
export type FacilityFailureSignal = Readonly<{
  failureCode: "FACILITY_VERIFY_FAILED" | "FACILITY_RESERVATION_CORRUPT";
  facilityType: WorkstationType;
  serverProfileId: string;
  dimension: string;
  position: BlockPosition;
  expected: string;
  actual: string;
  observedAt: string;
}>;

export async function acquireWorkstation(
  registry: WorkstationRegistryPort,
  params: Readonly<{
    serverProfileId: string; dimension: string; type: WorkstationType;
    from: { x: number; y: number; z: number }; botId: string;
    maxDistance?: number; exclusive?: boolean;
    scanFn?: WorkstationScanFn; verifyFn?: WorkstationVerifyFn;
    onFailureSignal?: (signal: FacilityFailureSignal) => void;
    owner?: WorkstationLeaseOwner;
  }>,
): Promise<WorkstationAcquireResult> {
  const { serverProfileId, dimension, type, from, botId } = params;
  const emitSignal = (signal: Omit<FacilityFailureSignal, "observedAt">) => {
    if (!params.onFailureSignal) return;
    try {
      params.onFailureSignal({ ...signal, observedAt: new Date().toISOString() });
    } catch {
      // 诊断信号绝不能反向破坏获取主流程
    }
  };
  const candidates = registry.findCandidates(serverProfileId, dimension, type, from, params.maxDistance);
  const needsClaim = params.exclusive || usageModeFor(type) === "exclusive";

  for (const candidate of candidates) {
    const pos = normalizeBlockPos(candidate.position);
    if (params.verifyFn) {
      const stillExists = await params.verifyFn(candidate);
      if (stillExists === "unknown") return { status: "unreachable" };
      if (!stillExists) {
        emitSignal({
          failureCode: "FACILITY_VERIFY_FAILED",
          facilityType: type,
          serverProfileId,
          dimension,
          position: pos,
          expected: `workstation type=${type} present at registry position`,
          actual: "server-side verifyFn rejected the entry (block missing or changed)",
        });
        registry.invalidate(serverProfileId, dimension, pos);
        continue;
      }
    }
    if (params.verifyFn) registry.register(serverProfileId, dimension, type, pos, 1.0);

    if (needsClaim) {
      const before = registry.get(serverProfileId, dimension, pos);
      const leaseWasExpired = before?.lease ? before.lease.expiresAtMs <= Date.now() : true;
      const claimed = registry.claim(serverProfileId, dimension, pos, botId, undefined, params.owner);
      if (!claimed) {
        if (leaseWasExpired) {
          emitSignal({
            failureCode: "FACILITY_RESERVATION_CORRUPT",
            facilityType: type,
            serverProfileId,
            dimension,
            position: pos,
            expected: "expired lease is reclaimable by any bot",
            actual: `claim refused for botId=${botId} while lease expiry=${before?.lease?.expiresAtMs ?? "none"} was already past`,
          });
        }
        // P0-5: busy ≠ not_found — 返回 busy + 已有 entry，让 CapacityPlanner 决策
        const entry = registry.get(serverProfileId, dimension, pos);
        if (entry) return { status: "busy", entry, retryAfterMs: entry.lease ? entry.lease.expiresAtMs - Date.now() : 30_000 };
        continue;
      }
    }

    // P0-1: 用 get() 返回 authoritative entry，不是 findCandidates re-query
    const entry = registry.get(serverProfileId, dimension, pos);
    if (entry) return { status: "acquired", entry };
  }

  // Local scan fallback
  if (params.scanFn) {
    const found = await params.scanFn(type);
    for (const station of found) {
      const pos = normalizeBlockPos(station.position);
      if (params.verifyFn) {
        const ok = await params.verifyFn({ type: station.type, position: pos, dimension, serverProfileId, usageMode: usageModeFor(station.type), lastSeenAt: Date.now(), confidence: 1, lease: null } as WorkstationEntry);
        if (ok === "unknown") return { status: "unreachable" };
        if (!ok) continue;
      }
      registry.register(serverProfileId, dimension, station.type, pos);
      if (needsClaim) {
        const claimed = registry.claim(serverProfileId, dimension, pos, botId, undefined, params.owner);
        if (!claimed) {
          const entry = registry.get(serverProfileId, dimension, pos);
          if (entry) return { status: "busy", entry, retryAfterMs: Math.max(1, (entry.lease?.expiresAtMs ?? Date.now() + 1000) - Date.now()) };
          continue;
        }
      }
      // P0-1: 用 get() 返回 authoritative entry
      const entry = registry.get(serverProfileId, dimension, pos);
      if (entry) return { status: "acquired", entry };
    }
  }

  return { status: "not_found", mayCreate: true };
}
