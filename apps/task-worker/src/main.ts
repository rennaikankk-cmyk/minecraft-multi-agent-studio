import { randomUUID } from "node:crypto";

import { createStructuredLogger } from "@minecraft-studio/observability";
import {
  BullMqTaskWorker,
  PgTaskPoolAdapter,
  PostgresTaskRepository,
  TaskInfrastructureConfigError,
} from "@minecraft-studio/task-system";

import {
  TaskWorkerConfigError,
  loadTaskWorkerConfig,
} from "./config.js";
import { createIsolatedAcceptanceRegistry } from "./isolated-acceptance-handler.js";
import { createCoordinatorGoalRegistry } from "./coordinator-goal-handler.js";

const instanceId = `task-worker-${randomUUID()}`;
const logger = createStructuredLogger({
  service: "task-worker",
  instanceId,
});

function waitForShutdownSignal(): Promise<"SIGINT" | "SIGTERM"> {
  return new Promise((resolve) => {
    const onInterrupt = () => {
      process.removeListener("SIGTERM", onTerminate);
      resolve("SIGINT");
    };
    const onTerminate = () => {
      process.removeListener("SIGINT", onInterrupt);
      resolve("SIGTERM");
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
}

async function main(): Promise<void> {
  const config = loadTaskWorkerConfig();
  const pool = new PgTaskPoolAdapter({
    connectionString: config.infrastructure.postgresUrl,
    options: `-c search_path=${config.schemaName}`,
  });
  let worker: BullMqTaskWorker | null = null;
  try {
    await pool.verifyConnection();
    const repository = new PostgresTaskRepository(pool);
    const registry = config.purpose === "production"
      ? createCoordinatorGoalRegistry({
          baseUrl: config.coordinatorExecution.url,
          secret: config.coordinatorExecution.secret,
          workerInstanceId: instanceId,
        })
      : createIsolatedAcceptanceRegistry();
    worker = new BullMqTaskWorker(
      repository,
      registry,
      {
        redisUrl: config.infrastructure.redisUrl,
        queueName: config.infrastructure.queueName,
        prefix: config.infrastructure.queuePrefix,
        instanceId,
        concurrency: config.concurrency,
        leaseDurationMs: config.leaseDurationMs,
        renewIntervalMs: config.renewIntervalMs,
        lockDurationMs: config.lockDurationMs,
        stalledIntervalMs: config.stalledIntervalMs,
        cancellationWaitMs: config.cancellationWaitMs,
        cancellationPollIntervalMs: config.cancellationPollIntervalMs,
      },
    );
    await worker.start();
    logger.info("task_worker_started", {
      purpose: config.purpose,
      handlerProfile: config.handlerProfile,
      concurrency: config.concurrency,
    });
    const signal = await waitForShutdownSignal();
    logger.info("task_worker_stopping", { signal });
  } finally {
    let cleanupFailed = false;
    if (worker) {
      try {
        await worker.close();
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await pool.close();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      throw new Error("Task Worker shutdown failed.");
    }
  }
}

void main().catch((cause: unknown) => {
  const code =
    cause instanceof TaskWorkerConfigError ||
    cause instanceof TaskInfrastructureConfigError
      ? cause.code
      : "TASK_WORKER_START_FAILED";
  logger.error("task_worker_start_failed", { code });
  process.exitCode = 1;
});
