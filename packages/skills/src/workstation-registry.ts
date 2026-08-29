// ---------------------------------------------------------------------------
// WorkstationRegistry v1 —— 工作站发现 / 注册 / 复用 / lease / claim。
//
// 设计决策：
//   - Port 接口：Skill / planner 依赖接口，不依赖 Map 实现
//   - lease 结构：lease: { owner, expiresAtMs } | null（消除非法组合）
//   - usage mode：shared (crafting_table) vs exclusive (furnace)
//   - block position 归一化：Math.floor 后入 key，禁止浮点坐标
//   - candidate list：按 distance+confidence+freshness 排序，支持 fallback
//   - confidence：直接观测=1.0，propagation=0.9，TTL 内随时间衰减
//   - eviction：先删 stale，再按 lastSeenAt 淘汰最旧直到 maxEntries
//   - 维度切换不清空：TTL + verify 负责 stale state
//   - acquireWorkstation：query→verify→claim→fallback→NEED_CREATE
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  readonly ownerBotId: string;
  readonly expiresAtMs: number;
}

export interface WorkstationEntry {
  readonly type: WorkstationType;
  readonly position: BlockPosition;
  readonly dimension: string;
  readonly serverProfileId: string;
  readonly usageMode: WorkstationUsageMode;
  lastSeenAt: number;
  confidence: number;
  lease: WorkstationLease | null;
}

export type WorkstationAcquireResult =
  | Readonly<{ status: "acquired"; entry: WorkstationEntry }>
  | Readonly<{ status: "busy"; retryAfterMs: number }>
  | Readonly<{ status: "not_found"; mayCreate: true }>
  | Readonly<{ status: "unreachable" }>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeBlockPos(p: { x: number; y: number; z: number }): BlockPosition {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function posKey(serverProfileId: string, dimension: string, p: BlockPosition): string {
  return `${serverProfileId}|${dimension}|${p.x}|${p.y}|${p.z}`;
}

/** Usage mode by workstation type. Furnace-family = stateful/exclusive. */
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

/** Confidence decays linearly over TTL. Fresh direct observation = 1.0. */
function decayedConfidence(entry: WorkstationEntry, ttlMs: number, now: number): number {
  const age = now - entry.lastSeenAt;
  if (age >= ttlMs) return 0;
  return entry.confidence * (1 - age / ttlMs);
}

// ---------------------------------------------------------------------------
// Port interface — Skills / planner depend on this, not Map
// ---------------------------------------------------------------------------

export interface WorkstationRegistryPort {
  register(
    serverProfileId: string,
    dimension: string,
    type: WorkstationType,
    position: { x: number; y: number; z: number },
    confidence?: number,
  ): WorkstationEntry;
  findCandidates(
    serverProfileId: string,
    dimension: string,
    type: WorkstationType,
    from: { x: number; y: number; z: number },
    maxDistance?: number,
  ): readonly WorkstationEntry[];
  claim(
    serverProfileId: string,
    dimension: string,
    position: BlockPosition,
    botId: string,
    ttlMs?: number,
  ): boolean;
  renewClaim(
    serverProfileId: string,
    dimension: string,
    position: BlockPosition,
    botId: string,
    ttlMs?: number,
  ): boolean;
  release(
    serverProfileId: string,
    dimension: string,
    position: BlockPosition,
    botId: string,
  ): void;
  invalidate(
    serverProfileId: string,
    dimension: string,
    position: BlockPosition,
  ): void;
  releaseAllClaims(botId: string): void;
  clearServer(serverProfileId: string): void;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export interface WorkstationRegistryOptions {
  readonly entryTtlMs?: number;
  readonly leaseTtlMs?: number;
  readonly maxEntries?: number;
}

export class InMemoryWorkstationRegistry implements WorkstationRegistryPort {
  private readonly entries = new Map<string, WorkstationEntry>();
  private readonly entryTtlMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxEntries: number;

  constructor(options: WorkstationRegistryOptions = {}) {
    this.entryTtlMs = options.entryTtlMs ?? 5 * 60_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.maxEntries = options.maxEntries ?? 512;
  }

  register(
    serverProfileId: string,
    dimension: string,
    type: WorkstationType,
    position: { x: number; y: number; z: number },
    confidence = 1.0,
  ): WorkstationEntry {
    const pos = normalizeBlockPos(position);
    const key = posKey(serverProfileId, dimension, pos);
    const now = Date.now();
    const existing = this.entries.get(key);

    // 同坐标 type 改变 → replace old observation (语义明确：一个 block 只有一个 type)
    this.entries.set(key, {
      type,
      position: pos,
      dimension,
      serverProfileId,
      usageMode: usageModeFor(type),
      lastSeenAt: now,
      confidence,
      // Preserve existing lease only if same type (type change = invalidates lease)
      lease: existing && existing.type === type ? existing.lease : null,
    });

    this.evictIfNeeded();
    return this.entries.get(key)!;
  }

  findCandidates(
    serverProfileId: string,
    dimension: string,
    type: WorkstationType,
    from: { x: number; y: number; z: number },
    maxDistance?: number,
  ): readonly WorkstationEntry[] {
    const now = Date.now();
    const results: Array<{ entry: WorkstationEntry; sortKey: number }> = [];

    for (const entry of this.entries.values()) {
      if (entry.serverProfileId !== serverProfileId) continue;
      if (entry.dimension !== dimension) continue;
      if (entry.type !== type) continue;

      const conf = decayedConfidence(entry, this.entryTtlMs, now);
      if (conf <= 0) continue; // expired

      const dist = Math.hypot(
        entry.position.x - from.x,
        entry.position.y - from.y,
        entry.position.z - from.z,
      );
      if (maxDistance !== undefined && dist > maxDistance) continue;

      // Available if unleased or lease expired
      const available = entry.lease === null || now >= entry.lease.expiresAtMs;

      // Sort by distance (primary), confidence (secondary), freshness (tertiary)
      const sortKey = dist - conf * 10 + (available ? 0 : 1000);
      results.push({ entry, sortKey });
    }

    return results
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((r) => r.entry);
  }

  claim(
    serverProfileId: string,
    dimension: string,
    position: BlockPosition,
    botId: string,
    ttlMs?: number,
  ): boolean {
    const key = posKey(serverProfileId, dimension, normalizeBlockPos(position));
    const entry = this.entries.get(key);
    if (!entry) return false;
    const now = Date.now();
    if (entry.lease !== null && entry.lease.ownerBotId !== botId && now < entry.lease.expiresAtMs) {
      return false; // actively claimed by another bot
    }
    entry.lease = { ownerBotId: botId, expiresAtMs: now + (ttlMs ?? this.leaseTtlMs) };
    entry.lastSeenAt = now; // claiming implies we saw it
    return true;
  }

  renewClaim(
    serverProfileId: string,
    dimension: string,
    position: BlockPosition,
    botId: string,
    ttlMs?: number,
  ): boolean {
    const key = posKey(serverProfileId, dimension, normalizeBlockPos(position));
    const entry = this.entries.get(key);
    if (!entry || entry.lease === null || entry.lease.ownerBotId !== botId) return false;
    entry.lease = { ownerBotId: botId, expiresAtMs: Date.now() + (ttlMs ?? this.leaseTtlMs) };
    return true;
  }

  release(
    serverProfileId: string,
    dimension: string,
    position: BlockPosition,
    botId: string,
  ): void {
    const key = posKey(serverProfileId, dimension, normalizeBlockPos(position));
    const entry = this.entries.get(key);
    if (entry && entry.lease !== null && entry.lease.ownerBotId === botId) {
      entry.lease = null;
    }
  }

  invalidate(
    serverProfileId: string,
    dimension: string,
    position: BlockPosition,
  ): void {
    this.entries.delete(posKey(serverProfileId, dimension, normalizeBlockPos(position)));
  }

  releaseAllClaims(botId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.lease !== null && entry.lease.ownerBotId === botId) {
        entry.lease = null;
      }
    }
  }

  clearServer(serverProfileId: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${serverProfileId}|`)) {
        this.entries.delete(key);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return;
    const now = Date.now();

    // Phase 1: remove truly stale entries (beyond TTL)
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt > this.entryTtlMs) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size <= this.maxEntries) return;

    // Phase 2: sort by lastSeenAt ascending, evict oldest until under limit
    const sorted = [...this.entries.entries()]
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    const toRemove = this.entries.size - this.maxEntries;
    for (let i = 0; i < toRemove && i < sorted.length; i += 1) {
      this.entries.delete(sorted[i]![0]);
    }
  }
}

// ---------------------------------------------------------------------------
// acquireWorkstation orchestration
// ---------------------------------------------------------------------------

export type WorkstationVerifyFn = (
  entry: WorkstationEntry,
) => Promise<boolean>;

export type WorkstationScanFn = (
  type: WorkstationType,
) => Promise<ReadonlyArray<{ position: BlockPosition; type: WorkstationType }>>;

/**
 * 统一的工作站获取流程。
 *
 * 1. query candidates from registry
 * 2. verify each candidate against server state (caller-provided fn)
 * 3. attempt claim if usage mode is exclusive
 * 4. fallback to next candidate
 * 5. if none valid → caller scans locally → register → re-check
 * 6. only if still none → return not_found/mayCreate
 *
 * @param verifyFn - async block-at-position check (runtime injects this)
 * @param scanFn - optional local world scan (runtime injects)
 */
export async function acquireWorkstation(
  registry: WorkstationRegistryPort,
  params: Readonly<{
    serverProfileId: string;
    dimension: string;
    type: WorkstationType;
    from: { x: number; y: number; z: number };
    botId: string;
    maxDistance?: number;
    exclusive?: boolean;
    scanFn?: WorkstationScanFn;
    verifyFn?: WorkstationVerifyFn;
  }>,
): Promise<WorkstationAcquireResult> {
  const { serverProfileId, dimension, type, from, botId } = params;

  // Step 1: query candidates
  const candidates = registry.findCandidates(
    serverProfileId, dimension, type, from, params.maxDistance,
  );

  // Step 2-4: verify + claim each candidate, fallback to next
  for (const candidate of candidates) {
    const pos = normalizeBlockPos(candidate.position);

    // Server-state verify if caller provides the function
    if (params.verifyFn) {
      const stillExists = await params.verifyFn(candidate);
      if (!stillExists) {
        registry.invalidate(serverProfileId, dimension, pos);
        continue; // try next candidate
      }
    }

    // Refresh confidence (server confirmed it exists)
    registry.register(serverProfileId, dimension, type, pos, 1.0);

    // Claim if exclusive
    if (params.exclusive || usageModeFor(type) === "exclusive") {
      const claimed = registry.claim(serverProfileId, dimension, pos, botId);
      if (!claimed) {
        continue; // another bot has it, try next candidate
      }
    }

    return { status: "acquired", entry: registry.findCandidates(
      serverProfileId, dimension, type, from, 1,
    )[0] ?? { type, position: pos, dimension, serverProfileId, usageMode: usageModeFor(type), lastSeenAt: Date.now(), confidence: 1, lease: null } };
  }

  // Step 5: no registry candidate worked → local scan if available
  if (params.scanFn) {
    const found = await params.scanFn(type);
    for (const station of found) {
      const pos = normalizeBlockPos(station.position);
      // Verify local scan result against server
      if (params.verifyFn) {
        const ok = await params.verifyFn({
          type: station.type,
          position: pos,
          dimension,
          serverProfileId,
          usageMode: usageModeFor(station.type),
          lastSeenAt: Date.now(),
          confidence: 1,
          lease: null,
        });
        if (!ok) continue;
      }
      registry.register(serverProfileId, dimension, station.type, pos);
      // Claim if exclusive
      if (params.exclusive || usageModeFor(station.type) === "exclusive") {
        registry.claim(serverProfileId, dimension, pos, botId);
      }
      return { status: "acquired", entry: {
        type: station.type,
        position: pos,
        dimension,
        serverProfileId,
        usageMode: usageModeFor(station.type),
        lastSeenAt: Date.now(),
        confidence: 1,
        lease: null,
      } };
    }
  }

  // Step 6: nothing found → caller may create
  return { status: "not_found", mayCreate: true };
}
