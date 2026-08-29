// ---------------------------------------------------------------------------
// WorkstationRegistry —— 工作站发现 / 注册 / 复用 / claim。
//
// 解决核心问题：bot 周围已有工作台却继续制作新工作台。
//
// 设计：
//   - Registry 按 serverProfileId + dimension 隔离
//   - 每个 entry 有 lastSeenAt / confidence / lease（可选）
//   - acquireWorkstation 依次查 registry → local scan → 才允许 craft
//   - 放置/发现后必须 register
//   - 被破坏后必须 invalidate
// ---------------------------------------------------------------------------

export interface WorkstationEntry {
  readonly type: string;
  readonly position: { x: number; y: number; z: number };
  readonly dimension: string;
  readonly serverProfileId: string;
  lastSeenAt: number;
  confidence: number;
  claimedBy: string | null;
  claimedUntilMs: number | null;
}

export interface WorkstationRegistryOptions {
  /** Entry 过期时间（ms）。超时后不可信任，需要重新验证。默认 5 分钟。 */
  readonly entryTtlMs?: number;
  /** Lease 默认持续时间（ms）。默认 30 秒。 */
  readonly leaseTtlMs?: number;
  /** 最大 entries 数量（防无界增长）。默认 512。 */
  readonly maxEntries?: number;
}

export class WorkstationRegistry {
  private readonly entries = new Map<string, WorkstationEntry>();
  private readonly entryTtlMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxEntries: number;

  constructor(options: WorkstationRegistryOptions = {}) {
    this.entryTtlMs = options.entryTtlMs ?? 5 * 60_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.maxEntries = options.maxEntries ?? 512;
  }

  private key(
    serverProfileId: string,
    dimension: string,
    x: number,
    y: number,
    z: number,
  ): string {
    return `${serverProfileId}|${dimension}|${x}|${y}|${z}`;
  }

  /** 注册或更新一个工作站观测。 */
  register(
    serverProfileId: string,
    dimension: string,
    type: string,
    position: { x: number; y: number; z: number },
    confidence = 1,
  ): WorkstationEntry {
    const key = this.key(serverProfileId, dimension, position.x, position.y, position.z);
    const existing = this.entries.get(key);
    const entry: WorkstationEntry = {
      type,
      position: { ...position },
      dimension,
      serverProfileId,
      lastSeenAt: Date.now(),
      confidence,
      claimedBy: existing?.claimedBy ?? null,
      claimedUntilMs: existing?.claimedUntilMs ?? null,
    };
    this.entries.set(key, entry);
    this.evictStale();
    return entry;
  }

  /**
   * 查询最近的可用工作站（同 server + dimension + type，未过期，未被 claim）。
   */
  findNearest(
    serverProfileId: string,
    dimension: string,
    type: string,
    fromPosition: { x: number; y: number; z: number },
    maxDistance?: number,
  ): WorkstationEntry | null {
    const now = Date.now();
    let best: WorkstationEntry | null = null;
    let bestDist = maxDistance !== undefined ? maxDistance : Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (entry.serverProfileId !== serverProfileId) continue;
      if (entry.dimension !== dimension) continue;
      if (entry.type !== type) continue;
      if (now - entry.lastSeenAt > this.entryTtlMs) continue;
      if (entry.claimedBy !== null && (entry.claimedUntilMs === null || now < entry.claimedUntilMs)) continue;
      const dist = Math.hypot(
        entry.position.x - fromPosition.x,
        entry.position.y - fromPosition.y,
        entry.position.z - fromPosition.z,
      );
      if (dist < bestDist) {
        best = entry;
        bestDist = dist;
      }
    }
    return best;
  }

  /** Claim 一个工作站（独占使用，带 TTL）。 */
  claim(
    serverProfileId: string,
    dimension: string,
    position: { x: number; y: number; z: number },
    botId: string,
    ttlMs?: number,
  ): boolean {
    const key = this.key(serverProfileId, dimension, position.x, position.y, position.z);
    const entry = this.entries.get(key);
    if (!entry) return false;
    const now = Date.now();
    if (entry.claimedBy !== null && entry.claimedBy !== botId) {
      if (entry.claimedUntilMs !== null && now < entry.claimedUntilMs) return false;
    }
    entry.claimedBy = botId;
    entry.claimedUntilMs = now + (ttlMs ?? this.leaseTtlMs);
    return true;
  }

  /** 释放 claim。 */
  release(
    serverProfileId: string,
    dimension: string,
    position: { x: number; y: number; z: number },
    botId: string,
  ): void {
    const key = this.key(serverProfileId, dimension, position.x, position.y, position.z);
    const entry = this.entries.get(key);
    if (entry && entry.claimedBy === botId) {
      entry.claimedBy = null;
      entry.claimedUntilMs = null;
    }
  }

  /** 标记工作站已被破坏 / 不再存在。 */
  invalidate(
    serverProfileId: string,
    dimension: string,
    position: { x: number; y: number; z: number },
  ): void {
    this.entries.delete(
      this.key(serverProfileId, dimension, position.x, position.y, position.z),
    );
  }

  /** 清除指定 server + dimension 的全部 entries（维度切换/重连时调用）。 */
  clearScope(serverProfileId: string, dimension: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${serverProfileId}|${dimension}|`)) {
        this.entries.delete(key);
      }
    }
  }

  /** 释放指定 bot 的全部 claims（断线/死亡时调用）。 */
  releaseAllClaims(botId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.claimedBy === botId) {
        entry.claimedBy = null;
        entry.claimedUntilMs = null;
      }
    }
  }

  /** 清理过期 entries，防止无界增长。 */
  private evictStale(): void {
    if (this.entries.size <= this.maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt > this.entryTtlMs * 2) {
        this.entries.delete(key);
      }
    }
  }

  /** 当前 entries 数量（测试/诊断用）。 */
  get size(): number {
    return this.entries.size;
  }
}
