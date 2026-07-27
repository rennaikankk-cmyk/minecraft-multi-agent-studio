import { isIP } from "node:net";

import { z } from "zod";

const queueIdentifierSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);

const redisDatabasePathSchema = z
  .string()
  .regex(/^\/(?:[0-9]|1[0-5])?$/u);

export type IsolatedTaskInfrastructureConfig = Readonly<{
  postgresUrl: string;
  redisUrl: string;
  queueName: string;
  queuePrefix: string;
}>;

export class TaskInfrastructureConfigError extends Error {
  readonly code = "TASK_INFRASTRUCTURE_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "TaskInfrastructureConfigError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function parseUrl(
  input: unknown,
  allowedProtocols: readonly string[],
  kind: "PostgreSQL" | "Redis",
): URL {
  if (typeof input !== "string" || input.length < 1 || input.length > 2_048) {
    throw new TaskInfrastructureConfigError(
      `${kind} connection URL is required and must be at most 2048 characters.`,
    );
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TaskInfrastructureConfigError(
      `${kind} connection URL is not a valid URL.`,
    );
  }

  if (!allowedProtocols.includes(url.protocol)) {
    throw new TaskInfrastructureConfigError(
      `${kind} connection URL uses an unsupported protocol.`,
    );
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new TaskInfrastructureConfigError(
      `${kind} isolated integration URL must target loopback.`,
    );
  }
  if (url.hash.length > 0) {
    throw new TaskInfrastructureConfigError(
      `${kind} connection URL must not contain a fragment.`,
    );
  }
  return url;
}

export function parseIsolatedPostgresUrl(input: unknown): string {
  const url = parseUrl(input, ["postgres:", "postgresql:"], "PostgreSQL");
  if (url.pathname.length < 2) {
    throw new TaskInfrastructureConfigError(
      "PostgreSQL connection URL must name an isolated database.",
    );
  }
  if (url.search.length > 0) {
    throw new TaskInfrastructureConfigError(
      "PostgreSQL isolated integration URL must not contain query parameters.",
    );
  }
  return url.href;
}

export function parseIsolatedRedisUrl(input: unknown): string {
  const url = parseUrl(input, ["redis:", "rediss:"], "Redis");
  if (!redisDatabasePathSchema.safeParse(url.pathname).success) {
    throw new TaskInfrastructureConfigError(
      "Redis connection URL may select only database 0 through 15.",
    );
  }
  if (url.search.length > 0) {
    throw new TaskInfrastructureConfigError(
      "Redis isolated integration URL must not contain query parameters.",
    );
  }
  return url.href;
}

export function parseIsolatedTaskInfrastructureConfig(
  input: unknown,
): IsolatedTaskInfrastructureConfig {
  const parsed = z
    .object({
      postgresUrl: z.unknown(),
      redisUrl: z.unknown(),
      queueName: queueIdentifierSchema,
      queuePrefix: queueIdentifierSchema,
    })
    .strict()
    .parse(input);

  return {
    postgresUrl: parseIsolatedPostgresUrl(parsed.postgresUrl),
    redisUrl: parseIsolatedRedisUrl(parsed.redisUrl),
    queueName: parsed.queueName,
    queuePrefix: parsed.queuePrefix,
  };
}
