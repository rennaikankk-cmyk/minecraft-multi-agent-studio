import { isIP } from "node:net";
import { isAbsolute, parse, resolve } from "node:path";

import type { AppLogger } from "@minecraft-studio/observability";
import { PgTaskPoolAdapter } from "@minecraft-studio/task-system";
import {
  DurableWorldMemorySkillResultIngestor,
  FileWorldMemoryIngestionOutbox,
  MAX_WORLD_MEMORY_OUTBOX_BATCH_SIZE,
  MAX_WORLD_MEMORY_OUTBOX_PENDING_BATCHES,
  PostgresWorldMemoryRepository,
  WorldMemoryError,
  WorldMemoryPlannerContextService,
} from "@minecraft-studio/world-memory";

import type { CoordinatorRelevantMemoryProvider } from "./ai-planner.js";
import type { SkillInvocationResultObserver } from "./skill-invocation-controller.js";

export type CoordinatorWorldMemoryConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      postgresUrl: string;
      schemaName: string;
      maxEntries: number;
      radius: number;
      minimumConfidence: number;
      ingestionSpoolDirectory: string;
      ingestionBatchSize: number;
      ingestionMaxPendingBatches: number;
      ingestionPollIntervalMs: number;
      ingestionRetryBaseMs: number;
      ingestionRetryMaxMs: number;
    }>;

export type CoordinatorWorldMemoryErrorCode =
  | "WORLD_MEMORY_CONFIG_INVALID"
  | "WORLD_MEMORY_START_FAILED";

export class CoordinatorWorldMemoryError extends Error {
  constructor(
    readonly code: CoordinatorWorldMemoryErrorCode,
    message: string,
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CoordinatorWorldMemoryError";
  }
}

export type CoordinatorWorldMemoryRuntime = Readonly<{
  relevantMemoryProvider: CoordinatorRelevantMemoryProvider;
  skillResultObserver: SkillInvocationResultObserver;
  close(): Promise<void>;
}>;

export type CoordinatorWorldMemoryRuntimeOptions = Readonly<{
  logger?: AppLogger;
}>;

export class CoordinatorWorldMemoryIngestionHealth {
  private healthy = true;

  noteReconcile(result: Readonly<{
    failed: number;
    pendingBatchCount: number;
  }>): void {
    this.healthy = result.failed === 0 && result.pendingBatchCount === 0;
  }

  noteIngestion(result: Readonly<{
    deferredCount: number;
    pendingBatchCount: number;
  }>): void {
    this.healthy =
      result.deferredCount === 0 && result.pendingBatchCount === 0;
  }

  noteFailure(): void {
    this.healthy = false;
  }

  assertPlanningAllowed(): void {
    if (!this.healthy) {
      throw new WorldMemoryError(
        "WORLD_MEMORY_INGESTION_FAILED",
        "World-memory ingestion backlog must recover before new planning.",
      );
    }
  }
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function postgresUrl(input: string | undefined): string {
  if (!input || input.length > 2_048) {
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_CONFIG_INVALID",
      "WORLD_MEMORY_POSTGRES_URL is required and must be at most 2048 characters.",
    );
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_CONFIG_INVALID",
      "WORLD_MEMORY_POSTGRES_URL must be a valid PostgreSQL URL.",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !loopbackHostname(url.hostname) ||
    url.pathname.length < 2 ||
    url.hash.length > 0 ||
    url.search.length > 0
  ) {
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_CONFIG_INVALID",
      "World-memory PostgreSQL must be a named loopback database URL without query or fragment data.",
    );
  }
  return url.href;
}

function integer(
  input: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_CONFIG_INVALID",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function finiteNumber(
  input: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_CONFIG_INVALID",
      `${name} must be between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function ingestionSpoolDirectory(input: string | undefined): string {
  if (!input || input.trim().length === 0 || input.length > 1_024) {
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_CONFIG_INVALID",
      "WORLD_MEMORY_INGESTION_SPOOL_DIR is required and must be at most 1024 characters.",
    );
  }
  const directory = resolve(input);
  if (!isAbsolute(input) || directory === parse(directory).root) {
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_CONFIG_INVALID",
      "WORLD_MEMORY_INGESTION_SPOOL_DIR must be a non-root absolute path.",
    );
  }
  return directory;
}

export function loadCoordinatorWorldMemoryConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CoordinatorWorldMemoryConfig {
  const enabled = environment.WORLD_MEMORY_ENABLED?.trim() ?? "false";
  if (enabled !== "true" && enabled !== "false") {
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_CONFIG_INVALID",
      "WORLD_MEMORY_ENABLED must be exactly true or false.",
    );
  }
  if (enabled === "false") return Object.freeze({ enabled: false });

  const schemaName = environment.WORLD_MEMORY_SCHEMA?.trim() ?? "public";
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schemaName)) {
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_CONFIG_INVALID",
      "WORLD_MEMORY_SCHEMA must be a safe unquoted PostgreSQL identifier.",
    );
  }
  const ingestionRetryBaseMs = integer(
    environment.WORLD_MEMORY_INGESTION_RETRY_BASE_MS,
    250,
    10,
    60_000,
    "WORLD_MEMORY_INGESTION_RETRY_BASE_MS",
  );
  const ingestionRetryMaxMs = integer(
    environment.WORLD_MEMORY_INGESTION_RETRY_MAX_MS,
    60_000,
    100,
    5 * 60_000,
    "WORLD_MEMORY_INGESTION_RETRY_MAX_MS",
  );
  if (ingestionRetryBaseMs > ingestionRetryMaxMs) {
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_CONFIG_INVALID",
      "World-memory ingestion retry base must not exceed its maximum.",
    );
  }
  return Object.freeze({
    enabled: true,
    postgresUrl: postgresUrl(environment.WORLD_MEMORY_POSTGRES_URL),
    schemaName,
    maxEntries: integer(
      environment.WORLD_MEMORY_MAX_ENTRIES,
      12,
      1,
      32,
      "WORLD_MEMORY_MAX_ENTRIES",
    ),
    radius: finiteNumber(
      environment.WORLD_MEMORY_RADIUS,
      4_096,
      1,
      60_000_000,
      "WORLD_MEMORY_RADIUS",
    ),
    minimumConfidence: finiteNumber(
      environment.WORLD_MEMORY_MIN_CONFIDENCE,
      0.2,
      0,
      1,
      "WORLD_MEMORY_MIN_CONFIDENCE",
    ),
    ingestionSpoolDirectory: ingestionSpoolDirectory(
      environment.WORLD_MEMORY_INGESTION_SPOOL_DIR,
    ),
    ingestionBatchSize: integer(
      environment.WORLD_MEMORY_INGESTION_BATCH_SIZE,
      25,
      1,
      MAX_WORLD_MEMORY_OUTBOX_BATCH_SIZE,
      "WORLD_MEMORY_INGESTION_BATCH_SIZE",
    ),
    ingestionMaxPendingBatches: integer(
      environment.WORLD_MEMORY_INGESTION_MAX_PENDING_BATCHES,
      10_000,
      1,
      MAX_WORLD_MEMORY_OUTBOX_PENDING_BATCHES,
      "WORLD_MEMORY_INGESTION_MAX_PENDING_BATCHES",
    ),
    ingestionPollIntervalMs: integer(
      environment.WORLD_MEMORY_INGESTION_POLL_INTERVAL_MS,
      1_000,
      50,
      60_000,
      "WORLD_MEMORY_INGESTION_POLL_INTERVAL_MS",
    ),
    ingestionRetryBaseMs,
    ingestionRetryMaxMs,
  });
}

export async function createCoordinatorWorldMemoryRuntimeFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  options: CoordinatorWorldMemoryRuntimeOptions = {},
): Promise<CoordinatorWorldMemoryRuntime | null> {
  const config = loadCoordinatorWorldMemoryConfig(environment);
  if (!config.enabled) return null;

  const pool = new PgTaskPoolAdapter({
    connectionString: config.postgresUrl,
    options: `-c search_path=${config.schemaName},public`,
  });
  let outbox: FileWorldMemoryIngestionOutbox | null = null;
  try {
    await pool.verifyConnection();
    const repository = new PostgresWorldMemoryRepository(pool);
    await repository.verifySchema();
    const context = new WorldMemoryPlannerContextService(repository, {
      maxEntries: config.maxEntries,
      radius: config.radius,
      minimumConfidence: config.minimumConfidence,
    });
    const ingestionHealth = new CoordinatorWorldMemoryIngestionHealth();
    outbox = new FileWorldMemoryIngestionOutbox({
      directory: config.ingestionSpoolDirectory,
      writer: repository,
      batchSize: config.ingestionBatchSize,
      maxPendingBatches: config.ingestionMaxPendingBatches,
      pollIntervalMs: config.ingestionPollIntervalMs,
      retryBaseMs: config.ingestionRetryBaseMs,
      retryMaxMs: config.ingestionRetryMaxMs,
      onReconcile: (result) => {
        ingestionHealth.noteReconcile(result);
        if (result.examined === 0) return;
        const log = result.failed === 0
          ? options.logger?.info.bind(options.logger)
          : options.logger?.warn.bind(options.logger);
        log?.("coordinator_world_memory_outbox_reconciled", {
          examined: result.examined,
          delivered: result.delivered,
          failed: result.failed,
          deferredCount: result.deferredCount,
          pendingBatchCount: result.pendingBatchCount,
        });
      },
      onError: (error) => {
        ingestionHealth.noteFailure();
        options.logger?.error("coordinator_world_memory_outbox_failed", {
          errorCode: error.code,
        });
      },
    });
    await outbox.start();
    const ingestor = new DurableWorldMemorySkillResultIngestor(outbox);
    let closed = false;
    return Object.freeze({
      relevantMemoryProvider: async (request) => {
        ingestionHealth.assertPlanningAllowed();
        return await context.retrieve({
          serverProfileId: request.serverProfileId,
          dimension: request.dimension,
          position: request.position,
          subjectId: request.botId,
          task: request.task,
          signal: request.signal,
        });
      },
      skillResultObserver: async (observation) => {
        try {
          const result = await ingestor.ingest({
            command: observation.command,
            result: observation.result,
            authoritativeServerProfileId:
              observation.authoritativeServerProfileId,
            authoritativePosition: observation.authoritativePosition,
          });
          ingestionHealth.noteIngestion(result);
          return result;
        } catch (error) {
          ingestionHealth.noteFailure();
          throw error;
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await outbox?.stop();
        await pool.close();
      },
    });
  } catch (error) {
    await outbox?.stop().catch(() => undefined);
    await pool.close().catch(() => undefined);
    if (error instanceof CoordinatorWorldMemoryError) throw error;
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_START_FAILED",
      "Coordinator world-memory startup failed closed.",
      { cause: error },
    );
  }
}
