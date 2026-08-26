import {
  parseIsolatedPostgresUrl,
  parseIsolatedRedisUrl,
} from "@minecraft-studio/task-system";

import type { GoalPersistenceConfig } from "./goal-persistence-config.js";

const ISOLATED_PREFIX_PATTERN = /^studio_test_[a-z0-9_]{8,48}$/u;
const QUEUE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/u;

type TaskDeliveryBaseConfig = Readonly<{
  redisUrl: string;
  queueName: string;
  queuePrefix: string;
  instanceId: string;
  batchSize: number;
  claimTtlMs: number;
  pollIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}>;

export type TaskDeliveryConfig = TaskDeliveryBaseConfig &
  (
    | Readonly<{ purpose: "isolated-test" }>
    | Readonly<{
        purpose: "production";
        goalExecution: Readonly<{
          host: "127.0.0.1" | "::1";
          port: number;
          secret: string;
        }>;
      }>
  );

export class TaskDeliveryConfigError extends Error {
  readonly code = "TASK_DELIVERY_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "TaskDeliveryConfigError";
  }
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const trimmed = value?.trim() ?? "";
  const parsed = trimmed.length === 0 ? fallback : Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TaskDeliveryConfigError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

/**
 * Delivery is opt-in and intentionally limited to loopback infrastructure.
 * The production profile selects real handlers, not remote infrastructure.
 */
export function loadTaskDeliveryConfig(
  environment: NodeJS.ProcessEnv = process.env,
  persistence: GoalPersistenceConfig | null = null,
  defaultInstanceId = "coordinator-task-delivery",
): TaskDeliveryConfig | null {
  const purpose = environment.COORDINATOR_TASK_DELIVERY?.trim() ?? "";
  const rawKeys = [
    "COORDINATOR_TASK_REDIS_URL",
    "COORDINATOR_TASK_QUEUE_NAME",
    "COORDINATOR_TASK_QUEUE_PREFIX",
    "COORDINATOR_TASK_DELIVERY_INSTANCE_ID",
    "COORDINATOR_TASK_OUTBOX_BATCH_SIZE",
    "COORDINATOR_TASK_OUTBOX_CLAIM_TTL_MS",
    "COORDINATOR_TASK_OUTBOX_POLL_INTERVAL_MS",
    "COORDINATOR_TASK_OUTBOX_RETRY_BASE_MS",
    "COORDINATOR_TASK_OUTBOX_RETRY_MAX_MS",
    "COORDINATOR_TASK_EXECUTION_HOST",
    "COORDINATOR_TASK_EXECUTION_PORT",
    "COORDINATOR_TASK_EXECUTION_SECRET",
  ] as const;
  const hasDeliveryValues = rawKeys.some(
    (key) => (environment[key]?.trim() ?? "").length > 0,
  );
  if (purpose.length === 0) {
    if (hasDeliveryValues) {
      throw new TaskDeliveryConfigError(
        "COORDINATOR_TASK_DELIVERY must explicitly select a delivery profile.",
      );
    }
    return null;
  }
  if (purpose !== "isolated-test" && purpose !== "production") {
    throw new TaskDeliveryConfigError(
      "COORDINATOR_TASK_DELIVERY must be isolated-test or production.",
    );
  }
  if (!persistence) {
    throw new TaskDeliveryConfigError(
      "Task delivery requires COORDINATOR_TASK_POSTGRES_URL.",
    );
  }

  const schemaName = persistence.schemaName;
  if (purpose === "isolated-test" && !ISOLATED_PREFIX_PATTERN.test(schemaName)) {
    throw new TaskDeliveryConfigError(
      "Isolated task delivery requires a studio_test_ PostgreSQL schema.",
    );
  }
  try {
    // Re-parse at the queue boundary so neither profile can silently target a
    // remote PostgreSQL endpoint.
    parseIsolatedPostgresUrl(persistence.postgresUrl);
  } catch {
    throw new TaskDeliveryConfigError(
      "COORDINATOR_TASK_POSTGRES_URL must target loopback PostgreSQL.",
    );
  }
  const rawRedisUrl = environment.COORDINATOR_TASK_REDIS_URL?.trim() ?? "";
  if (!rawRedisUrl) {
    throw new TaskDeliveryConfigError(
      "COORDINATOR_TASK_REDIS_URL is required for task delivery.",
    );
  }
  let redisUrl: string;
  try {
    redisUrl = parseIsolatedRedisUrl(rawRedisUrl);
  } catch {
    throw new TaskDeliveryConfigError(
      "COORDINATOR_TASK_REDIS_URL must target loopback Redis.",
    );
  }

  const queueName =
    environment.COORDINATOR_TASK_QUEUE_NAME?.trim() || "studio_tasks_v1";
  if (!QUEUE_NAME_PATTERN.test(queueName)) {
    throw new TaskDeliveryConfigError("COORDINATOR_TASK_QUEUE_NAME is invalid.");
  }
  const queuePrefix =
    environment.COORDINATOR_TASK_QUEUE_PREFIX?.trim() || schemaName;
  if (
    !(purpose === "isolated-test"
      ? ISOLATED_PREFIX_PATTERN
      : QUEUE_NAME_PATTERN
    ).test(queuePrefix)
  ) {
    throw new TaskDeliveryConfigError(
      "COORDINATOR_TASK_QUEUE_PREFIX is invalid for the selected profile.",
    );
  }
  if (queuePrefix !== schemaName) {
    throw new TaskDeliveryConfigError(
      "COORDINATOR_TASK_QUEUE_PREFIX must match the PostgreSQL test schema.",
    );
  }
  const instanceId =
    environment.COORDINATOR_TASK_DELIVERY_INSTANCE_ID?.trim() ||
    defaultInstanceId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(instanceId)) {
    throw new TaskDeliveryConfigError(
      "COORDINATOR_TASK_DELIVERY_INSTANCE_ID is invalid.",
    );
  }
  const batchSize = integer(
    environment.COORDINATOR_TASK_OUTBOX_BATCH_SIZE,
    25,
    1,
    100,
    "COORDINATOR_TASK_OUTBOX_BATCH_SIZE",
  );
  const claimTtlMs = integer(
    environment.COORDINATOR_TASK_OUTBOX_CLAIM_TTL_MS,
    30_000,
    1_000,
    5 * 60_000,
    "COORDINATOR_TASK_OUTBOX_CLAIM_TTL_MS",
  );
  const pollIntervalMs = integer(
    environment.COORDINATOR_TASK_OUTBOX_POLL_INTERVAL_MS,
    1_000,
    50,
    60_000,
    "COORDINATOR_TASK_OUTBOX_POLL_INTERVAL_MS",
  );
  const retryBaseMs = integer(
    environment.COORDINATOR_TASK_OUTBOX_RETRY_BASE_MS,
    250,
    10,
    60_000,
    "COORDINATOR_TASK_OUTBOX_RETRY_BASE_MS",
  );
  const retryMaxMs = integer(
    environment.COORDINATOR_TASK_OUTBOX_RETRY_MAX_MS,
    60_000,
    100,
    5 * 60_000,
    "COORDINATOR_TASK_OUTBOX_RETRY_MAX_MS",
  );
  if (retryBaseMs > retryMaxMs) {
    throw new TaskDeliveryConfigError(
      "Task outbox retry base must not exceed retry maximum.",
    );
  }

  const base: TaskDeliveryBaseConfig = {
    redisUrl,
    queueName,
    queuePrefix,
    instanceId,
    batchSize,
    claimTtlMs,
    pollIntervalMs,
    retryBaseMs,
    retryMaxMs,
  };
  if (purpose === "isolated-test") {
    return { ...base, purpose };
  }

  const host = environment.COORDINATOR_TASK_EXECUTION_HOST?.trim() ||
    "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new TaskDeliveryConfigError(
      "COORDINATOR_TASK_EXECUTION_HOST must be an explicit loopback address.",
    );
  }
  const port = integer(
    environment.COORDINATOR_TASK_EXECUTION_PORT,
    3_222,
    1,
    65_535,
    "COORDINATOR_TASK_EXECUTION_PORT",
  );
  const secret = environment.COORDINATOR_TASK_EXECUTION_SECRET?.trim() ?? "";
  if (secret.length < 32 || secret.length > 512) {
    throw new TaskDeliveryConfigError(
      "COORDINATOR_TASK_EXECUTION_SECRET must contain 32 to 512 characters.",
    );
  }
  return {
    ...base,
    purpose,
    goalExecution: { host, port, secret },
  };
}
