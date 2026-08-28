import { randomUUID } from "node:crypto";

import {
  AIRouter,
  AIRequestScheduler,
  AISchedulerError,
  OllamaAdapter,
  ScheduledAIRouter,
  VLLMAdapter,
} from "@minecraft-studio/ai-router";
import { createStructuredLogger } from "@minecraft-studio/observability";
import {
  BullMqTaskQueue,
  PgTaskPoolAdapter,
  PersistentTaskStateMachine,
  PostgresTaskExecutionStore,
  PostgresTaskRepository,
  TaskOutboxReconciler,
} from "@minecraft-studio/task-system";

import { BotRegistry } from "./bot-registry.js";
import { BotAssignmentService } from "./bot-assignment.js";
import {
  AutonomousConfigError,
  loadAutonomousConfig,
} from "./autonomous-config.js";
import { AutonomousDirector } from "./autonomous-director.js";
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
import {
  PostgresGoalLifecycleStore,
  type GoalLifecycleStore,
} from "./goal-lifecycle-store.js";
import {
  PostgresTaskHistoryReader,
  type TaskHistoryReader,
} from "./task-history-reader.js";
import { InMemoryGoalLifecycleStore } from "./in-memory-goal-store.js";
import { ExpiredLeaseRecoveryController } from "./expired-lease-recovery.js";
import { CoordinatorGoalExecutionServer } from "./goal-execution-server.js";
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
  const autonomousConfig = loadAutonomousConfig();
  const goalPersistenceConfig = loadGoalPersistenceConfig();
  const taskDeliveryConfig = loadTaskDeliveryConfig(
    process.env,
    goalPersistenceConfig,
    instanceId,
  );
  const localMemoryMode =
    process.env.COORDINATOR_LOCAL_MEMORY_MODE?.trim() === "1";
  if (
    localAIConfig.enabled &&
    localAIConfig.baseUrl &&
    localAIConfig.model &&
    !goalPersistenceConfig &&
    !localMemoryMode
  ) {
    throw new GoalPersistenceConfigError(
      "Local goal planning requires PostgreSQL or explicit desktop memory mode.",
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
  const memoryGoalStore =
    !goalPersistenceConfig && localMemoryMode
      ? new InMemoryGoalLifecycleStore()
      : null;
  let goalStore: GoalLifecycleStore | undefined = memoryGoalStore ?? undefined;
  let taskHistoryReader: TaskHistoryReader | undefined =
    memoryGoalStore ?? undefined;
  let queuedGoalStore: PostgresGoalLifecycleStore | undefined;
  let leaseRecovery: ExpiredLeaseRecoveryController | null = null;
  let taskQueue: BullMqTaskQueue | null = null;
  let outboxReconciler: TaskOutboxReconciler | null = null;
  let goalExecutionServer: CoordinatorGoalExecutionServer | null = null;
  let autonomousDirector: AutonomousDirector | null = null;
  if (localAIConfig.enabled && localAIConfig.baseUrl && localAIConfig.model) {
    aiRouter = new AIRouter();
    aiRouter.register(
      localAIConfig.provider === "ollama"
        ? new OllamaAdapter(localAIConfig.baseUrl, localAIConfig.model)
        : new VLLMAdapter(
            localAIConfig.baseUrl,
            localAIConfig.model,
            localAIConfig.apiKey,
          ),
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
  }
  // 自主生存链的全部目标都走确定性派发，模型只是非模板目标的兜底。所以
  // planner 在没有 Local AI 时也要构造：兜底换成一个永远诚實拒绝的桩
  // （AI_UNAVAILABLE），确定性目标照常 0 次模型调用地运转——这与
  // AGENTS.md §0.4"AI 宕机 fail-closed 到确定性层，而不是停下"一致。
  // 此前整个 AutonomousDirector 被装配在 Spark 配置块里，Spark 不可用
  // 时自主生存完全停摆，而它本来一步都不需要模型。
  if (localAIConfig.enabled && localAIConfig.baseUrl && localAIConfig.model) {
    const taskPersistence = await createTaskStateMachine();
    taskPool = taskPersistence.pool;
    const taskStateMachine = taskPersistence.stateMachine;
    localPlanner = new CoordinatorLocalPlanner({
      ai: new ScheduledAIRouter(aiRouter!, aiScheduler!),
      registry,
      assignment,
      verifyAssignmentLease: async (lease) => {
        const repository = taskRepository;
        if (!repository) {
          return memoryGoalStore?.isAssignmentLeaseActive(lease) ?? false;
        }
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
  } else {
    localPlanner = new CoordinatorLocalPlanner({
      ai: {
        generate: async (request) => {
          throw new AISchedulerError(
            "AI_REQUEST_FAILED",
            "No Local AI hub is configured; only deterministic goal templates are served.",
            request.requestId,
          );
        },
      },
      registry,
      assignment,
      verifyAssignmentLease: async (lease) =>
        memoryGoalStore?.isAssignmentLeaseActive(lease) ?? false,
      transport: runtimeServer,
      coordinatorInstanceId: instanceId,
      logger,
    });
    logger.warn("coordinator_planner_deterministic_only", {
      detail: "Local AI is not configured; model fallback will reject with AI_UNAVAILABLE.",
    });
  }
  if (autonomousConfig.enabled) {
    autonomousDirector = new AutonomousDirector({
      registry,
      planner: localPlanner,
      intervalMs: autonomousConfig.intervalMs,
      goalTimeoutMs: autonomousConfig.goalTimeoutMs,
      failureCooldownMs: autonomousConfig.failureCooldownMs,
      terminalRetentionMs: autonomousConfig.terminalRetentionMs,
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
    queuedGoalStore = new PostgresGoalLifecycleStore({
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
    goalStore = queuedGoalStore;
    taskHistoryReader = new PostgresTaskHistoryReader({
      repository: taskRepository,
    });
    leaseRecovery = new ExpiredLeaseRecoveryController({
      repository: taskRepository,
      actorId: instanceId,
      logger,
    });
    if (taskDeliveryConfig) {
      if (taskDeliveryConfig.purpose === "production" && !localPlanner) {
        throw new TaskDeliveryConfigError(
          "Production task delivery requires a configured Local AI planner.",
        );
      }
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
      if (taskDeliveryConfig.purpose === "production") {
        goalExecutionServer = new CoordinatorGoalExecutionServer({
          ...taskDeliveryConfig.goalExecution,
          repository: taskRepository,
          planner: localPlanner!,
          logger,
        });
      }
    }
  }
  const controlServer = new ControlLinkServer({
    host: controlConfig.host,
    port: controlConfig.port,
    instanceId,
    clients: controlConfig.clients,
    registry,
    stopController,
    assignment,
    ...(localPlanner ? { goalPlanner: localPlanner } : {}),
    ...(goalStore ? { goalStore } : {}),
    ...(taskDeliveryConfig?.purpose === "production" && queuedGoalStore
      ? { queuedGoalStore }
      : {}),
    ...(taskHistoryReader ? { taskHistoryReader } : {}),
    ...(autonomousDirector
      ? { autonomousTaskSource: autonomousDirector }
      : {}),
    logger,
  });
  let staleTimer: ReturnType<typeof setInterval> | null = null;

  try {
    await taskPool?.verifyConnection();
    await taskQueue?.verifyConnection();
    await goalExecutionServer?.start();
    const runtimeAddress = await runtimeServer.start();
    const controlAddress = await controlServer.start();
    autonomousDirector?.start();
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
    logger.info("coordinator_autonomy_configured", {
      enabled: autonomousDirector !== null,
      intervalMs: autonomousConfig.intervalMs,
      goalTimeoutMs: autonomousConfig.goalTimeoutMs,
    });
  } catch (cause) {
    if (staleTimer) clearInterval(staleTimer);
    if (autonomousDirector) await Promise.allSettled([autonomousDirector.stop()]);
    await Promise.allSettled([controlServer.stop(), runtimeServer.stop()]);
    if (goalExecutionServer) {
      try {
        await goalExecutionServer.stop();
      } catch {
        logger.error("coordinator_goal_execution_bridge_stop_failed", {
          code: "GOAL_EXECUTION_BRIDGE_STOP_FAILED",
        });
      }
    }
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
    if (autonomousDirector) await autonomousDirector.stop();
    aiScheduler?.close("coordinator shutdown");
    logger.info("coordinator_stopping", { signal });
    // Stop accepting new control/runtime work before draining durable delivery
    // and closing PostgreSQL. Existing leases are then recovered or handed off
    // by the bounded controllers without a new request racing shutdown.
    await Promise.allSettled([controlServer.stop(), runtimeServer.stop()]);
    if (goalExecutionServer) {
      try {
        await goalExecutionServer.stop();
      } catch {
        logger.error("coordinator_goal_execution_bridge_stop_failed", {
          code: "GOAL_EXECUTION_BRIDGE_STOP_FAILED",
        });
      }
    }
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

async function createTaskStateMachine(): Promise<Readonly<{
  stateMachine: PersistentTaskStateMachine;
  pool: PgTaskPoolAdapter | null;
}>> {
  const connectionString = process.env.COORDINATOR_TASK_POSTGRES_URL?.trim();
  if (!connectionString) {
    logger.warn("coordinator_task_persistence_unavailable", {
      durability: "process-local",
      code: "TASK_POSTGRES_NOT_CONFIGURED",
    });
    return {
      stateMachine: new PersistentTaskStateMachine(),
      pool: null,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("COORDINATOR_TASK_POSTGRES_URL is invalid.");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hash.length > 0
  ) {
    throw new Error("COORDINATOR_TASK_POSTGRES_URL is invalid.");
  }
  const schemaName = process.env.COORDINATOR_TASK_POSTGRES_SCHEMA?.trim() || "public";
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schemaName)) {
    throw new Error("COORDINATOR_TASK_POSTGRES_SCHEMA is invalid.");
  }
  const pool = new PgTaskPoolAdapter({
    connectionString,
    options: `-c search_path=${schemaName}`,
  });
  await pool.verifyConnection();
  const client = await pool.connect();
  try {
    await client.query("SELECT 1 FROM studio_task_executions LIMIT 0");
  } finally {
    client.release();
  }
  logger.info("coordinator_task_persistence_ready", {
    durability: "postgresql",
  });
  return {
    stateMachine: new PersistentTaskStateMachine({
      store: new PostgresTaskExecutionStore(pool),
    }),
    pool,
  };
}

void main().catch((cause: unknown) => {
  const code =
    cause instanceof RuntimeLinkConfigError ||
      cause instanceof ControlLinkConfigError ||
      cause instanceof LocalAIConfigError ||
      cause instanceof GoalPersistenceConfigError
      || cause instanceof TaskDeliveryConfigError ||
      cause instanceof AutonomousConfigError
      ? cause.code
      : "COORDINATOR_START_FAILED";
  logger.error("coordinator_start_failed", { code });
  process.exitCode = 1;
});
