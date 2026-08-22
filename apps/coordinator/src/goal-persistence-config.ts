import { z } from "zod";

const schemaNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

export type GoalPersistenceConfig = Readonly<{
  postgresUrl: string;
  schemaName: string;
}>;

export class GoalPersistenceConfigError extends Error {
  readonly code = "GOAL_PERSISTENCE_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "GoalPersistenceConfigError";
  }
}

export function loadGoalPersistenceConfig(
  environment: NodeJS.ProcessEnv = process.env,
): GoalPersistenceConfig | null {
  const rawUrl = environment.COORDINATOR_TASK_POSTGRES_URL?.trim() ?? "";
  const rawSchema = environment.COORDINATOR_TASK_POSTGRES_SCHEMA?.trim();
  if (rawUrl.length === 0) {
    if (rawSchema !== undefined && rawSchema.length > 0) {
      throw new GoalPersistenceConfigError(
        "A task PostgreSQL schema cannot be configured without a connection URL.",
      );
    }
    return null;
  }
  if (rawUrl.length > 2_048) {
    throw new GoalPersistenceConfigError(
      "The task PostgreSQL connection URL is too long.",
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GoalPersistenceConfigError(
      "The task PostgreSQL connection URL is invalid.",
    );
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.hostname.length === 0 ||
    url.pathname.length < 2 ||
    url.hash.length > 0
  ) {
    throw new GoalPersistenceConfigError(
      "The task PostgreSQL connection URL is not an approved database URL.",
    );
  }
  const parsedSchema = schemaNameSchema.safeParse(rawSchema ?? "public");
  if (!parsedSchema.success) {
    throw new GoalPersistenceConfigError(
      "The task PostgreSQL schema name is invalid.",
    );
  }
  return {
    postgresUrl: url.href,
    schemaName: parsedSchema.data,
  };
}
