import {
  worldMemoryDimensionSchema,
  worldMemoryKindSchema,
  worldMemoryPositionSchema,
  worldMemoryRecordSchema,
  worldMemoryServerProfileIdSchema,
  type WorldMemoryKind,
  type WorldMemoryPosition,
  type WorldMemoryRecord,
  type WorldMemoryRecordView,
} from "./schema.js";

export const DEFAULT_WORLD_MEMORY_QUERY_LIMIT = 100;
export const MAX_WORLD_MEMORY_QUERY_LIMIT = 500;

export type WorldMemoryListOptions = Readonly<{
  limit?: number;
}>;

export type WorldMemoryQueryOptions = Readonly<{
  kind?: WorldMemoryKind;
  limit?: number;
}>;

export function parseWorldMemoryQueryLimit(limit: number | undefined): number {
  const parsed = limit ?? DEFAULT_WORLD_MEMORY_QUERY_LIMIT;
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_WORLD_MEMORY_QUERY_LIMIT
  ) {
    throw new RangeError(
      `World memory query limit must be between 1 and ${MAX_WORLD_MEMORY_QUERY_LIMIT}.`,
    );
  }
  return parsed;
}

export type WorldMemorySwitchEvent = Readonly<{
  previousServerProfileId: string | null;
  /** `null` means the runtime disconnected and no profile is active. */
  nextServerProfileId: string | null;
}>;

export type WorldMemoryRepositoryOptions = Readonly<{
  /** Inject a monotonic source in tests; production uses Date.now(). */
  nowMs?: () => number;
  /**
   * 有界保留上限（默认 10_000）：超出后按插入序（即 sequence 序）淘汰
   * 最旧记录，与 scope 无关——所有服务器共享同一容量预算（与同仓
   * EventRingBuffer/ReconLedgerStore 的 bounded 纪律一致）。非正整数拒绝。
   */
  maxRecords?: number;
}>;

export type WorldMemorySwitchListener = (
  event: WorldMemorySwitchEvent,
) => void;

export class WorldMemoryAccessError extends Error {
  readonly code:
    | "WORLD_MEMORY_SERVER_NOT_SELECTED"
    | "WORLD_MEMORY_SERVER_SCOPE_MISMATCH";

  constructor(
    code:
      | "WORLD_MEMORY_SERVER_NOT_SELECTED"
      | "WORLD_MEMORY_SERVER_SCOPE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "WorldMemoryAccessError";
    this.code = code;
  }
}

/**
 * Repository contract intentionally has no unscoped read.  Every read starts
 * with a serverProfileId and the implementation also requires that profile to
 * be the currently connected profile.
 */
export interface WorldMemoryRepository {
  readonly activeServerProfileId: string | null;

  switchServer(nextServerProfileId: string): void;

  /** Clear the active connection scope; all subsequent access must fail closed. */
  disconnectServer(): void;

  onServerSwitch(listener: WorldMemorySwitchListener): () => void;

  put(record: WorldMemoryRecord): WorldMemoryRecord;

  findByKind(
    serverProfileId: string,
    kind: WorldMemoryKind,
    options?: WorldMemoryListOptions,
  ): readonly WorldMemoryRecordView[];

  findAtPosition(
    serverProfileId: string,
    dimension: string,
    position: WorldMemoryPosition,
    options?: WorldMemoryQueryOptions,
  ): readonly WorldMemoryRecordView[];

  findNearby(
    serverProfileId: string,
    dimension: string,
    center: WorldMemoryPosition,
    radius: number,
    options?: WorldMemoryQueryOptions,
  ): readonly WorldMemoryRecordView[];
}

type StoredRecord = Readonly<{
  sequence: number;
  record: WorldMemoryRecord;
}>;

const POSITION_EPSILON = 1e-6;
const DEFAULT_MAX_RECORDS = 10_000;

function cloneRecord(record: WorldMemoryRecord): WorldMemoryRecord {
  return {
    ...record,
    position: { ...record.position },
    payload: structuredClone(record.payload),
  };
}

function validateNow(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("World memory clock must return a nonnegative safe integer.");
  }
  return nowMs;
}

function timestampMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    // The schema normally catches this; keep the repository fail-closed if a
    // typed caller bypasses the schema at runtime.
    throw new TypeError("World memory observedAt is not a valid timestamp.");
  }
  return parsed;
}

function samePosition(left: WorldMemoryPosition, right: WorldMemoryPosition): boolean {
  return (
    Math.abs(left.x - right.x) <= POSITION_EPSILON &&
    Math.abs(left.y - right.y) <= POSITION_EPSILON &&
    Math.abs(left.z - right.z) <= POSITION_EPSILON
  );
}

function squaredDistance(left: WorldMemoryPosition, right: WorldMemoryPosition): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz;
}

export class InMemoryWorldMemoryRepository implements WorldMemoryRepository {
  /** 按插入序（sequence 严格递增，只追加不重排）保存；查询的 filter 保序
   *  输出天然按 sequence 升序，无需再排序。 */
  private readonly records: StoredRecord[] = [];
  private readonly listeners = new Set<WorldMemorySwitchListener>();
  private readonly nowMs: () => number;
  private readonly maxRecords: number;
  private lastNowMs: number | null = null;
  private nextSequence = 1;
  private currentServerProfile: string | null = null;

  constructor(options: WorldMemoryRepositoryOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    if (!Number.isInteger(this.maxRecords) || this.maxRecords < 1) {
      throw new RangeError(
        `World memory maxRecords must be a positive integer (got ${options.maxRecords}).`,
      );
    }
  }

  get activeServerProfileId(): string | null {
    return this.currentServerProfile;
  }

  switchServer(nextServerProfileId: string): void {
    const next = worldMemoryServerProfileIdSchema.parse(nextServerProfileId);
    this.readClock();
    if (next === this.currentServerProfile) return;

    const event: WorldMemorySwitchEvent = {
      previousServerProfileId: this.currentServerProfile,
      nextServerProfileId: next,
    };
    this.currentServerProfile = next;
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  disconnectServer(): void {
    this.readClock();
    if (this.currentServerProfile === null) return;

    const event: WorldMemorySwitchEvent = {
      previousServerProfileId: this.currentServerProfile,
      nextServerProfileId: null,
    };
    // Clear the scope before notifying listeners. If a listener fails, the
    // repository remains fail-closed instead of retaining a stale profile.
    this.currentServerProfile = null;
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  onServerSwitch(listener: WorldMemorySwitchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  put(input: WorldMemoryRecord): WorldMemoryRecord {
    const record = worldMemoryRecordSchema.parse(input);
    this.assertActiveScope(record.serverProfileId);
    this.readClock();

    // Observations may arrive late from a lagged or replayed source. The local
    // clock is monotonic, but observedAt is an external fact and is therefore
    // allowed to be older than an already stored observation.
    const stored = cloneRecord(record);
    this.records.push({ sequence: this.nextSequence++, record: stored });
    while (this.records.length > this.maxRecords) this.records.shift();
    return cloneRecord(stored);
  }

  findByKind(
    serverProfileId: string,
    kind: WorldMemoryKind,
    options: WorldMemoryListOptions = {},
  ): readonly WorldMemoryRecordView[] {
    const scope = this.assertQueryScope(serverProfileId);
    const parsedKind = worldMemoryKindSchema.parse(kind);
    const limit = parseWorldMemoryQueryLimit(options.limit);
    const nowMs = this.readClock();
    return this.records
      .filter(
        ({ record }) =>
          record.serverProfileId === scope && record.kind === parsedKind,
      )
      .slice(0, limit)
      .map(({ record }) => this.withFreshness(record, nowMs));
  }

  findAtPosition(
    serverProfileId: string,
    dimension: string,
    position: WorldMemoryPosition,
    options: WorldMemoryQueryOptions = {},
  ): readonly WorldMemoryRecordView[] {
    const scope = this.assertQueryScope(serverProfileId);
    const parsedDimension = worldMemoryDimensionSchema.parse(dimension);
    const parsedPosition = worldMemoryPositionSchema.parse(position);
    const parsedOptions = options.kind === undefined
      ? options
      : { kind: worldMemoryKindSchema.parse(options.kind) };
    const limit = parseWorldMemoryQueryLimit(options.limit);
    const nowMs = this.readClock();
    return this.records
      .filter(
        ({ record }) =>
          record.serverProfileId === scope &&
          record.dimension === parsedDimension &&
          samePosition(record.position, parsedPosition) &&
          (parsedOptions.kind === undefined || record.kind === parsedOptions.kind),
      )
      .slice(0, limit)
      .map(({ record }) => this.withFreshness(record, nowMs));
  }

  findNearby(
    serverProfileId: string,
    dimension: string,
    center: WorldMemoryPosition,
    radius: number,
    options: WorldMemoryQueryOptions = {},
  ): readonly WorldMemoryRecordView[] {
    const scope = this.assertQueryScope(serverProfileId);
    const parsedDimension = worldMemoryDimensionSchema.parse(dimension);
    const parsedCenter = worldMemoryPositionSchema.parse(center);
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError("World memory search radius must be nonnegative.");
    }
    const parsedOptions = options.kind === undefined
      ? options
      : { kind: worldMemoryKindSchema.parse(options.kind) };
    const limit = parseWorldMemoryQueryLimit(options.limit);
    const radiusSquared = radius * radius;
    if (!Number.isFinite(radiusSquared)) {
      throw new RangeError("World memory search radius is too large.");
    }
    const nowMs = this.readClock();
    return this.records
      .filter(
        ({ record }) =>
          record.serverProfileId === scope &&
          record.dimension === parsedDimension &&
          squaredDistance(record.position, parsedCenter) <= radiusSquared &&
          (parsedOptions.kind === undefined || record.kind === parsedOptions.kind),
      )
      .slice(0, limit)
      .map(({ record }) => this.withFreshness(record, nowMs));
  }

  private withFreshness(record: WorldMemoryRecord, nowMs: number): WorldMemoryRecordView {
    const ageMs = nowMs - timestampMs(record.observedAt);
    const freshness =
      ageMs >= 0 && ageMs <= record.staleAfterMs ? "fresh" : "stale";
    return { ...cloneRecord(record), freshness, ageMs };
  }

  private readClock(): number {
    const nowMs = validateNow(this.nowMs());
    if (this.lastNowMs !== null && nowMs < this.lastNowMs) {
      throw new RangeError("World memory clock moved backwards.");
    }
    this.lastNowMs = nowMs;
    return nowMs;
  }

  private assertActiveScope(serverProfileId: string): string {
    const parsed = worldMemoryServerProfileIdSchema.parse(serverProfileId);
    if (this.currentServerProfile === null) {
      throw new WorldMemoryAccessError(
        "WORLD_MEMORY_SERVER_NOT_SELECTED",
        "World memory access requires an active server profile.",
      );
    }
    if (this.currentServerProfile !== parsed) {
      throw new WorldMemoryAccessError(
        "WORLD_MEMORY_SERVER_SCOPE_MISMATCH",
        "World memory access is limited to the active server profile.",
      );
    }
    return parsed;
  }

  private assertQueryScope(serverProfileId: string): string {
    return this.assertActiveScope(serverProfileId);
  }
}
