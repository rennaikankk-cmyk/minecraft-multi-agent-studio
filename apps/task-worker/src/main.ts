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
import { raceWorkerOutcome } from "./lifecycle.js";

const instanceId = `task-worker-${randomUUID()}`;
const logger = createStructuredLogger({
  service: "task-worker",
  instanceId,
});

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
    // 竞速：正常关闭信号 vs worker 基础设施失败。
    // 后者此前完全无人观测——BullMqTaskWorker 只把错误记进
    // lastInfrastructureError，而其 getter 全仓库零调用者，于是 worker 静默
    // 死亡时进程仍然活着却不再处理任何任务。现在以非零退出，交由外部
    // supervisor 重启（本进程不自行重启，避免与 supervisor 的预算双重管理）。
    const outcome = await raceWorkerOutcome(worker);
    if (outcome.kind === "infrastructure-failure") {
      logger.error("task_worker_infrastructure_failed", {
        code: outcome.error.code,
      });
      process.exitCode = 1;
      return;
    }
    logger.info("task_worker_stopping", { signal: outcome.signal });
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
