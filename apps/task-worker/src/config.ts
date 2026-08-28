import {
  parseIsolatedTaskInfrastructureConfig,
  type IsolatedTaskInfrastructureConfig,
} from "@minecraft-studio/task-system";

const ISOLATED_NAMESPACE_PATTERN = /^studio_test_[a-z0-9_]{8,48}$/u;
const SCHEMA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const QUEUE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/u;

type TaskWorkerCommonConfig = Readonly<{
  schemaName: string;
  infrastructure: IsolatedTaskInfrastructureConfig;
  concurrency: number;
  leaseDurationMs: number;
  renewIntervalMs: number;
  lockDurationMs: number;
  stalledIntervalMs: number;
  cancellationWaitMs: number;
  cancellationPollIntervalMs: number;
}>;

export type TaskWorkerProcessConfig = TaskWorkerCommonConfig &
  (
    | Readonly<{
        purpose: "isolated-test";
        handlerProfile: "isolated-acceptance";
      }>
    | Readonly<{
        purpose: "production";
        handlerProfile: "coordinator-goal";
        coordinatorExecution: Readonly<{ url: string; secret: string }>;
      }>
  );

export class TaskWorkerConfigError extends Error {
  readonly code = "TASK_WORKER_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "TaskWorkerConfigError";
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const candidate = value === undefined || value.trim().length === 0
    ? fallback
    : Number(value);
  if (
    !Number.isInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new TaskWorkerConfigError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return candidate;
}

export function loadTaskWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TaskWorkerProcessConfig {
  const purpose = environment.TASK_WORKER_PURPOSE?.trim();
  const handlerProfile = environment.TASK_WORKER_HANDLER_PROFILE?.trim();
  if (
    !(
      (purpose === "isolated-test" &&
        handlerProfile === "isolated-acceptance") ||
      (purpose === "production" && handlerProfile === "coordinator-goal")
    )
  ) {
    throw new TaskWorkerConfigError(
      "TASK_WORKER_PURPOSE and TASK_WORKER_HANDLER_PROFILE must select an approved matching profile.",
    );
  }

  const schemaName = purpose === "isolated-test"
    ? environment.TASK_INFRA_TEST_NAMESPACE
    : environment.COORDINATOR_TASK_POSTGRES_SCHEMA?.trim() || "public";
  if (
    !schemaName ||
    !(purpose === "isolated-test"
      ? ISOLATED_NAMESPACE_PATTERN
      : SCHEMA_NAME_PATTERN
    ).test(schemaName)
  ) {
    throw new TaskWorkerConfigError(
      "The Task Worker PostgreSQL schema is invalid for the selected profile.",
    );
  }

  const queueName = purpose === "isolated-test"
    ? environment.TASK_QUEUE_NAME ?? "studio_tasks_v1"
    : environment.COORDINATOR_TASK_QUEUE_NAME?.trim() || "studio_tasks_v1";
  const queuePrefix = purpose === "isolated-test"
    ? schemaName
    : environment.COORDINATOR_TASK_QUEUE_PREFIX?.trim() || schemaName;
  if (
    !QUEUE_NAME_PATTERN.test(queueName) ||
    !QUEUE_NAME_PATTERN.test(queuePrefix) ||
    queuePrefix !== schemaName
  ) {
    throw new TaskWorkerConfigError(
      "Task Worker queue names must be valid and the prefix must match the PostgreSQL schema.",
    );
  }

  const infrastructure = parseIsolatedTaskInfrastructureConfig({
    postgresUrl:
      purpose === "isolated-test"
        ? environment.TASK_POSTGRES_URL
        : environment.COORDINATOR_TASK_POSTGRES_URL,
    redisUrl:
      purpose === "isolated-test"
        ? environment.TASK_REDIS_URL
        : environment.COORDINATOR_TASK_REDIS_URL,
    queueName,
    queuePrefix,
  });
  const concurrency = boundedInteger(
    environment.TASK_WORKER_CONCURRENCY,
    1,
    1,
    32,
    "TASK_WORKER_CONCURRENCY",
  );
  const leaseDurationMs = boundedInteger(
    environment.TASK_WORKER_LEASE_DURATION_MS,
    5_000,
    1_000,
    5 * 60_000,
    "TASK_WORKER_LEASE_DURATION_MS",
  );
  const renewIntervalMs = boundedInteger(
    environment.TASK_WORKER_RENEW_INTERVAL_MS,
    1_000,
    100,
    60_000,
    "TASK_WORKER_RENEW_INTERVAL_MS",
  );
  const lockDurationMs = boundedInteger(
    environment.TASK_WORKER_LOCK_DURATION_MS,
    10_000,
    2_000,
    10 * 60_000,
    "TASK_WORKER_LOCK_DURATION_MS",
  );
  const stalledIntervalMs = boundedInteger(
    environment.TASK_WORKER_STALLED_INTERVAL_MS,
    2_000,
    500,
    60_000,
    "TASK_WORKER_STALLED_INTERVAL_MS",
  );
  const cancellationWaitMs = boundedInteger(
    environment.TASK_WORKER_CANCELLATION_WAIT_MS,
    10_000,
    1_000,
    60_000,
    "TASK_WORKER_CANCELLATION_WAIT_MS",
  );
  const cancellationPollIntervalMs = boundedInteger(
    environment.TASK_WORKER_CANCELLATION_POLL_INTERVAL_MS,
    100,
    50,
    10_000,
    "TASK_WORKER_CANCELLATION_POLL_INTERVAL_MS",
  );
  if (renewIntervalMs * 2 > leaseDurationMs) {
    throw new TaskWorkerConfigError(
      "Task Worker lease renewal must run at least twice per lease duration.",
    );
  }
  if (lockDurationMs <= leaseDurationMs) {
    throw new TaskWorkerConfigError(
      "Task Worker BullMQ lock duration must exceed its PostgreSQL lease.",
    );
  }
  if (cancellationPollIntervalMs > cancellationWaitMs) {
    throw new TaskWorkerConfigError(
      "Task Worker cancellation polling must fit within its wait window.",
    );
  }

  const common: TaskWorkerCommonConfig = {
    schemaName,
    infrastructure,
    concurrency,
    leaseDurationMs,
    renewIntervalMs,
    lockDurationMs,
    stalledIntervalMs,
    cancellationWaitMs,
    cancellationPollIntervalMs,
  };
  if (purpose === "isolated-test") {
    return { ...common, purpose, handlerProfile: "isolated-acceptance" };
  }

  const host = environment.COORDINATOR_TASK_EXECUTION_HOST?.trim() ||
    "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new TaskWorkerConfigError(
      "COORDINATOR_TASK_EXECUTION_HOST must be an explicit loopback address.",
    );
  }
  const port = boundedInteger(
    environment.COORDINATOR_TASK_EXECUTION_PORT,
    3_222,
    1,
    65_535,
    "COORDINATOR_TASK_EXECUTION_PORT",
  );
  const secret = environment.COORDINATOR_TASK_EXECUTION_SECRET?.trim() ?? "";
  if (secret.length < 32 || secret.length > 512) {
    throw new TaskWorkerConfigError(
      "COORDINATOR_TASK_EXECUTION_SECRET must contain 32 to 512 characters.",
    );
  }
  const urlHost = host === "::1" ? "[::1]" : host;
  return {
    ...common,
    purpose,
    handlerProfile: "coordinator-goal",
    coordinatorExecution: {
      url: `http://${urlHost}:${port}`,
      secret,
    },
  };
}
