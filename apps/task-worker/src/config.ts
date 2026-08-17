import {
  parseIsolatedTaskInfrastructureConfig,
  type IsolatedTaskInfrastructureConfig,
} from "@minecraft-studio/task-system";

const ISOLATED_NAMESPACE_PATTERN = /^studio_test_[a-z0-9_]{8,48}$/u;

export type TaskWorkerProcessConfig = Readonly<{
  purpose: "isolated-test";
  handlerProfile: "isolated-acceptance";
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
  const candidate = value === undefined ? fallback : Number(value);
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
  if (environment.TASK_WORKER_PURPOSE !== "isolated-test") {
    throw new TaskWorkerConfigError(
      "TASK_WORKER_PURPOSE must explicitly select isolated-test.",
    );
  }
  if (environment.TASK_WORKER_HANDLER_PROFILE !== "isolated-acceptance") {
    throw new TaskWorkerConfigError(
      "TASK_WORKER_HANDLER_PROFILE must explicitly select isolated-acceptance.",
    );
  }
  const schemaName = environment.TASK_INFRA_TEST_NAMESPACE;
  if (!schemaName || !ISOLATED_NAMESPACE_PATTERN.test(schemaName)) {
    throw new TaskWorkerConfigError(
      "TASK_INFRA_TEST_NAMESPACE must be a dedicated studio_test_ identifier.",
    );
  }

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

  return {
    purpose: "isolated-test",
    handlerProfile: "isolated-acceptance",
    schemaName,
    infrastructure: parseIsolatedTaskInfrastructureConfig({
      postgresUrl: environment.TASK_POSTGRES_URL,
      redisUrl: environment.TASK_REDIS_URL,
      queueName: environment.TASK_QUEUE_NAME ?? "studio_tasks_v1",
      queuePrefix: schemaName,
    }),
    concurrency,
    leaseDurationMs,
    renewIntervalMs,
    lockDurationMs,
    stalledIntervalMs,
    cancellationWaitMs,
    cancellationPollIntervalMs,
  };
}
