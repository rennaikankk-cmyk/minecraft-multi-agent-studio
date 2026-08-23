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
import {
  WorldMemoryAccessError,
  parseWorldMemoryQueryLimit,
  type WorldMemoryListOptions,
  type WorldMemoryQueryOptions,
  type WorldMemoryRepositoryOptions,
  type WorldMemorySwitchEvent,
  type WorldMemorySwitchListener,
} from "./repository.js";

/** A deliberately small adapter boundary; no SQL text or driver leaks out. */
export type WorldMemorySqlRow = Record<string, unknown>;

export type WorldMemorySqlQueryResult<TRow extends WorldMemorySqlRow = WorldMemorySqlRow> = Readonly<{
  rows: readonly TRow[];
  rowCount: number | null;
}>;

export interface WorldMemorySqlClient {
  query<TRow extends WorldMemorySqlRow = WorldMemorySqlRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<WorldMemorySqlQueryResult<TRow>>;
  release(): void;
}

export interface WorldMemorySqlPool {
  connect(): Promise<WorldMemorySqlClient>;
}

export type WorldMemoryPersistenceErrorCode =
  | "WORLD_MEMORY_PERSISTENCE_FAILED"
  | "WORLD_MEMORY_ROW_INVALID";

export class WorldMemoryPersistenceError extends Error {
  constructor(
    readonly code: WorldMemoryPersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorldMemoryPersistenceError";
  }
}

type WorldMemoryRow = Readonly<{
  memory_id?: unknown;
  server_profile_id: unknown;
  dimension: unknown;
  x: unknown;
  y: unknown;
  z: unknown;
  kind: unknown;
  observed_at: unknown;
  confidence: unknown;
  stale_after_ms: unknown;
  payload: unknown;
}>;

const POSITION_EPSILON = 1e-6;
const INSERT_SQL = `
INSERT INTO studio_world_memory (
  server_profile_id, dimension, x, y, z, kind,
  observed_at, confidence, stale_after_ms, payload
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
RETURNING memory_id, server_profile_id, dimension, x, y, z, kind,
          observed_at, confidence, stale_after_ms, payload
`;

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
    throw new TypeError("World memory observedAt is not a valid timestamp.");
  }
  return parsed;
}

function numberFromRow(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new WorldMemoryPersistenceError(
      "WORLD_MEMORY_ROW_INVALID",
      `World memory row field ${field} is not finite.`,
    );
  }
  return parsed;
}

function timestampFromRow(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new WorldMemoryPersistenceError(
        "WORLD_MEMORY_ROW_INVALID",
        "World memory row observed_at is invalid.",
      );
    }
    return value.toISOString();
  }
  if (typeof value !== "string") {
    throw new WorldMemoryPersistenceError(
      "WORLD_MEMORY_ROW_INVALID",
      "World memory row observed_at is not a timestamp.",
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new WorldMemoryPersistenceError(
      "WORLD_MEMORY_ROW_INVALID",
      "World memory row observed_at is invalid.",
    );
  }
  return new Date(parsed).toISOString();
}

function rowToRecord(row: WorldMemoryRow): WorldMemoryRecord {
  try {
    return worldMemoryRecordSchema.parse({
      serverProfileId: worldMemoryServerProfileIdSchema.parse(row.server_profile_id),
      dimension: worldMemoryDimensionSchema.parse(row.dimension),
      position: {
        x: numberFromRow(row.x, "x"),
        y: numberFromRow(row.y, "y"),
        z: numberFromRow(row.z, "z"),
      },
      kind: worldMemoryKindSchema.parse(row.kind),
      observedAt: timestampFromRow(row.observed_at),
      confidence: numberFromRow(row.confidence, "confidence"),
      staleAfterMs: (() => {
        const value = numberFromRow(row.stale_after_ms, "stale_after_ms");
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new WorldMemoryPersistenceError(
            "WORLD_MEMORY_ROW_INVALID",
            "World memory row stale_after_ms is outside the safe range.",
          );
        }
        return value;
      })(),
      payload: row.payload,
    });
  } catch (error) {
    if (error instanceof WorldMemoryPersistenceError) throw error;
    throw new WorldMemoryPersistenceError(
      "WORLD_MEMORY_ROW_INVALID",
      "PostgreSQL returned an invalid world memory record.",
      { cause: error },
    );
  }
}


/**
 * Durable world memory backed by PostgreSQL. Methods are asynchronous because
 * every read/write crosses the database boundary. Scope changes remain local
 * and synchronous so a disconnect can fail-closed immediately.
 */
export class PostgresWorldMemoryRepository {
  private readonly listeners = new Set<WorldMemorySwitchListener>();
  private readonly nowMs: () => number;
  private lastNowMs: number | null = null;
  private currentServerProfile: string | null = null;

  constructor(
    private readonly pool: WorldMemorySqlPool,
    options: WorldMemoryRepositoryOptions = {},
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
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
    for (const listener of this.listeners) listener(event);
  }

  disconnectServer(): void {
    this.readClock();
    if (this.currentServerProfile === null) return;
    const event: WorldMemorySwitchEvent = {
      previousServerProfileId: this.currentServerProfile,
      nextServerProfileId: null,
    };
    this.currentServerProfile = null;
    for (const listener of this.listeners) listener(event);
  }

  onServerSwitch(listener: WorldMemorySwitchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async put(input: WorldMemoryRecord): Promise<WorldMemoryRecord> {
    const record = worldMemoryRecordSchema.parse(input);
    const scope = this.assertActiveScope(record.serverProfileId);
    this.readClock();
    const row = await this.withClient(async (client) => {
      const result = await client.query<WorldMemoryRow>(INSERT_SQL, [
        record.serverProfileId,
        record.dimension,
        record.position.x,
        record.position.y,
        record.position.z,
        record.kind,
        record.observedAt,
        record.confidence,
        record.staleAfterMs,
        JSON.stringify(record.payload),
      ]);
      if (result.rows.length !== 1 || !result.rows[0]) {
        throw new WorldMemoryPersistenceError(
          "WORLD_MEMORY_PERSISTENCE_FAILED",
          "PostgreSQL did not return the inserted world memory record.",
        );
      }
      return result.rows[0];
    });
    this.assertStillActive(scope);
    const stored = rowToRecord(row);
    if (stored.serverProfileId !== scope) {
      throw new WorldMemoryPersistenceError(
        "WORLD_MEMORY_ROW_INVALID",
        "PostgreSQL returned a record outside the active server scope.",
      );
    }
    return cloneRecord(stored);
  }

  async findByKind(
    serverProfileId: string,
    kind: WorldMemoryKind,
    options: WorldMemoryListOptions = {},
  ): Promise<readonly WorldMemoryRecordView[]> {
    const scope = this.assertQueryScope(serverProfileId);
    const parsedKind = worldMemoryKindSchema.parse(kind);
    const limit = parseWorldMemoryQueryLimit(options.limit);
    const nowMs = this.readClock();
    const rows = await this.queryRows(
      `SELECT memory_id, server_profile_id, dimension, x, y, z, kind,
              observed_at, confidence, stale_after_ms, payload
       FROM studio_world_memory
       WHERE server_profile_id = $1 AND kind = $2
       ORDER BY memory_id ASC
       LIMIT $3::integer`,
      [scope, parsedKind, limit],
      scope,
    );
    return rowsToViews(rows, scope, nowMs);
  }

  async findAtPosition(
    serverProfileId: string,
    dimension: string,
    position: WorldMemoryPosition,
    options: WorldMemoryQueryOptions = {},
  ): Promise<readonly WorldMemoryRecordView[]> {
    const scope = this.assertQueryScope(serverProfileId);
    const parsedDimension = worldMemoryDimensionSchema.parse(dimension);
    const parsedPosition = worldMemoryPositionSchema.parse(position);
    const parsedKind = options.kind === undefined
      ? null
      : worldMemoryKindSchema.parse(options.kind);
    const limit = parseWorldMemoryQueryLimit(options.limit);
    const nowMs = this.readClock();
    const rows = await this.queryRows(
      `SELECT memory_id, server_profile_id, dimension, x, y, z, kind,
              observed_at, confidence, stale_after_ms, payload
       FROM studio_world_memory
       WHERE server_profile_id = $1
         AND dimension = $2
         AND ABS(x - $3::double precision) <= ${POSITION_EPSILON}
         AND ABS(y - $4::double precision) <= ${POSITION_EPSILON}
         AND ABS(z - $5::double precision) <= ${POSITION_EPSILON}
         AND ($6::text IS NULL OR kind = $6)
       ORDER BY memory_id ASC
       LIMIT $7::integer`,
      [
        scope,
        parsedDimension,
        parsedPosition.x,
        parsedPosition.y,
        parsedPosition.z,
        parsedKind,
        limit,
      ],
      scope,
    );
    return rowsToViews(rows, scope, nowMs);
  }

  async findNearby(
    serverProfileId: string,
    dimension: string,
    center: WorldMemoryPosition,
    radius: number,
    options: WorldMemoryQueryOptions = {},
  ): Promise<readonly WorldMemoryRecordView[]> {
    const scope = this.assertQueryScope(serverProfileId);
    const parsedDimension = worldMemoryDimensionSchema.parse(dimension);
    const parsedCenter = worldMemoryPositionSchema.parse(center);
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError("World memory search radius must be nonnegative.");
    }
    const radiusSquared = radius * radius;
    if (!Number.isFinite(radiusSquared)) {
      throw new RangeError("World memory search radius is too large.");
    }
    const parsedKind = options.kind === undefined
      ? null
      : worldMemoryKindSchema.parse(options.kind);
    const limit = parseWorldMemoryQueryLimit(options.limit);
    const nowMs = this.readClock();
    const rows = await this.queryRows(
      `SELECT memory_id, server_profile_id, dimension, x, y, z, kind,
              observed_at, confidence, stale_after_ms, payload
       FROM studio_world_memory
       WHERE server_profile_id = $1
         AND dimension = $2
         AND ((x - $3::double precision) * (x - $3::double precision)
           + (y - $4::double precision) * (y - $4::double precision)
           + (z - $5::double precision) * (z - $5::double precision)) <= $6::double precision
         AND ($7::text IS NULL OR kind = $7)
       ORDER BY memory_id ASC
       LIMIT $8::integer`,
      [
        scope,
        parsedDimension,
        parsedCenter.x,
        parsedCenter.y,
        parsedCenter.z,
        radiusSquared,
        parsedKind,
        limit,
      ],
      scope,
    );
    return rowsToViews(rows, scope, nowMs);
  }

  private async queryRows(
    text: string,
    values: readonly unknown[],
    scope: string,
  ): Promise<readonly WorldMemoryRow[]> {
    const rows = await this.withClient(async (client) => {
      const result = await client.query<WorldMemoryRow>(text, values);
      return result.rows;
    });
    this.assertStillActive(scope);
    return rows;
  }

  private async withClient<T>(operation: (client: WorldMemorySqlClient) => Promise<T>): Promise<T> {
    let client: WorldMemorySqlClient | undefined;
    try {
      client = await this.pool.connect();
      return await operation(client);
    } catch (error) {
      if (error instanceof WorldMemoryPersistenceError) throw error;
      throw new WorldMemoryPersistenceError(
        "WORLD_MEMORY_PERSISTENCE_FAILED",
        "PostgreSQL world memory operation failed.",
        { cause: error },
      );
    } finally {
      client?.release();
    }
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

  private assertStillActive(scope: string): void {
    if (this.currentServerProfile !== scope) {
      if (this.currentServerProfile === null) {
        throw new WorldMemoryAccessError(
          "WORLD_MEMORY_SERVER_NOT_SELECTED",
          "World memory access requires an active server profile.",
        );
      }
      throw new WorldMemoryAccessError(
        "WORLD_MEMORY_SERVER_SCOPE_MISMATCH",
        "World memory access is limited to the active server profile.",
      );
    }
  }
}

function withFreshness(
  record: WorldMemoryRecord,
  nowMs: number,
): WorldMemoryRecordView {
  const ageMs = nowMs - timestampMs(record.observedAt);
  const freshness =
    ageMs >= 0 && ageMs <= record.staleAfterMs ? "fresh" : "stale";
  return { ...cloneRecord(record), freshness, ageMs };
}
function rowsToViews(
  rows: readonly WorldMemoryRow[],
  scope: string,
  nowMs: number,
): readonly WorldMemoryRecordView[] {
  return rows.map((row) => {
    const record = rowToRecord(row);
    if (record.serverProfileId !== scope) {
      throw new WorldMemoryPersistenceError(
        "WORLD_MEMORY_ROW_INVALID",
        "PostgreSQL returned a record outside the active server scope.",
      );
    }
    return withFreshness(record, nowMs);
  });
}
