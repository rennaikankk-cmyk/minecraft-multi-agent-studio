import { createHash } from "node:crypto";

import type {
  PostgresClientLike,
  PostgresPoolLike,
} from "@minecraft-studio/task-system";

import { WorldMemoryError } from "./errors.js";
import {
  worldMemoryQuerySchema,
  worldMemoryRecordSchema,
  worldMemoryWriteCommandSchema,
  type WorldMemoryQuery,
  type WorldMemoryRecord,
  type WorldMemorySearchResult,
  type WorldMemoryWriteCommand,
} from "./model.js";

type SqlRow = Record<string, unknown>;

const WORLD_MEMORY_COLUMNS = `
  m.schema_version,
  m.operation_id,
  m.operation_fingerprint,
  m.memory_id,
  m.server_profile_id,
  m.dimension,
  m.position_x,
  m.position_y,
  m.position_z,
  m.kind,
  m.summary,
  m.tags,
  m.confidence,
  m.visibility,
  m.allowed_subject_ids,
  m.model_access,
  m.source_bot_id,
  m.source_task_id,
  m.trace_id,
  m.observed_at,
  m.expires_at,
  m.supersedes_memory_id,
  m.embedding_model,
  CASE WHEN m.embedding IS NULL THEN NULL ELSE vector_dims(m.embedding) END
    AS embedding_dimensions,
  m.created_at`;

const TRANSACTION_LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '3000ms'";
const TRANSACTION_STATEMENT_TIMEOUT_SQL =
  "SET LOCAL statement_timeout = '10000ms'";

export type RecordWorldMemoryResult = Readonly<{
  memory: WorldMemoryRecord;
  created: boolean;
}>;

export interface WorldMemoryRepositoryLike {
  search(query: WorldMemoryQuery): Promise<readonly WorldMemorySearchResult[]>;
}

export interface WorldMemoryWriterLike {
  record(input: WorldMemoryWriteCommand): Promise<RecordWorldMemoryResult>;
}

type NormalizedWriteCommand = WorldMemoryWriteCommand;

function normalizeWriteCommand(
  input: WorldMemoryWriteCommand,
): NormalizedWriteCommand {
  const command = worldMemoryWriteCommandSchema.parse(input);
  return {
    ...command,
    tags: [...command.tags].sort(),
    allowedSubjectIds: [...command.allowedSubjectIds].sort(),
    embedding:
      command.embedding === null
        ? null
        : {
            model: command.embedding.model,
            values: [...command.embedding.values],
          },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function worldMemoryOperationFingerprint(
  input: WorldMemoryWriteCommand,
): string {
  const command = normalizeWriteCommand(input);
  const { operationId: _operationId, ...semanticCommand } = command;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(semanticCommand)), "utf8")
    .digest("hex");
}

function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new WorldMemoryError(
    "WORLD_MEMORY_LOOKUP_FAILED",
    "PostgreSQL returned an invalid world-memory timestamp.",
  );
}

function finiteNumber(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new WorldMemoryError(
      "WORLD_MEMORY_LOOKUP_FAILED",
      `PostgreSQL returned invalid numeric world-memory field ${field}.`,
    );
  }
  return parsed;
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  return value === null || value === undefined
    ? null
    : finiteNumber(value, field);
}

function integer(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  const parsed = finiteNumber(value, field);
  if (!Number.isSafeInteger(parsed)) {
    throw new WorldMemoryError(
      "WORLD_MEMORY_LOOKUP_FAILED",
      `PostgreSQL returned invalid integer world-memory field ${field}.`,
    );
  }
  return parsed;
}

function compatiblePgvectorVersion(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || (major === 0 && minor >= 8);
}

function mapMemoryRow(row: SqlRow): WorldMemoryRecord {
  return worldMemoryRecordSchema.parse({
    schemaVersion: row.schema_version,
    operationId: row.operation_id,
    memoryId: row.memory_id,
    serverProfileId: row.server_profile_id,
    dimension: row.dimension,
    position: {
      x: finiteNumber(row.position_x, "position_x"),
      y: finiteNumber(row.position_y, "position_y"),
      z: finiteNumber(row.position_z, "position_z"),
    },
    kind: row.kind,
    summary: row.summary,
    tags: row.tags,
    confidence: finiteNumber(row.confidence, "confidence"),
    visibility: row.visibility,
    allowedSubjectIds: row.allowed_subject_ids,
    modelAccess: row.model_access,
    sourceBotId: row.source_bot_id,
    sourceTaskId: row.source_task_id ?? null,
    traceId: row.trace_id,
    observedAt: timestamp(row.observed_at),
    expiresAt: timestamp(row.expires_at),
    supersedesMemoryId: row.supersedes_memory_id ?? null,
    embeddingModel: row.embedding_model ?? null,
    embeddingDimensions: integer(
      row.embedding_dimensions,
      "embedding_dimensions",
    ),
    createdAt: timestamp(row.created_at),
  });
}

async function rollback(client: PostgresClientLike): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the authoritative transaction failure.
  }
}

export class PostgresWorldMemoryRepository
  implements WorldMemoryRepositoryLike, WorldMemoryWriterLike
{
  constructor(
    private readonly pool: PostgresPoolLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verifySchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        extension_version: unknown;
        memory_table: unknown;
      }>(`
        SELECT
          (
            SELECT extension.extversion
            FROM pg_extension AS extension
            JOIN pg_namespace AS namespace
              ON namespace.oid = extension.extnamespace
            WHERE extension.extname = 'vector'
              AND namespace.nspname = 'public'
          )
            AS extension_version,
          to_regclass('studio_world_memory')::text AS memory_table
      `);
      const row = result.rows[0];
      const version = row?.extension_version;
      const table = row?.memory_table;
      if (!compatiblePgvectorVersion(version) || typeof table !== "string") {
        throw new WorldMemoryError(
          "WORLD_MEMORY_SCHEMA_UNAVAILABLE",
          "World-memory schema or compatible public pgvector extension is unavailable.",
        );
      }
    } finally {
      client.release();
    }
  }

  async record(
    input: WorldMemoryWriteCommand,
  ): Promise<RecordWorldMemoryResult> {
    const command = normalizeWriteCommand(input);
    const fingerprint = worldMemoryOperationFingerprint(command);
    const createdAt = this.now().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(TRANSACTION_LOCK_TIMEOUT_SQL);
      await client.query(TRANSACTION_STATEMENT_TIMEOUT_SQL);
      const inserted = await client.query<SqlRow>(`
        INSERT INTO studio_world_memory (
          memory_id, schema_version, operation_id, operation_fingerprint,
          server_profile_id, dimension, position_x, position_y, position_z,
          kind, summary, tags, confidence, visibility, allowed_subject_ids,
          model_access, source_bot_id, source_task_id, trace_id, observed_at,
          expires_at, supersedes_memory_id, embedding_model, embedding,
          created_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12::text[], $13, $14, $15::text[],
          $16, $17, $18, $19, $20,
          $21, $22, $23, $24::vector,
          $25
        )
        ON CONFLICT (operation_id) DO NOTHING
        RETURNING ${WORLD_MEMORY_COLUMNS.replaceAll("m.", "")}
      `, [
        command.memoryId,
        command.schemaVersion,
        command.operationId,
        fingerprint,
        command.serverProfileId,
        command.dimension,
        command.position.x,
        command.position.y,
        command.position.z,
        command.kind,
        command.summary,
        command.tags,
        command.confidence,
        command.visibility,
        command.allowedSubjectIds,
        command.modelAccess,
        command.sourceBotId,
        command.sourceTaskId,
        command.traceId,
        command.observedAt,
        command.expiresAt,
        command.supersedesMemoryId,
        command.embedding?.model ?? null,
        command.embedding === null
          ? null
          : vectorLiteral(command.embedding.values),
        createdAt,
      ]);

      if (inserted.rows[0] !== undefined) {
        await client.query("COMMIT");
        return Object.freeze({
          memory: mapMemoryRow(inserted.rows[0]),
          created: true,
        });
      }

      const replay = await client.query<SqlRow>(`
        SELECT ${WORLD_MEMORY_COLUMNS}
        FROM studio_world_memory AS m
        WHERE m.operation_id = $1
        FOR SHARE
      `, [command.operationId]);
      const replayRow = replay.rows[0];
      if (replayRow === undefined) {
        throw new WorldMemoryError(
          "WORLD_MEMORY_NOT_FOUND",
          "World-memory idempotency replay disappeared during its transaction.",
        );
      }
      if (replayRow.operation_fingerprint !== fingerprint) {
        throw new WorldMemoryError(
          "WORLD_MEMORY_IDEMPOTENCY_CONFLICT",
          "World-memory operation ID was reused with different content.",
        );
      }
      await client.query("COMMIT");
      return Object.freeze({
        memory: mapMemoryRow(replayRow),
        created: false,
      });
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async search(
    input: WorldMemoryQuery,
  ): Promise<readonly WorldMemorySearchResult[]> {
    const query = worldMemoryQuerySchema.parse(input);
    const values: unknown[] = [];
    const parameter = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    const server = parameter(query.serverProfileId);
    const dimension = parameter(query.dimension);
    const subject = parameter(query.subjectId);
    const conditions = [
      `m.server_profile_id = ${server}`,
      `m.dimension = ${dimension}`,
      `(m.visibility = 'team' OR m.source_bot_id = ${subject} OR ${subject} = ANY(m.allowed_subject_ids))`,
      `(m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)`,
      `NOT EXISTS (
        SELECT 1
        FROM studio_world_memory AS replacement
        WHERE replacement.supersedes_memory_id = m.memory_id
      )`,
    ];

    if (query.modelAccessOnly) {
      conditions.push("m.model_access = true", "m.visibility = 'team'");
    }
    if (query.kinds.length > 0) {
      conditions.push(`m.kind = ANY(${parameter(query.kinds)}::text[])`);
    }
    if (query.tags.length > 0) {
      conditions.push(`m.tags @> ${parameter(query.tags)}::text[]`);
    }
    conditions.push(`m.confidence >= ${parameter(query.minimumConfidence)}`);
    if (query.observedAfter !== null) {
      conditions.push(`m.observed_at >= ${parameter(query.observedAfter)}`);
    }

    let distanceExpression = "NULL::double precision";
    if (query.center !== null) {
      const x = parameter(query.center.x);
      const y = parameter(query.center.y);
      const z = parameter(query.center.z);
      const radius = parameter(query.center.radius);
      const distanceSquared = `(
        power(m.position_x - ${x}, 2) +
        power(m.position_y - ${y}, 2) +
        power(m.position_z - ${z}, 2)
      )`;
      conditions.push(`${distanceSquared} <= power(${radius}, 2)`);
      distanceExpression = `sqrt(${distanceSquared})`;
    }

    let cosineExpression = "NULL::double precision";
    let maximumCosineDistance: string | null = null;
    if (query.semantic !== null) {
      const model = parameter(query.semantic.model);
      const dimensions = parameter(query.semantic.values.length);
      const embedding = parameter(vectorLiteral(query.semantic.values));
      conditions.push(
        "m.embedding IS NOT NULL",
        `m.embedding_model = ${model}`,
        `vector_dims(m.embedding) = ${dimensions}`,
      );
      cosineExpression = `m.embedding <=> ${embedding}::vector`;
      if (query.semantic.maxCosineDistance !== undefined) {
        maximumCosineDistance = parameter(
          query.semantic.maxCosineDistance,
        );
      }
    }

    const limit = parameter(query.limit);
    const result = await this.withClient(async (client) =>
      await client.query<SqlRow>(`
        WITH permitted AS MATERIALIZED (
          SELECT
            ${WORLD_MEMORY_COLUMNS},
            ${distanceExpression} AS spatial_distance,
            ${cosineExpression} AS cosine_distance
          FROM studio_world_memory AS m
          WHERE ${conditions.join("\n            AND ")}
        )
        SELECT *
        FROM permitted
        ${maximumCosineDistance === null
          ? ""
          : `WHERE cosine_distance <= ${maximumCosineDistance}`}
        ORDER BY
          cosine_distance ASC NULLS LAST,
          spatial_distance ASC NULLS LAST,
          confidence DESC,
          observed_at DESC,
          memory_id ASC
        LIMIT ${limit}
      `, values),
    );
    return Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          memory: mapMemoryRow(row),
          distance: nullableFiniteNumber(row.spatial_distance, "spatial_distance"),
          cosineDistance: nullableFiniteNumber(
            row.cosine_distance,
            "cosine_distance",
          ),
        }),
      ),
    );
  }

  private async withClient<TResult>(
    operation: (client: PostgresClientLike) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await this.pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }
}
