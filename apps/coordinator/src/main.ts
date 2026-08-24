import { randomUUID } from "node:crypto";

import {
  AIRouter,
  AIRequestScheduler,
  OllamaAdapter,
  ScheduledAIRouter,
  VLLMAdapter,
} from "@minecraft-studio/ai-router";
import { createStructuredLogger } from "@minecraft-studio/observability";
import {
  BullMqTaskQueue,
  PgTaskPoolAdapter,
  PostgresTaskRepository,
  TaskOutboxReconciler,
} from "@minecraft-studio/task-system";

import { BotRegistry } from "./bot-registry.js";
import { BotAssignmentService } from "./bot-assignment.js";
import {
  ControlLinkConfigError,
  loadControlLinkConfig,
} from "./control-link-config.js";
import { ControlLinkServer } from "./control-link-server.js";
import {
  RuntimeLinkConfigError,
  loadRuntimeLinkConfig,
} from "./runtime-link-config.js";
import { RuntimeLinkServer } from "./runtime-link-server.js";
import { InMemoryStopAuditSink, StopController } from "./stop-controller.js";
import { LocalAIConfigError, loadLocalAIConfig } from "./local-ai-config.js";
import { CoordinatorLocalPlanner } from "./local-planner.js";
import {
  GoalPersistenceConfigError,
  loadGoalPersistenceConfig,
} from "./goal-persistence-config.js";
import { PostgresGoalLifecycleStore } from "./goal-lifecycle-store.js";
import { PostgresTaskHistoryReader } from "./task-history-reader.js";
import { ExpiredLeaseRecoveryController } from "./expired-lease-recovery.js";
import {
  TaskDeliveryConfigError,
  loadTaskDeliveryConfig,
} from "./task-delivery-config.js";

const instanceId = `coordinator-${randomUUID()}`;
const logger = createStructuredLogger({ service: "coordinator", instanceId });

async function main(): Promise<void> {
  const runtimeConfig = loadRuntimeLinkConfig();
  const controlConfig = loadControlLinkConfig();
  const localAIConfig = loadLocalAIConfig();
  const goalPersistenceConfig = loadGoalPersistenceConfig();
  const taskDeliveryConfig = loadTaskDeliveryConfig(
    process.env,
    goalPersistenceConfig,
    instanceId,
  );
  if (
    localAIConfig.enabled &&
    localAIConfig.baseUrl &&
    localAIConfig.model &&
    !goalPersistenceConfig
  ) {
    throw new GoalPersistenceConfigError(
      "Local goal planning requires COORDINATOR_TASK_POSTGRES_URL.",
    );
  }
  const registry = new BotRegistry({
    staleAfterMs: runtimeConfig.botStaleAfterMs,
  });
  const assignment = new BotAssignmentService({
    registry,
    onEvent: (event) => {
      logger.info("coordinator_bot_assignment", {
        assignmentEvent: event.type,
        leaseId: event.leaseId,
        taskId: event.taskId,
        botId: event.botId,
        runtimeInstanceId: event.runtimeInstanceId,
      });
    },
  });
  const runtimeServer = new RuntimeLinkServer({
    host: runtimeConfig.host,
    port: runtimeConfig.port,
    instanceId,
    peers: runtimeConfig.peers,
    registry,
    logger,
  });
  const stopController = new StopController({
    instanceId,
    registry,
    transport: runtimeServer,
    auditSink: new InMemoryStopAuditSink(),
    logger,
  });
  let aiScheduler: AIRequestScheduler | null = null;
  let aiRouter: AIRouter | null = null;
  let localPlanner: CoordinatorLocalPlanner | undefined;
  let taskPool: PgTaskPoolAdapter | null = null;
  let taskRepository: PostgresTaskRepository | null = null;
  let goalStore: PostgresGoalLifecycleStore | undefined;
  let taskHistoryReader: PostgresTaskHistoryReader | undefined;
  let leaseRecovery: ExpiredLeaseRecoveryController | null = null;
  let taskQueue: BullMqTaskQueue | null = null;
  let outboxReconciler: TaskOutboxReconciler | null = null;
  if (localAIConfig.enabled && localAIConfig.baseUrl && localAIConfig.model) {
    aiRouter = new AIRouter();
    aiRouter.register(
      localAIConfig.provider === "ollama"
        ? new OllamaAdapter(localAIConfig.baseUrl, localAIConfig.model)
        : new VLLMAdapter(localAIConfig.baseUrl, localAIConfig.model),
    );
    aiScheduler = new AIRequestScheduler({
      maxConcurrency: localAIConfig.maxConcurrency,
      maxQueue: localAIConfig.maxQueue,
      perBotConcurrency: localAIConfig.perBotConcurrency,
      defaultTimeoutMs: localAIConfig.requestTimeoutMs,
      onEvent: (event) => {
        logger.info("coordinator_ai_request", {
          requestId: event.requestId,
          botId: event.botId,
          priority: event.priority,
          state: event.type,
          attempt: event.attempt,
          queueTimeMs: event.queueTimeMs,
          errorCode: event.errorCode,
        });
      },
    });
    localPlanner = new CoordinatorLocalPlanner({
      ai: new ScheduledAIRouter(aiRouter, aiScheduler),
      registry,
      assignment,
      verifyAssignmentLease: async (lease) => {
        const repository = taskRepository;
        if (!repository) return false;
        try {
          return await repository.isTaskAssignmentLeaseActive(lease);
        } catch {
          // Durable lease authority is fail-closed. A persistence outage must
          // never turn a pre-acquired owner string into an execution grant.
          return false;
        }
      },
      transport: runtimeServer,
      coordinatorInstanceId: instanceId,
      logger,
    });
  }
  if (goalPersistenceConfig) {
    taskPool = new PgTaskPoolAdapter({
      connectionString: goalPersistenceConfig.postgresUrl,
      options: `-c search_path=${goalPersistenceConfig.schemaName}`,
      application_name: "minecraft-studio-coordinator",
    });
    taskRepository = new PostgresTaskRepository(taskPool, {
      dispatchSourceInstanceId: instanceId,
    });
    goalStore = new PostgresGoalLifecycleStore({
      repository: taskRepository,
      coordinatorInstanceId: instanceId,
      resolveBotContext: (botId) => {
        const record = registry.get(botId);
        if (
          !record ||
          record.connectionState !== "online" ||
          record.currentStatus === null
        ) {
          return null;
        }
        return {
          serverProfileId: record.serverProfileId,
          dimension: record.currentStatus.position.dimension,
        };
      },
    });
    taskHistoryReader = new PostgresTaskHistoryReader({
      repository: taskRepository,
    });
    leaseRecovery = new ExpiredLeaseRecoveryController({
      repository: taskRepository,
      actorId: instanceId,
      logger,
    });
    if (taskDeliveryConfig) {
      taskQueue = new BullMqTaskQueue({
        redisUrl: taskDeliveryConfig.redisUrl,
        queueName: taskDeliveryConfig.queueName,
        prefix: taskDeliveryConfig.queuePrefix,
      });
      outboxReconciler = new TaskOutboxReconciler({
        repository: taskRepository,
        queue: taskQueue,
        instanceId: taskDeliveryConfig.instanceId,
        batchSize: taskDeliveryConfig.batchSize,
        claimTtlMs: taskDeliveryConfig.claimTtlMs,
        pollIntervalMs: taskDeliveryConfig.pollIntervalMs,
        retryBaseMs: taskDeliveryConfig.retryBaseMs,
        retryMaxMs: taskDeliveryConfig.retryMaxMs,
      });
    }
  }
  const controlServer = new ControlLinkServer({
    host: controlConfig.host,
    port: controlConfig.port,
    instanceId,
    clients: controlConfig.clients,
    registry,
    stopController,
    ...(localPlanner ? { goalPlanner: localPlanner } : {}),
    ...(goalStore ? { goalStore } : {}),
    ...(taskHistoryReader ? { taskHistoryReader } : {}),
    logger,
  });
  let staleTimer: ReturnType<typeof setInterval> | null = null;

  try {
    await taskPool?.verifyConnection();
    await taskQueue?.verifyConnection();
    const runtimeAddress = await runtimeServer.start();
    const controlAddress = await controlServer.start();
    // PostgreSQL is authoritative for leases. Start bounded recovery only
    // after readiness and both control endpoints are available, so recovered
    // outbox records are not created during a partially started process.
    leaseRecovery?.start();
    await outboxReconciler?.start();
    staleTimer = setInterval(() => {
      try {
        registry.sweepStale();
        assignment.reconcile();
      } catch {
        logger.error("coordinator_registry_stale_sweep_failed", {
          code: "COORDINATOR_CLOCK_INVALID",
        });
      }
    }, 1_000);
    logger.info("coordinator_runtime_link_started", {
      bindScope: "loopback",
      port: runtimeAddress.port,
    });
    logger.info("coordinator_control_link_started", {
      bindScope: "loopback",
      port: controlAddress.port,
    });
    if (taskDeliveryConfig) {
      logger.info("coordinator_task_delivery_started", {
        purpose: taskDeliveryConfig.purpose,
        queueName: taskDeliveryConfig.queueName,
        queuePrefix: taskDeliveryConfig.queuePrefix,
      });
    }
    if (aiRouter) {
      const health = await aiRouter.healthCheck();
      logger.info("coordinator_local_ai_health", {
        available: [...health.values()].some(Boolean),
        adapters: health.size,
      });
    } else {
      logger.info("coordinator_local_ai_disabled", { available: false });
    }
  } catch (cause) {
    if (staleTimer) clearInterval(staleTimer);
    await Promise.allSettled([controlServer.stop(), runtimeServer.stop()]);
    if (leaseRecovery) await Promise.allSettled([leaseRecovery.stop()]);
    if (outboxReconciler) await Promise.allSettled([outboxReconciler.stop()]);
    if (taskQueue) await Promise.allSettled([taskQueue.close()]);
    if (taskPool) await Promise.allSettled([taskPool.close()]);
    throw cause;
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (staleTimer) clearInterval(staleTimer);
    aiScheduler?.close("coordinator shutdown");
    logger.info("coordinator_stopping", { signal });
    // Stop accepting new control/runtime work before draining durable delivery
    // and closing PostgreSQL. Existing leases are then recovered or handed off
    // by the bounded controllers without a new request racing shutdown.
    await Promise.allSettled([controlServer.stop(), runtimeServer.stop()]);
    if (leaseRecovery) {
      try {
        await leaseRecovery.stop();
      } catch {
        logger.error("coordinator_task_lease_recovery_stop_failed", {
          code: "TASK_LEASE_RECOVERY_STOP_FAILED",
        });
      }
    }
    if (outboxReconciler) {
      try {
        await outboxReconciler.stop();
      } catch {
        logger.error("coordinator_task_outbox_reconciler_stop_failed", {
          code: "TASK_OUTBOX_RECONCILER_STOP_FAILED",
        });
      }
    }
    if (taskQueue) {
      try {
        await taskQueue.close();
      } catch {
        logger.error("coordinator_task_queue_close_failed", {
          code: "TASK_QUEUE_CLOSE_FAILED",
        });
      }
    }
    if (taskPool) {
      try {
        await taskPool.close();
      } catch {
        logger.error("coordinator_task_pool_close_failed", {
          code: "POSTGRES_CLOSE_FAILED",
        });
      }
    }
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

void main().catch((cause: unknown) => {
  const code =
    cause instanceof RuntimeLinkConfigError ||
      cause instanceof ControlLinkConfigError ||
      cause instanceof LocalAIConfigError ||
      cause instanceof GoalPersistenceConfigError
      || cause instanceof TaskDeliveryConfigError
      ? cause.code
      : "COORDINATOR_START_FAILED";
  logger.error("coordinator_start_failed", { code });
  process.exitCode = 1;
});
