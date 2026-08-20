import { isIP } from "node:net";

import { PgTaskPoolAdapter } from "@minecraft-studio/task-system";
import {
  PostgresWorldMemoryRepository,
  WorldMemoryPlannerContextService,
  WorldMemorySkillResultIngestor,
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
  });
}

export async function createCoordinatorWorldMemoryRuntimeFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CoordinatorWorldMemoryRuntime | null> {
  const config = loadCoordinatorWorldMemoryConfig(environment);
  if (!config.enabled) return null;

  const pool = new PgTaskPoolAdapter({
    connectionString: config.postgresUrl,
    options: `-c search_path=${config.schemaName},public`,
  });
  try {
    await pool.verifyConnection();
    const repository = new PostgresWorldMemoryRepository(pool);
    await repository.verifySchema();
    const context = new WorldMemoryPlannerContextService(repository, {
      maxEntries: config.maxEntries,
      radius: config.radius,
      minimumConfidence: config.minimumConfidence,
    });
    const ingestor = new WorldMemorySkillResultIngestor(repository);
    let closed = false;
    return Object.freeze({
      relevantMemoryProvider: async (request) =>
        await context.retrieve({
          serverProfileId: request.serverProfileId,
          dimension: request.dimension,
          position: request.position,
          subjectId: request.botId,
          task: request.task,
          signal: request.signal,
        }),
      skillResultObserver: async (observation) =>
        await ingestor.ingest({
          command: observation.command,
          result: observation.result,
          authoritativeServerProfileId:
            observation.authoritativeServerProfileId,
          authoritativePosition: observation.authoritativePosition,
        }),
      close: async () => {
        if (closed) return;
        closed = true;
        await pool.close();
      },
    });
  } catch (error) {
    await pool.close().catch(() => undefined);
    if (error instanceof CoordinatorWorldMemoryError) throw error;
    throw new CoordinatorWorldMemoryError(
      "WORLD_MEMORY_START_FAILED",
      "Coordinator world-memory startup failed closed.",
      { cause: error },
    );
  }
}
