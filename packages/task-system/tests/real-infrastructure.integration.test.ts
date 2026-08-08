import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Queue } from "bullmq";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  BullMqTaskQueue,
  bullMqTaskQueueConnectionOptions,
} from "../src/bullmq-queue.js";
import {
  BullMqTaskWorker,
  TaskHandlerRegistry,
} from "../src/bullmq-worker.js";
import {
  parseIsolatedTaskInfrastructureConfig,
  type IsolatedTaskInfrastructureConfig,
} from "../src/infrastructure-config.js";
import { PgTaskPoolAdapter } from "../src/pg-pool-adapter.js";
import { PostgresTaskRepository } from "../src/postgres-repository.js";
import type { TaskRecord } from "../src/model.js";

const runRealInfrastructure =
  process.env.RUN_REAL_TASK_INFRA_TEST === "1";
const describeReal = runRealInfrastructure ? describe : describe.skip;
const REAL_TEST_TIMEOUT_MS = 30_000;

const migrationFiles = [
  {
    path: fileURLToPath(
      new URL("../migrations/0001_task_system.sql", import.meta.url),
    ),
    sha256:
      "8a66af4a41c4a3d8d938e997ac5c96a3d3c644c3eec0b7d947f9b584a2bbfb3a",
  },
  {
    path: fileURLToPath(
      new URL(
        "../migrations/0002_task_lease_invariants.sql",
        import.meta.url,
      ),
    ),
    sha256:
      "5c1514a76f11b201e5eb95613441f77aaab49ce4e05da3182c21b173bb237a6c",
  },
  {
    path: fileURLToPath(
      new URL("../migrations/0003_task_delivery.sql", import.meta.url),
    ),
    sha256:
      "02429755277df4c7d6dbd32a6dc4769a305c8bad4cea559b1fbbf5151e3d2918",
  },
] as const;

function isolatedNamespace(input: string | undefined): string {
  if (
    !input ||
    !/^studio_test_[a-z0-9_]{8,48}$/u.test(input)
  ) {
    throw new Error(
      "TASK_INFRA_TEST_NAMESPACE must be a dedicated studio_test_ identifier.",
    );
  }
  return input;
}

function taskCreateCommand(
  taskType: string,
  timeoutMs = 5_000,
  maxRetries = 1,
  executionIdempotent = true,
) {
  const taskId = randomUUID();
  return {
    schemaVersion: "1.0" as const,
    operationId: randomUUID(),
    taskId,
    idempotencyScope: "real-task-infra-test",
    idempotencyKey: `task-${taskId}`,
    taskType,
    handlerVersion: "1.0.0",
    executionIdempotent,
    title: `Isolated ${taskType} task`,
    description:
      "Deterministic task used only by the isolated infrastructure test.",
    priority: 50,
    requiredSkills: [],
    requiredItems: [],
    target: null,
    dependencyIds: [],
    parentTaskId: null,
    deadline: null,
    timeoutMs,
    maxRetries,
    riskLevel: "R1" as const,
    traceId: `trace-${taskId}`,
    actorId: "integration-coordinator",
  };
}

function dispatchFor(task: TaskRecord) {
  return {
    schemaVersion: "1.0" as const,
    messageId: randomUUID(),
    traceId: task.traceId,
    timestamp: new Date().toISOString(),
    source: {
      service: "coordinator" as const,
      instanceId: "integration-coordinator",
    },
    taskId: task.taskId,
    botId: "isolated-test-bot",
    type: "task.dispatch.v1" as const,
    payload: {
      expectedRevision: task.revision,
      taskType: task.taskType,
      handlerVersion: task.handlerVersion,
      executionIdempotent: task.executionIdempotent,
    },
  };
}

async function waitForTask(
  repository: PostgresTaskRepository,
  taskId: string,
  predicate: (task: TaskRecord) => boolean,
  timeoutMs = 12_000,
): Promise<TaskRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await repository.getTask(taskId);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for a persisted task state.");
}

async function boundedCleanup(
  operation: Promise<unknown>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} cleanup timed out.`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describeReal.sequential(
  "real isolated PostgreSQL and Redis/BullMQ task infrastructure",
  () => {
    let config: IsolatedTaskInfrastructureConfig;
    let schemaName: string;
    let adminPool: Pool;
    let assertionPool: Pool;
    let poolAdapter: PgTaskPoolAdapter;
    let repository: PostgresTaskRepository;
    const queues: BullMqTaskQueue[] = [];
    const workers: BullMqTaskWorker[] = [];

    beforeAll(async () => {
      schemaName = isolatedNamespace(
        process.env.TASK_INFRA_TEST_NAMESPACE,
      );
      config = parseIsolatedTaskInfrastructureConfig({
        postgresUrl: process.env.TASK_POSTGRES_URL,
        redisUrl: process.env.TASK_REDIS_URL,
        queueName: "studio_tasks_v1",
        queuePrefix: schemaName,
      });
      adminPool = new Pool({ connectionString: config.postgresUrl });
      await adminPool.query(`CREATE SCHEMA "${schemaName}"`);

      const scopedPoolConfig = {
        connectionString: config.postgresUrl,
        options: `-c search_path=${schemaName}`,
      };
      assertionPool = new Pool(scopedPoolConfig);
      for (const migrationFile of migrationFiles) {
        const sql = await readFile(migrationFile.path, "utf8");
        expect(
          createHash("sha256").update(sql, "utf8").digest("hex"),
        ).toBe(migrationFile.sha256);
        await assertionPool.query(sql);
      }

      poolAdapter = new PgTaskPoolAdapter(scopedPoolConfig);
      await poolAdapter.verifyConnection();
      repository = new PostgresTaskRepository(poolAdapter);
    }, 30_000);

    afterAll(async () => {
      const cleanupErrors: unknown[] = [];
      const clean = async (
        operation: Promise<unknown>,
        label: string,
      ): Promise<void> => {
        try {
          await boundedCleanup(operation, label);
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      for (const worker of workers.reverse()) {
        await clean(worker.close(), "Worker");
      }
      for (const queue of queues.reverse()) {
        await clean(queue.close(), "Queue");
      }
      if (config) {
        const cleanupQueue = new Queue(config.queueName, {
          connection: bullMqTaskQueueConnectionOptions(config.redisUrl),
          prefix: config.queuePrefix,
        });
        await clean(
          cleanupQueue.obliterate({ force: true }),
          "Redis namespace",
        );
        await clean(cleanupQueue.close(), "Redis cleanup queue");
      }
      if (poolAdapter) {
        await clean(poolAdapter.close(), "PostgreSQL adapter");
      }
      if (assertionPool) {
        await clean(assertionPool.end(), "PostgreSQL assertion pool");
      }
      if (adminPool && schemaName) {
        await clean(
          adminPool.query(`DROP SCHEMA "${schemaName}" CASCADE`),
          "PostgreSQL test schema",
        );
        await clean(adminPool.end(), "PostgreSQL admin pool");
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "Isolated task infrastructure cleanup failed.",
        );
      }
    }, 30_000);

    function createQueue(): BullMqTaskQueue {
      const queue = new BullMqTaskQueue({
        redisUrl: config.redisUrl,
        queueName: config.queueName,
        prefix: config.queuePrefix,
      });
      queues.push(queue);
      return queue;
    }

    function createWorker(
      registry: TaskHandlerRegistry,
      instanceId: string,
    ): BullMqTaskWorker {
      const worker = new BullMqTaskWorker(repository, registry, {
        redisUrl: config.redisUrl,
        queueName: config.queueName,
        prefix: config.queuePrefix,
        instanceId,
        concurrency: 2,
        leaseDurationMs: 1_200,
        renewIntervalMs: 300,
        lockDurationMs: 2_500,
        stalledIntervalMs: 500,
      });
      workers.push(worker);
      return worker;
    }

    it("applies migrations and enforces append-only database triggers", async () => {
      const tables = await assertionPool.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_name`,
        [schemaName],
      );
      expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
        "studio_task_cancellation_requests",
        "studio_task_dependencies",
        "studio_task_history",
        "studio_task_outbox",
        "studio_tasks",
      ]);

      const created = await repository.createTask(
        taskCreateCommand("test.database-invariants"),
      );
      await expect(
        assertionPool.query(
          "DELETE FROM studio_tasks WHERE task_id = $1",
          [created.task.taskId],
        ),
      ).rejects.toThrow();
      await expect(
        assertionPool.query(
          `UPDATE studio_task_history
           SET reason_code = 'MUTATION_NOT_ALLOWED'
           WHERE task_id = $1`,
          [created.task.taskId],
        ),
      ).rejects.toThrow();
    }, REAL_TEST_TIMEOUT_MS);

    it("serializes operation replay and concurrent lease claims", async () => {
      const command = taskCreateCommand("test.concurrent-claim");
      const [first, second] = await Promise.all([
        repository.createTask(command),
        repository.createTask(command),
      ]);
      expect(first.task).toEqual(second.task);
      expect([first.created, second.created].sort()).toEqual([
        false,
        true,
      ]);

      const claims = await Promise.allSettled([
        repository.acquireLease({
          schemaVersion: "1.0",
          operationId: randomUUID(),
          taskId: first.task.taskId,
          expectedRevision: first.task.revision,
          actorId: "worker-a",
          botId: "isolated-bot-a",
          leaseOwner: "worker-a",
          leaseDurationMs: 3_000,
        }),
        repository.acquireLease({
          schemaVersion: "1.0",
          operationId: randomUUID(),
          taskId: first.task.taskId,
          expectedRevision: first.task.revision,
          actorId: "worker-b",
          botId: "isolated-bot-b",
          leaseOwner: "worker-b",
          leaseDurationMs: 3_000,
        }),
      ]);
      expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(
        1,
      );
      expect(claims.filter(({ status }) => status === "rejected")).toHaveLength(
        1,
      );
      const leased = await repository.getTask(first.task.taskId);
      expect(leased?.status).toBe("assigned");
      expect(["worker-a", "worker-b"]).toContain(leased?.leaseOwner);

      const taskCount = await assertionPool.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count
         FROM studio_tasks
         WHERE task_id = $1`,
        [first.task.taskId],
      );
      expect(taskCount.rows[0]?.count).toBe(1);
    }, REAL_TEST_TIMEOUT_MS);

    it("deduplicates dispatch and proves lease renewal before completion", async () => {
      const queue = createQueue();
      await queue.verifyConnection();
      const registry = new TaskHandlerRegistry();
      let releaseHandler: (() => void) | undefined;
      const handlerGate = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      registry.register({
        taskType: "test.worker-success",
        handlerVersion: "1.0.0",
        idempotent: true,
        execute: async ({ task, signal }) => {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () =>
              reject(new Error("Success handler unexpectedly aborted."));
            signal.addEventListener("abort", onAbort, { once: true });
            handlerGate.then(
              () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
              },
              reject,
            );
          });
          return {
            result: { completedBy: "deterministic-test-handler" },
            evidence: [
              {
                kind: "trace" as const,
                reference: task.traceId,
              },
            ],
          };
        },
      });
      const worker = createWorker(registry, "integration-worker-success");
      await worker.start();

      const task = (
        await repository.createTask(
          taskCreateCommand("test.worker-success"),
        )
      ).task;
      const dispatch = dispatchFor(task);
      expect(await queue.enqueue(dispatch)).toMatchObject({
        accepted: true,
      });
      const firstRunning = await waitForTask(
        repository,
        task.taskId,
        (candidate) => candidate.status === "running",
      );
      const renewed = await waitForTask(
        repository,
        task.taskId,
        (candidate) =>
          candidate.status === "running" &&
          candidate.revision > firstRunning.revision,
      );
      expect(Date.parse(renewed.leaseExpiresAt ?? "")).toBeGreaterThan(
        Date.parse(firstRunning.leaseExpiresAt ?? ""),
      );
      const renewalHistory = await assertionPool.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count
         FROM studio_task_history
         WHERE task_id = $1 AND event_type = 'task.lease-renewed'`,
        [task.taskId],
      );
      expect(renewalHistory.rows[0]?.count).toBeGreaterThanOrEqual(1);
      releaseHandler?.();
      const completed = await waitForTask(
        repository,
        task.taskId,
        (candidate) => candidate.status === "completed",
      );
      expect(completed.result).toEqual({
        completedBy: "deterministic-test-handler",
      });
      expect(await queue.enqueue(dispatch)).toMatchObject({
        accepted: true,
      });
      await worker.close();
    }, REAL_TEST_TIMEOUT_MS);

    it("acknowledges handler cancellation before persisting the terminal state", async () => {
      const queue = createQueue();
      const registry = new TaskHandlerRegistry();
      let observedAbort = false;
      registry.register({
        taskType: "test.worker-cancel",
        handlerVersion: "1.0.0",
        idempotent: true,
        execute: async ({ signal }) =>
          await new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(new Error("cancelled"));
              },
              { once: true },
            );
          }),
      });
      const worker = createWorker(registry, "integration-worker-cancel");
      await worker.start();

      const task = (
        await repository.createTask(
          taskCreateCommand("test.worker-cancel", 8_000),
        )
      ).task;
      await queue.enqueue(dispatchFor(task));
      const running = await waitForTask(
        repository,
        task.taskId,
        (candidate) => candidate.status === "running",
      );
      const cancelled = await worker.cancelTask({
        schemaVersion: "1.0",
        operationId: randomUUID(),
        taskId: running.taskId,
        actorId: "integration-canceller",
        reasonCode: "TASK_CANCELLED_BY_TEST",
      });
      expect(cancelled.status).toBe("cancelled");
      await waitForTask(
        repository,
        task.taskId,
        (candidate) => candidate.status === "cancelled",
      );
      await expect
        .poll(() => observedAbort, { timeout: 3_000 })
        .toBe(true);
      await worker.close();
    }, REAL_TEST_TIMEOUT_MS);

    it("waits for timeout acknowledgement and records a stable failed task", async () => {
      const queue = createQueue();
      const registry = new TaskHandlerRegistry();
      registry.register({
        taskType: "test.worker-timeout",
        handlerVersion: "1.0.0",
        idempotent: true,
        execute: async ({ signal }) =>
          await new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("timed out")),
              { once: true },
            );
          }),
      });
      const worker = createWorker(registry, "integration-worker-timeout");
      await worker.start();

      const task = (
        await repository.createTask(
          taskCreateCommand("test.worker-timeout", 1_100),
        )
      ).task;
      await queue.enqueue(dispatchFor(task));
      const failed = await waitForTask(
        repository,
        task.taskId,
        (candidate) => candidate.status === "failed",
      );
      expect(failed.failureReason).toBe("TASK_TIMEOUT_EXPIRED");
      expect(failed.leaseOwner).toBeNull();
      await worker.close();
    }, REAL_TEST_TIMEOUT_MS);

    it("releases the durable lease when a trusted handler ignores cancellation", async () => {
      const queue = createQueue();
      const registry = new TaskHandlerRegistry();
      registry.register({
        taskType: "test.worker-uncooperative-timeout",
        handlerVersion: "1.0.0",
        idempotent: true,
        execute: async () =>
          await new Promise(() => {
            // Deliberately never settles and ignores AbortSignal.
          }),
      });
      const worker = createWorker(
        registry,
        "integration-worker-uncooperative-timeout",
      );
      await worker.start();

      const task = (
        await repository.createTask(
          taskCreateCommand(
            "test.worker-uncooperative-timeout",
            1_100,
          ),
        )
      ).task;
      await queue.enqueue(dispatchFor(task));
      const failed = await waitForTask(
        repository,
        task.taskId,
        (candidate) => candidate.status === "failed",
      );
      expect(failed.failureReason).toBe("TASK_TIMEOUT_EXPIRED");
      expect(failed.leaseOwner).toBeNull();
      await boundedCleanup(worker.close(), "Uncooperative worker", 3_000);
    }, REAL_TEST_TIMEOUT_MS);

    it("persists deadline expiry when completion crosses the database boundary", async () => {
      const queue = createQueue();
      const registry = new TaskHandlerRegistry();
      registry.register({
        taskType: "test.worker-deadline",
        handlerVersion: "1.0.0",
        idempotent: true,
        execute: async () =>
          await new Promise(() => {
            // The worker must stop waiting when the deadline-clamped lease ends.
          }),
      });
      const worker = createWorker(registry, "integration-worker-deadline");
      await worker.start();

      const task = (
        await repository.createTask({
          ...taskCreateCommand("test.worker-deadline", 10_000),
          deadline: new Date(Date.now() + 2_000).toISOString(),
        })
      ).task;
      await queue.enqueue(dispatchFor(task));
      const expired = await waitForTask(
        repository,
        task.taskId,
        (candidate) => candidate.status === "expired",
      );
      expect(expired.failureReason).toBeNull();
      expect(expired.leaseOwner).toBeNull();
      await boundedCleanup(worker.close(), "Deadline worker", 3_000);
    }, REAL_TEST_TIMEOUT_MS);

    it("recovers an expired running lease after explicit BullMQ redelivery for an idempotent handler", async () => {
      const queue = createQueue();
      const firstRegistry = new TaskHandlerRegistry();
      firstRegistry.register({
        taskType: "test.worker-recovery",
        handlerVersion: "1.0.0",
        idempotent: true,
        execute: async ({ signal }) =>
          await new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("worker stopped")),
              { once: true },
            );
          }),
      });
      const firstWorker = createWorker(
        firstRegistry,
        "integration-worker-before-failure",
      );
      await firstWorker.start();

      const task = (
        await repository.createTask(
          taskCreateCommand("test.worker-recovery", 20_000, 1),
        )
      ).task;
      const dispatch = dispatchFor(task);
      await queue.enqueue(dispatch);
      await waitForTask(
        repository,
        task.taskId,
        (candidate) => candidate.status === "running",
      );
      await firstWorker.close();

      const queuedJob = await queue.getJob(
        task.taskId,
        dispatch.payload.expectedRevision,
      );
      expect(queuedJob).not.toBeNull();
      await expect
        .poll(async () => await queuedJob?.getState(), {
          timeout: 5_000,
        })
        .toBe("failed");
      await new Promise((resolve) => setTimeout(resolve, 1_300));

      const recoveryRegistry = new TaskHandlerRegistry();
      recoveryRegistry.register({
        taskType: "test.worker-recovery",
        handlerVersion: "1.0.0",
        idempotent: true,
        execute: async () => ({
          result: { recovered: true },
          evidence: [],
        }),
      });
      const recoveryWorker = createWorker(
        recoveryRegistry,
        "integration-worker-after-failure",
      );
      await recoveryWorker.start();
      await queuedJob?.retry("failed");

      const completed = await waitForTask(
        repository,
        task.taskId,
        (candidate) => candidate.status === "completed",
      );
      expect(completed.retryCount).toBe(1);
      expect(completed.result).toEqual({ recovered: true });
      await recoveryWorker.close();
    }, REAL_TEST_TIMEOUT_MS);

    it("rejects expired running-task redelivery for a non-idempotent handler", async () => {
      const queue = createQueue();
      const firstRegistry = new TaskHandlerRegistry();
      firstRegistry.register({
        taskType: "test.worker-non-idempotent",
        handlerVersion: "1.0.0",
        idempotent: false,
        execute: async ({ signal }) =>
          await new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("worker stopped")),
              { once: true },
            );
          }),
      });
      const firstWorker = createWorker(
        firstRegistry,
        "integration-worker-non-idempotent-before",
      );
      await firstWorker.start();

      const task = (
        await repository.createTask(
          taskCreateCommand(
            "test.worker-non-idempotent",
            20_000,
            1,
            false,
          ),
        )
      ).task;
      const dispatch = dispatchFor(task);
      await queue.enqueue(dispatch);
      await waitForTask(
        repository,
        task.taskId,
        (candidate) => candidate.status === "running",
      );
      await firstWorker.close();

      const queuedJob = await queue.getJob(
        task.taskId,
        dispatch.payload.expectedRevision,
      );
      expect(queuedJob).not.toBeNull();
      await expect
        .poll(async () => await queuedJob?.getState(), {
          timeout: 5_000,
        })
        .toBe("failed");
      await new Promise((resolve) => setTimeout(resolve, 1_300));

      const rejectingRegistry = new TaskHandlerRegistry();
      rejectingRegistry.register({
        taskType: "test.worker-non-idempotent",
        handlerVersion: "1.0.0",
        idempotent: false,
        execute: async () => ({
          result: { unsafe: true },
          evidence: [],
        }),
      });
      const rejectingWorker = createWorker(
        rejectingRegistry,
        "integration-worker-non-idempotent-after",
      );
      await rejectingWorker.start();
      await queuedJob?.retry("failed");
      await expect
        .poll(async () => await queuedJob?.getState(), {
          timeout: 5_000,
        })
        .toBe("failed");

      const rejected = await repository.getTask(task.taskId);
      expect(rejected?.status).toBe("failed");
      expect(rejected?.failureReason).toBe("TASK_LEASE_EXPIRED");
      expect(rejected?.retryCount).toBe(0);
      await rejectingWorker.close();
    }, REAL_TEST_TIMEOUT_MS);
  },
);
