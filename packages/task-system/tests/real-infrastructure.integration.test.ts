import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Queue } from "bullmq";
import { Pool, type PoolConfig } from "pg";
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
import { PostgresTaskExecutionStore } from "../src/postgres-task-execution-store.js";
import { TaskOutboxReconciler } from "../src/outbox-reconciler.js";
import {
  MAX_TASK_OUTBOX_ATTEMPTS,
  PostgresTaskRepository,
  type AcquireTaskAssignmentResult,
} from "../src/postgres-repository.js";
import {
  taskRecordSchema,
  type TaskRecord,
} from "../src/model.js";
import { PersistentTaskStateMachine } from "../src/task-fsm.js";

const runRealInfrastructure =
  process.env.RUN_REAL_TASK_INFRA_TEST === "1";
const describeReal = runRealInfrastructure ? describe : describe.skip;
const REAL_TEST_TIMEOUT_MS = 30_000;
const taskWorkerEntry = fileURLToPath(
  new URL("../../../apps/task-worker/dist/main.js", import.meta.url),
);

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
      "0c12859e03273ea6f3940cded8828989d7f82b6ed8208dfd40d31be1a29482b0",
  },
  {
    path: fileURLToPath(
      new URL(
        "../migrations/0004_task_delivery_hardening.sql",
        import.meta.url,
      ),
    ),
    sha256:
      "f4f5de71e67fbbd7037678127724ba5be6dbc939a6262f476dc35edd92f395f2",
  },
  {
    path: fileURLToPath(
      new URL("../migrations/0005_task_goal_input.sql", import.meta.url),
    ),
    sha256:
      "dd273906f80d672dde5f01ecf4b075fac5ebc385070e65be557b7bd46d99f472",
  },
  {
    path: fileURLToPath(
      new URL("../migrations/0006_task_execution_fsm.sql", import.meta.url),
    ),
    sha256:
      "a31a75eacc054473e0d10c5a766eadc32064ae80b6145eb0217843ab9bc636ff",
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

function taskSubmitCommand(taskType: string) {
  return {
    ...taskCreateCommand(taskType),
    dispatchBotId: "isolated-test-bot",
  };
}

function taskAssignmentCommand(
  task: Pick<TaskRecord, "taskId" | "revision">,
  input: Readonly<{
    botId: string;
    leaseOwner: string;
    actorId: string;
    operationId?: string;
    leaseDurationMs?: number;
    serverProfileId?: string;
    dimension?: string;
  }>,
) {
  return {
    schemaVersion: "1.0" as const,
    operationId: input.operationId ?? randomUUID(),
    taskId: task.taskId,
    expectedRevision: task.revision,
    actorId: input.actorId,
    botId: input.botId,
    leaseOwner: input.leaseOwner,
    leaseDurationMs: input.leaseDurationMs ?? 1_000,
    serverProfileId: input.serverProfileId ?? "isolated-local",
    dimension: input.dimension ?? "minecraft:overworld",
  };
}

function dispatchFor(
  task: Pick<
    TaskRecord,
    | "taskId"
    | "traceId"
    | "revision"
    | "taskType"
    | "handlerVersion"
    | "executionIdempotent"
  >,
) {
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

async function cancelQueuedTask(
  repository: PostgresTaskRepository,
  taskId: string,
): Promise<void> {
  await repository.cancelTask({
    schemaVersion: "1.0",
    operationId: randomUUID(),
    taskId,
    actorId: "integration-cleanup",
    leaseOwner: null,
    reasonCode: "TEST_TASK_CLEANUP",
  });
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

async function waitForTaskWorkerReady(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };
    const onData = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-8_192);
      if (output.includes('"event":"task_worker_started"')) {
        cleanup();
        resolve();
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Independent Task Worker exited before readiness."));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Independent Task Worker readiness timed out."));
    }, timeoutMs);
    timer.unref();
  });
}

async function stopTaskWorkerProcess(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Independent Task Worker shutdown timed out.")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function expectTaskWorkerProcessStopped(
  child: ChildProcess,
): Promise<void> {
  const exitCode = await stopTaskWorkerProcess(child);
  if (process.platform === "win32") {
    // Windows represents SIGTERM termination as a null exit code even when
    // the worker handled the signal and completed its graceful cleanup.
    expect([0, null]).toContain(exitCode);
    return;
  }
  expect(exitCode).toBe(0);
}

async function forceStopTaskWorkerProcess(
  child: ChildProcess,
  timeoutMs = 2_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer: NodeJS.Timeout | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGKILL");
  try {
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Independent Task Worker force-stop timed out.")),
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
    let scopedPoolConfig: PoolConfig;
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

      scopedPoolConfig = {
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

    it("upgrades an applied 0003 schema without orphaning legacy outbox rows", async () => {
      const upgradeSchema = `${schemaName}_upgrade`;
      await adminPool.query(`CREATE SCHEMA "${upgradeSchema}"`);
      const upgradePoolConfig = {
        connectionString: config.postgresUrl,
        options: `-c search_path=${upgradeSchema}`,
      };
      const upgradePool = new Pool(upgradePoolConfig);
      try {
        for (const migrationFile of migrationFiles.slice(0, 3)) {
          const sql = await readFile(migrationFile.path, "utf8");
          await upgradePool.query(sql);
        }
        const blocked = {
          ...taskCreateCommand("test.upgrade-invalid-blocked"),
          revision: 0,
        };
        const expiresLater = {
          ...taskCreateCommand("test.upgrade-invalid-expired"),
          deadline: new Date(Date.now() + 60_000).toISOString(),
          revision: 0,
        };
        const expired = expiresLater;
        const numericRevision = {
          ...taskCreateCommand("test.upgrade-numeric-revision"),
          revision: 0,
        };
        for (const task of [blocked, expired, numericRevision]) {
          const requestFingerprint = createHash("sha256")
            .update(JSON.stringify(task), "utf8")
            .digest("hex");
          await upgradePool.query(
            `INSERT INTO studio_tasks (
               task_id, schema_version, idempotency_scope, idempotency_key,
               request_fingerprint, task_type, handler_version,
               execution_idempotent, title, description, priority, status,
               dispatch_bot_id, assigned_bot_id, required_skills,
               required_items, target, parent_task_id, deadline, timeout_ms,
               retry_count, max_retries, lease_owner, lease_expires_at,
               risk_level, failure_reason, result, evidence, trace_id,
               revision, created_at, updated_at, started_at, finished_at
             ) VALUES (
               $1, '1.0', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued',
               NULL, NULL, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15,
               $16, 0, $17, NULL, NULL, $18, NULL, NULL, '[]'::jsonb,
               $19, 0, clock_timestamp(), clock_timestamp(), NULL, NULL
             )`,
            [
              task.taskId,
              task.idempotencyScope,
              task.idempotencyKey,
              requestFingerprint,
              task.taskType,
              task.handlerVersion,
              task.executionIdempotent,
              task.title,
              task.description,
              task.priority,
              JSON.stringify(task.requiredSkills),
              JSON.stringify(task.requiredItems),
              JSON.stringify(task.target),
              task.parentTaskId,
              task.deadline,
              task.timeoutMs,
              task.maxRetries,
              task.riskLevel,
              task.traceId,
            ],
          );
        }
        await upgradePool.query(
          `UPDATE studio_tasks
           SET deadline = CASE WHEN task_id = $1
             THEN clock_timestamp() - interval '1 second'
             ELSE deadline
           END,
               dispatch_bot_id = CASE WHEN task_id = $2
                 THEN 'isolated-test-bot'
                 ELSE dispatch_bot_id
               END
           WHERE task_id IN ($1, $2)`,
          [expired.taskId, numericRevision.taskId],
        );
        const blockedMessageId = randomUUID();
        const expiredMessageId = randomUUID();
        for (const [messageId, task] of [
          [blockedMessageId, blocked],
          [expiredMessageId, expired],
        ] as const) {
          await upgradePool.query(
            `INSERT INTO studio_task_outbox (
               message_id, task_id, expected_revision, type, payload,
               available_at, created_at, updated_at
             ) VALUES (
               $1, $2, $3, 'task.dispatch.v1', '{}'::jsonb,
               clock_timestamp(), clock_timestamp(), clock_timestamp()
             )`,
            [messageId, task.taskId, task.revision],
          );
        }
        const hardeningSql = await readFile(migrationFiles[3].path, "utf8");
        await upgradePool.query(hardeningSql);

        // 0003 casts the JSON revision text directly to bigint and therefore
        // cannot contain 0.0. Verify 0004's numeric-equivalence contract only
        // after hardening instead of seeding an impossible legacy row.
        const numericMessage = dispatchFor(numericRevision);
        const numericPayload = JSON.stringify(numericMessage).replace(
          '"expectedRevision":0',
          '"expectedRevision":0.0',
        );
        expect(numericPayload).toContain('"expectedRevision":0.0');
        await upgradePool.query(
          `INSERT INTO studio_task_outbox (
             message_id, task_id, expected_revision, type, payload,
             available_at, created_at, updated_at
           ) VALUES (
             $1, $2, 0, 'task.dispatch.v1', $3::jsonb,
             clock_timestamp(), clock_timestamp(), clock_timestamp()
           )`,
          [numericMessage.messageId, numericRevision.taskId, numericPayload],
        );

        const upgradedTasks = await upgradePool.query<{
          task_id: string;
          status: string;
          revision: number;
          failure_reason: string | null;
          finished_at: Date | null;
        }>(
        `SELECT task_id::text, status, revision::integer AS revision, failure_reason, finished_at
           FROM studio_tasks
           WHERE task_id IN ($1, $2, $3)`,
          [blocked.taskId, expired.taskId, numericRevision.taskId],
        );
        const byTaskId = new Map(
          upgradedTasks.rows.map((task) => [task.task_id, task]),
        );
        expect(byTaskId.get(blocked.taskId)).toMatchObject({
          status: "blocked",
          revision: 1,
          failure_reason: "TASK_OUTBOX_RECORD_INVALID",
          finished_at: null,
        });
        expect(byTaskId.get(expired.taskId)).toMatchObject({
          status: "expired",
          revision: 1,
          failure_reason: "TASK_OUTBOX_RECORD_INVALID",
        });
        expect(byTaskId.get(expired.taskId)?.finished_at).not.toBeNull();
        expect(byTaskId.get(numericRevision.taskId)).toMatchObject({
          status: "queued",
          revision: 0,
          failure_reason: null,
        });

        const upgradedOutbox = await upgradePool.query<{
          message_id: string;
          status: string;
          last_error: string | null;
        }>(
          `SELECT message_id::text, status, last_error
           FROM studio_task_outbox
           WHERE message_id IN ($1, $2, $3)`,
          [blockedMessageId, expiredMessageId, numericMessage.messageId],
        );
        const byMessageId = new Map(
          upgradedOutbox.rows.map((entry) => [entry.message_id, entry]),
        );
        expect(byMessageId.get(blockedMessageId)).toMatchObject({
          status: "failed",
          last_error: "TASK_OUTBOX_RECORD_INVALID",
        });
        expect(byMessageId.get(expiredMessageId)).toMatchObject({
          status: "failed",
          last_error: "TASK_OUTBOX_RECORD_INVALID",
        });
        expect(byMessageId.get(numericMessage.messageId)).toMatchObject({
          status: "pending",
          last_error: null,
        });

        const migrationHistory = await upgradePool.query<{
          event_type: string;
          task_snapshot: unknown;
        }>(
          `SELECT event_type, task_snapshot
           FROM studio_task_history
           WHERE operation_id IN ($1, $2)
           ORDER BY event_type`,
          [blockedMessageId, expiredMessageId],
        );
        expect(migrationHistory.rows.map(({ event_type }) => event_type)).toEqual([
          "task.dispatch-blocked",
          "task.dispatch-expired",
        ]);
        for (const { task_snapshot } of migrationHistory.rows) {
          expect(taskRecordSchema.safeParse(task_snapshot).success).toBe(true);
        }
      } finally {
        await upgradePool.end();
        await adminPool.query(`DROP SCHEMA "${upgradeSchema}" CASCADE`);
      }
    }, REAL_TEST_TIMEOUT_MS);

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
        "studio_task_executions",
        "studio_task_history",
        "studio_task_outbox",
        "studio_tasks",
      ]);

      await expect(
        repository.verifyGoalLifecycleSchema(),
      ).resolves.toBeUndefined();
      const lifecycleInput = {
        schemaVersion: "1.0",
        kind: "coordinator.goal.v1",
        operationId: randomUUID(),
      };
      const created = await repository.createTask({
        ...taskCreateCommand("test.database-invariants"),
        input: lifecycleInput,
      });
      await expect(
        repository.getTask(created.task.taskId),
      ).resolves.toMatchObject({ input: lifecycleInput });
      await expect(
        repository.listTaskLifecycle({
          taskType: "test.database-invariants",
          terminalUpdatedAfter: new Date(0).toISOString(),
          limit: 1,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          taskId: created.task.taskId,
          input: lifecycleInput,
        }),
      ]);
      await expect(
        assertionPool.query(
          "UPDATE studio_tasks SET task_input = $2::jsonb WHERE task_id = $1",
          [
            created.task.taskId,
            JSON.stringify({ payload: "x".repeat(65 * 1_024) }),
          ],
        ),
      ).rejects.toThrow();
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

    it("restores persistent execution FSM progress after a runtime restart", async () => {
      const task = (
        await repository.createTask(
          taskCreateCommand("test.persistent-execution-fsm"),
        )
      ).task;
      const store = new PostgresTaskExecutionStore(poolAdapter);
      const firstRuntime = new PersistentTaskStateMachine({ store });
      await firstRuntime.create({
        taskId: task.taskId,
        botId: "isolated-test-bot",
        goal: "Acquire a wooden pickaxe",
      });
      await firstRuntime.transition(task.taskId, "PLAN", {
        currentStep: "expand recipe dependencies",
        worldStateVersion: 2,
      });

      const restartedRuntime = new PersistentTaskStateMachine({ store });
      expect(await restartedRuntime.restore(task.taskId)).toMatchObject({
        taskId: task.taskId,
        state: "PLAN",
        currentStep: "expand recipe dependencies",
        worldStateVersion: 2,
        revision: 1,
      });
    }, REAL_TEST_TIMEOUT_MS);

    it("rolls back task and history when the transactional outbox insert fails", async () => {
      const command = taskSubmitCommand("test.outbox-atomic-rollback");
      await assertionPool.query(
        `CREATE OR REPLACE FUNCTION studio_test_reject_outbox_insert()
         RETURNS trigger
         LANGUAGE plpgsql
         AS $$
         BEGIN
           RAISE EXCEPTION 'injected outbox insert failure';
         END;
         $$`,
      );
      await assertionPool.query(
        `CREATE TRIGGER studio_test_outbox_insert_failure
         BEFORE INSERT ON studio_task_outbox
         FOR EACH ROW EXECUTE FUNCTION studio_test_reject_outbox_insert()`,
      );
      try {
        await expect(repository.submitTask(command)).rejects.toThrow();
      } finally {
        await assertionPool.query(
          `DROP TRIGGER studio_test_outbox_insert_failure
           ON studio_task_outbox`,
        );
        await assertionPool.query(
          "DROP FUNCTION studio_test_reject_outbox_insert()",
        );
      }
      const persisted = await assertionPool.query<{
        task_count: number;
        history_count: number;
        outbox_count: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::integer FROM studio_tasks
             WHERE task_id = $1) AS task_count,
           (SELECT COUNT(*)::integer FROM studio_task_history
             WHERE task_id = $1) AS history_count,
           (SELECT COUNT(*)::integer FROM studio_task_outbox
             WHERE task_id = $1) AS outbox_count`,
        [command.taskId],
      );
      expect(persisted.rows[0]).toEqual({
        task_count: 0,
        history_count: 0,
        outbox_count: 0,
      });
    }, REAL_TEST_TIMEOUT_MS);

    it("rejects missing identities and fail-closes invalid protocol payloads", async () => {
      const task = (
        await repository.createTask(
          taskCreateCommand("test.outbox-invalid-payload"),
        )
      ).task;
      await expect(
        assertionPool.query(
          `INSERT INTO studio_task_outbox (
             message_id, task_id, expected_revision, type, payload,
             available_at, created_at, updated_at
           ) VALUES (
             $1, $2, $3, 'task.dispatch.v1', $4::jsonb,
             clock_timestamp(), clock_timestamp(), clock_timestamp()
           )`,
          [randomUUID(), task.taskId, task.revision, JSON.stringify({})],
        ),
      ).rejects.toThrow();

      const invalidMessageId = randomUUID();
      const invalidPayload = {
        schemaVersion: "1.0",
        messageId: invalidMessageId,
        taskId: task.taskId,
        type: "task.dispatch.v1",
        payload: { expectedRevision: task.revision },
      };
      await assertionPool.query(
        `INSERT INTO studio_task_outbox (
           message_id, task_id, expected_revision, type, payload,
           available_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'task.dispatch.v1', $4::jsonb,
           clock_timestamp(), clock_timestamp(), clock_timestamp()
         )`,
        [
          invalidMessageId,
          task.taskId,
          task.revision,
          JSON.stringify(invalidPayload),
        ],
      );
      const expiringCommand = {
        ...taskCreateCommand("test.outbox-invalid-payload-expired"),
        deadline: new Date(Date.now() + 60_000).toISOString(),
      };
      const expiredTask = (
        await repository.createTask(expiringCommand)
      ).task;
      const expiredMessageId = randomUUID();
      await assertionPool.query(
        `UPDATE studio_tasks
         SET deadline = clock_timestamp() - interval '1 second'
         WHERE task_id = $1`,
        [expiredTask.taskId],
      );
      await assertionPool.query(
        `INSERT INTO studio_task_outbox (
           message_id, task_id, expected_revision, type, payload,
           available_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'task.dispatch.v1', $4::jsonb,
           clock_timestamp(), clock_timestamp(), clock_timestamp()
         )`,
        [
          expiredMessageId,
          expiredTask.taskId,
          expiredTask.revision,
          JSON.stringify({
            ...invalidPayload,
            messageId: expiredMessageId,
            taskId: expiredTask.taskId,
          }),
        ],
      );

      await expect(
        repository.claimTaskOutbox({
          claimerId: "invalid-record-quarantine",
          leaseDurationMs: 1_000,
        }),
      ).resolves.toEqual([]);
      const quarantined = await assertionPool.query<{
        message_id: string;
        status: string;
        attempt_count: number;
        last_error: string | null;
      }>(
        `SELECT message_id::text, status, attempt_count, last_error
         FROM studio_task_outbox
         WHERE message_id IN ($1, $2)
         ORDER BY message_id`,
        [invalidMessageId, expiredMessageId],
      );
      expect(quarantined.rows).toHaveLength(2);
      for (const entry of quarantined.rows) {
        expect(entry).toMatchObject({
          status: "failed",
          attempt_count: 0,
          last_error: "TASK_OUTBOX_RECORD_INVALID",
        });
      }
      await expect(
        repository.getTaskOutbox(task.taskId, task.revision),
      ).resolves.toBeNull();
      await expect(
        repository.getTaskOutboxFailure(task.taskId, task.revision),
      ).resolves.toMatchObject({
        messageId: invalidMessageId,
        status: "failed",
        lastError: "TASK_OUTBOX_RECORD_INVALID",
        payload: invalidPayload,
      });
      await expect(repository.getTask(task.taskId)).resolves.toMatchObject({
        status: "blocked",
        revision: 1,
        failureReason: "TASK_OUTBOX_RECORD_INVALID",
        finishedAt: null,
      });
      await expect(repository.getTask(expiredTask.taskId)).resolves.toMatchObject({
        status: "expired",
        revision: 1,
        failureReason: "TASK_OUTBOX_RECORD_INVALID",
      });
      const quarantineHistory = await assertionPool.query<{
        event_type: string;
        to_status: string;
      }>(
        `SELECT event_type, to_status
         FROM studio_task_history
         WHERE operation_id IN ($1, $2)
         ORDER BY event_type`,
        [invalidMessageId, expiredMessageId],
      );
      expect(quarantineHistory.rows).toEqual([
        {
          event_type: "task.dispatch-blocked",
          to_status: "blocked",
        },
        {
          event_type: "task.dispatch-expired",
          to_status: "expired",
        },
      ]);
      await cancelQueuedTask(repository, task.taskId);
    }, REAL_TEST_TIMEOUT_MS);

    it("atomically submits and reconciles one durable dispatch across competing instances", async () => {
      const queue = createQueue();
      await queue.verifyConnection();
      const submitted = await repository.submitTask(
        taskSubmitCommand("test.outbox-delivery"),
      );
      const firstRunner = new TaskOutboxReconciler({
        repository,
        queue,
        instanceId: "integration-reconciler-a",
      });
      const secondRunner = new TaskOutboxReconciler({
        repository,
        queue,
        instanceId: "integration-reconciler-b",
      });

      const firstPass = await Promise.all([
        firstRunner.reconcileOnce(),
        secondRunner.reconcileOnce(),
      ]);
      expect(
        firstPass.reduce(
          (total, result) => ({
            claimed: total.claimed + result.claimed,
            enqueued: total.enqueued + result.enqueued,
            skipped: total.skipped + result.skipped,
            failed: total.failed + result.failed,
          }),
          { claimed: 0, enqueued: 0, skipped: 0, failed: 0 },
        ),
      ).toEqual({ claimed: 1, enqueued: 1, skipped: 0, failed: 0 });
      const firstJob = await queue.getJob(
        submitted.task.taskId,
        submitted.task.revision,
      );
      expect(firstJob).not.toBeNull();
      expect(await firstJob?.getState()).toBe("waiting");
      expect(firstJob?.data.messageId).toBe(submitted.outbox.messageId);

      const delivered = await repository.getTaskOutbox(
        submitted.task.taskId,
        submitted.task.revision,
      );
      expect(delivered).toMatchObject({
        messageId: submitted.outbox.messageId,
        status: "delivered",
        attemptCount: 0,
      });
      await expect(
        assertionPool.query(
          `UPDATE studio_task_outbox
           SET payload = payload || '{"botId":"tampered-bot"}'::jsonb
           WHERE message_id = $1`,
          [submitted.outbox.messageId],
        ),
      ).rejects.toThrow();

      expect(
        await queue.remove(submitted.task.taskId, submitted.task.revision),
      ).toBe(true);
      await assertionPool.query(
        `UPDATE studio_task_outbox
         SET available_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE message_id = $1`,
        [submitted.outbox.messageId],
      );
      const replayPass = await Promise.all([
        firstRunner.reconcileOnce(),
        secondRunner.reconcileOnce(),
      ]);
      expect(
        replayPass.reduce(
          (total, result) => ({
            claimed: total.claimed + result.claimed,
            enqueued: total.enqueued + result.enqueued,
            skipped: total.skipped + result.skipped,
            failed: total.failed + result.failed,
          }),
          { claimed: 0, enqueued: 0, skipped: 0, failed: 0 },
        ),
      ).toEqual({ claimed: 1, enqueued: 1, skipped: 0, failed: 0 });
      const replayed = await repository.getTaskOutbox(
        submitted.task.taskId,
        submitted.task.revision,
      );
      expect(replayed).toMatchObject({
        messageId: submitted.outbox.messageId,
        status: "delivered",
        attemptCount: 0,
      });
      expect(
        await queue.getJob(submitted.task.taskId, submitted.task.revision),
      ).not.toBeNull();
      expect(
        await queue.remove(submitted.task.taskId, submitted.task.revision),
      ).toBe(true);
      await cancelQueuedTask(repository, submitted.task.taskId);
    }, REAL_TEST_TIMEOUT_MS);

    it("completes a deterministic task through submit, outbox, reconciler, BullMQ, and Worker", async () => {
      const queue = createQueue();
      await queue.verifyConnection();
      const registry = new TaskHandlerRegistry();
      registry.register({
        taskType: "isolated.acceptance.digest",
        handlerVersion: "1.0.0",
        idempotent: true,
        execute: async ({ task, signal }) => {
          if (signal.aborted) throw new Error("digest cancelled");
          const input = task.input as {
            schemaVersion?: unknown;
            value?: unknown;
          };
          if (
            input?.schemaVersion !== "1.0" ||
            !Object.prototype.hasOwnProperty.call(input, "value")
          ) {
            throw new Error("invalid digest input");
          }
          const serialized = JSON.stringify(input.value);
          return {
            result: {
              schemaVersion: "1.0",
              kind: "isolated.acceptance.digest.v1",
              sha256: createHash("sha256")
                .update(serialized, "utf8")
                .digest("hex"),
              byteLength: Buffer.byteLength(serialized, "utf8"),
            },
            evidence: [{ kind: "trace" as const, reference: task.traceId }],
          };
        },
      });
      const worker = createWorker(registry, "integration-worker-outbox-e2e");
      try {
        await worker.start();
        const input = {
          schemaVersion: "1.0" as const,
          value: { operation: "digest", count: 2 },
        };
        const submitted = await repository.submitTask({
          ...taskSubmitCommand("isolated.acceptance.digest"),
          input,
        });
        const reconciler = new TaskOutboxReconciler({
          repository,
          queue,
          instanceId: "integration-outbox-e2e-reconciler",
        });
        await expect(reconciler.reconcileOnce()).resolves.toEqual({
          claimed: 1,
          enqueued: 1,
          skipped: 0,
          failed: 0,
        });
        await expect(
          repository.getTaskOutbox(
            submitted.task.taskId,
            submitted.task.revision,
          ),
        ).resolves.toMatchObject({
          status: "delivered",
          messageId: submitted.outbox.messageId,
        });
        const completed = await waitForTask(
          repository,
          submitted.task.taskId,
          (candidate) => candidate.status === "completed",
        );
        const persistedInput = completed.input as typeof input;
        const serialized = JSON.stringify(persistedInput.value);
        expect(completed.result).toEqual({
          schemaVersion: "1.0",
          kind: "isolated.acceptance.digest.v1",
          sha256: createHash("sha256")
            .update(serialized, "utf8")
            .digest("hex"),
          byteLength: Buffer.byteLength(serialized, "utf8"),
        });
        expect(completed.evidence).toEqual([
          { kind: "trace", reference: completed.traceId },
        ]);
      } finally {
        try {
          await worker.close();
        } finally {
          await queue.close();
        }
      }
    }, REAL_TEST_TIMEOUT_MS);

    it("records a failed queue delivery and resets its consecutive budget after recovery", async () => {
      const submitted = await repository.submitTask(
        taskSubmitCommand("test.outbox-reconciler-recovery"),
      );
      const failingRunner = new TaskOutboxReconciler({
        repository,
        queue: {
          enqueue: async () => {
            throw new Error("Injected Redis delivery failure");
          },
          getJob: async () => null,
          remove: async () => false,
        },
        instanceId: "integration-reconciler-failing-queue",
        retryBaseMs: 10,
        retryMaxMs: 100,
      });
      await expect(failingRunner.reconcileOnce()).resolves.toEqual({
        claimed: 1,
        enqueued: 0,
        skipped: 0,
        failed: 1,
      });
      await expect(
        repository.getTaskOutbox(
          submitted.task.taskId,
          submitted.task.revision,
        ),
      ).resolves.toMatchObject({
        status: "pending",
        attemptCount: 1,
        lastError: "Injected Redis delivery failure",
      });

      await assertionPool.query(
        `UPDATE studio_task_outbox
         SET available_at = clock_timestamp()
         WHERE message_id = $1`,
        [submitted.outbox.messageId],
      );
      const queue = createQueue();
      await queue.verifyConnection();
      const recoveryRunner = new TaskOutboxReconciler({
        repository,
        queue,
        instanceId: "integration-reconciler-recovered-queue",
      });
      await expect(recoveryRunner.reconcileOnce()).resolves.toEqual({
        claimed: 1,
        enqueued: 1,
        skipped: 0,
        failed: 0,
      });
      await expect(
        repository.getTaskOutbox(
          submitted.task.taskId,
          submitted.task.revision,
        ),
      ).resolves.toMatchObject({
        status: "delivered",
        attemptCount: 0,
        lastError: null,
      });
      expect(
        await queue.remove(submitted.task.taskId, submitted.task.revision),
      ).toBe(true);
      await cancelQueuedTask(repository, submitted.task.taskId);
    }, REAL_TEST_TIMEOUT_MS);

    it("quarantines a contract mismatch without rolling back a valid sibling claim", async () => {
      const mismatchedTask = (
        await repository.createTask(
          taskCreateCommand("test.outbox-contract-mismatch"),
        )
      ).task;
      await assertionPool.query(
        `UPDATE studio_tasks
         SET dispatch_bot_id = 'expected-isolated-bot'
         WHERE task_id = $1`,
        [mismatchedTask.taskId],
      );
      const mismatchedDispatch = {
        ...dispatchFor(mismatchedTask),
        botId: "wrong-isolated-bot",
      };
      await assertionPool.query(
        `INSERT INTO studio_task_outbox (
           message_id, task_id, expected_revision, type, payload,
           available_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'task.dispatch.v1', $4::jsonb,
           clock_timestamp(), clock_timestamp(), clock_timestamp()
         )`,
        [
          mismatchedDispatch.messageId,
          mismatchedTask.taskId,
          mismatchedTask.revision,
          JSON.stringify(mismatchedDispatch),
        ],
      );
      const validSibling = await repository.submitTask(
        taskSubmitCommand("test.outbox-valid-sibling"),
      );

      const claimed = await repository.claimTaskOutbox({
        claimerId: "integration-reconciler-mixed-batch",
        limit: 2,
        leaseDurationMs: 1_000,
      });
      expect(claimed.map(({ messageId }) => messageId)).toEqual([
        validSibling.outbox.messageId,
      ]);
      await expect(
        repository.getTaskOutboxFailure(
          mismatchedTask.taskId,
          mismatchedTask.revision,
        ),
      ).resolves.toMatchObject({
        messageId: mismatchedDispatch.messageId,
        lastError: "TASK_OUTBOX_TASK_CONTRACT_MISMATCH",
      });
      await expect(repository.getTask(mismatchedTask.taskId)).resolves.toMatchObject({
        status: "blocked",
        revision: 1,
        failureReason: "TASK_OUTBOX_TASK_CONTRACT_MISMATCH",
      });
      await expect(
        repository.markTaskOutboxDelivered({
          messageId: validSibling.outbox.messageId,
          claimerId: "integration-reconciler-mixed-batch",
        }),
      ).resolves.toBe(true);
      await cancelQueuedTask(repository, mismatchedTask.taskId);
      await cancelQueuedTask(repository, validSibling.task.taskId);
    }, REAL_TEST_TIMEOUT_MS);

    it("reclaims an expired delivery claim without incrementing failures", async () => {
      const submitted = await repository.submitTask(
        taskSubmitCommand("test.outbox-expired-claim"),
      );
      const firstClaim = await repository.claimTaskOutbox({
        claimerId: "integration-reconciler-before-crash",
        limit: 1,
        leaseDurationMs: 1_000,
      });
      expect(firstClaim).toHaveLength(1);
      expect(firstClaim[0]).toMatchObject({
        messageId: submitted.outbox.messageId,
        attemptCount: 0,
      });
      await assertionPool.query(
        `UPDATE studio_task_outbox
         SET attempt_count = 7,
             claim_expires_at = clock_timestamp() - interval '1 second'
         WHERE message_id = $1`,
        [submitted.outbox.messageId],
      );

      const recovered = await repository.claimTaskOutbox({
        claimerId: "integration-reconciler-after-crash",
        limit: 1,
        leaseDurationMs: 1_000,
      });
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        messageId: submitted.outbox.messageId,
        attemptCount: 7,
        claimedBy: "integration-reconciler-after-crash",
      });
      await expect(
        repository.markTaskOutboxDelivered({
          messageId: submitted.outbox.messageId,
          claimerId: "integration-reconciler-after-crash",
        }),
      ).resolves.toBe(true);
      await expect(
        repository.getTaskOutbox(
          submitted.task.taskId,
          submitted.task.revision,
        ),
      ).resolves.toMatchObject({
        status: "delivered",
        attemptCount: 0,
      });
      await cancelQueuedTask(repository, submitted.task.taskId);
    }, REAL_TEST_TIMEOUT_MS);

    it("dead-letters an exhausted delivery without starving later messages", async () => {
      const exhausted = await repository.submitTask(
        taskSubmitCommand("test.outbox-retry-exhausted"),
      );
      const claim = await repository.claimTaskOutbox({
        claimerId: "integration-reconciler-exhausted",
        limit: 1,
        leaseDurationMs: 1_000,
      });
      expect(claim[0]?.messageId).toBe(exhausted.outbox.messageId);
      await assertionPool.query(
        `UPDATE studio_task_outbox
         SET attempt_count = $2
         WHERE message_id = $1`,
        [exhausted.outbox.messageId, MAX_TASK_OUTBOX_ATTEMPTS - 1],
      );
      await expect(
        repository.retryTaskOutbox({
          messageId: exhausted.outbox.messageId,
          claimerId: "integration-reconciler-exhausted",
          error: "Redis unavailable at retry ceiling",
          delayMs: 0,
        }),
      ).resolves.toBe(true);
      await expect(
        repository.getTaskOutbox(
          exhausted.task.taskId,
          exhausted.task.revision,
        ),
      ).resolves.toMatchObject({
        status: "failed",
        attemptCount: MAX_TASK_OUTBOX_ATTEMPTS,
        lastError: "Redis unavailable at retry ceiling",
      });
      await expect(repository.getTask(exhausted.task.taskId)).resolves.toMatchObject({
        status: "blocked",
        revision: 1,
        failureReason: "TASK_OUTBOX_DELIVERY_EXHAUSTED",
      });
      const exhaustionHistory = await assertionPool.query<{
        event_type: string;
        to_status: string;
        reason_code: string;
      }>(
        `SELECT event_type, to_status, reason_code
         FROM studio_task_history
         WHERE operation_id = $1`,
        [exhausted.outbox.messageId],
      );
      expect(exhaustionHistory.rows[0]).toEqual({
        event_type: "task.dispatch-blocked",
        to_status: "blocked",
        reason_code: "TASK_OUTBOX_DELIVERY_EXHAUSTED",
      });
      const retryCommand = {
        schemaVersion: "1.0" as const,
        operationId: randomUUID(),
        taskId: exhausted.task.taskId,
        expectedRevision: 1,
        actorId: "integration-operator",
        reasonCode: "TASK_OUTBOX_OPERATOR_RETRY",
      };
      const retried = await repository.retryTaskDispatch(retryCommand);
      expect(retried).toMatchObject({
        task: {
          status: "queued",
          revision: 2,
          failureReason: null,
        },
        outbox: {
          taskId: exhausted.task.taskId,
          expectedRevision: 2,
          status: "pending",
          attemptCount: 0,
        },
        dispatch: {
          botId: exhausted.task.dispatchBotId,
          payload: { expectedRevision: 2 },
        },
      });
      await expect(
        repository.retryTaskDispatch(retryCommand),
      ).resolves.toEqual(retried);
      const retryClaim = await repository.claimTaskOutbox({
        claimerId: "integration-reconciler-operator-retry",
        limit: 1,
        leaseDurationMs: 1_000,
      });
      expect(retryClaim[0]?.messageId).toBe(retried.outbox.messageId);
      await expect(
        repository.markTaskOutboxDelivered({
          messageId: retried.outbox.messageId,
          claimerId: "integration-reconciler-operator-retry",
        }),
      ).resolves.toBe(true);
      await cancelQueuedTask(repository, exhausted.task.taskId);

      const expiresLater = {
        ...taskSubmitCommand("test.outbox-retry-exhausted-expired"),
        deadline: new Date(Date.now() + 60_000).toISOString(),
      };
      const expired = await repository.submitTask(expiresLater);
      const expiredClaim = await repository.claimTaskOutbox({
        claimerId: "integration-reconciler-exhausted-expired",
        limit: 1,
        leaseDurationMs: 1_000,
      });
      expect(expiredClaim[0]?.messageId).toBe(expired.outbox.messageId);
      await assertionPool.query(
        `UPDATE studio_tasks
         SET deadline = clock_timestamp() - interval '1 second'
         WHERE task_id = $1`,
        [expired.task.taskId],
      );
      await assertionPool.query(
        `UPDATE studio_task_outbox
         SET attempt_count = $2
         WHERE message_id = $1`,
        [expired.outbox.messageId, MAX_TASK_OUTBOX_ATTEMPTS - 1],
      );
      await expect(
        repository.retryTaskOutbox({
          messageId: expired.outbox.messageId,
          claimerId: "integration-reconciler-exhausted-expired",
          error: "Redis unavailable after task deadline",
          delayMs: 0,
        }),
      ).resolves.toBe(true);
      await expect(repository.getTask(expired.task.taskId)).resolves.toMatchObject({
        status: "expired",
        revision: 1,
        failureReason: "TASK_OUTBOX_DELIVERY_EXHAUSTED",
      });

      const later = await repository.submitTask(
        taskSubmitCommand("test.outbox-after-dead-letter"),
      );
      const laterClaim = await repository.claimTaskOutbox({
        claimerId: "integration-reconciler-after-dead-letter",
        limit: 1,
        leaseDurationMs: 1_000,
      });
      expect(laterClaim[0]?.messageId).toBe(later.outbox.messageId);
      await cancelQueuedTask(repository, later.task.taskId);
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

    it("serializes competing durable assignments for one Bot across Coordinators", async () => {
      const first = (
        await repository.createTask(
          taskCreateCommand("test.concurrent-assignment-first"),
        )
      ).task;
      const second = (
        await repository.createTask(
          taskCreateCommand("test.concurrent-assignment-second"),
        )
      ).task;
      const claims = await Promise.allSettled([
        repository.acquireTaskAssignment(
          taskAssignmentCommand(first, {
            botId: "isolated-assignment-bot",
            leaseOwner: "coordinator-assignment-a",
            actorId: "coordinator-assignment-a",
            leaseDurationMs: 3_000,
          }),
        ),
        repository.acquireTaskAssignment(
          taskAssignmentCommand(second, {
            botId: "isolated-assignment-bot",
            leaseOwner: "coordinator-assignment-b",
            actorId: "coordinator-assignment-b",
            leaseDurationMs: 3_000,
          }),
        ),
      ]);
      const winner = claims.find(
        (claim) => claim.status === "fulfilled",
      );
      const loser = claims.find((claim) => claim.status === "rejected");
      expect(winner?.status).toBe("fulfilled");
      expect(loser?.status).toBe("rejected");
      if (winner?.status !== "fulfilled") {
        throw new Error("Concurrent durable assignment did not produce a winner.");
      }
      expect(loser?.reason).toMatchObject({
        code: "TASK_BOT_ASSIGNMENT_CONFLICT",
      });

      const persisted = await Promise.all([
        repository.getTask(first.taskId),
        repository.getTask(second.taskId),
      ]);
      expect(
        persisted.filter(
          (task) =>
            task?.status === "assigned" &&
            task.assignedBotId === "isolated-assignment-bot",
        ),
      ).toHaveLength(1);
      expect(
        persisted.filter((task) => task?.status === "queued"),
      ).toHaveLength(1);

      await repository.cancelTask({
        schemaVersion: "1.0",
        operationId: randomUUID(),
        taskId: winner.value.task.taskId,
        actorId: "integration-assignment-cleanup",
        leaseOwner: winner.value.task.leaseOwner,
        reasonCode: "TEST_TASK_CLEANUP",
      });
      const queued = persisted.find(
        (task) => task?.taskId !== winner.value.task.taskId,
      );
      if (!queued) throw new Error("Concurrent assignment loser disappeared.");
      await cancelQueuedTask(repository, queued.taskId);
    }, REAL_TEST_TIMEOUT_MS);

    it("fails closed when assignment server context conflicts with the task target", async () => {
      const created = (
        await repository.createTask({
          ...taskCreateCommand("test.assignment-context-conflict"),
          target: {
            x: 10,
            y: 64,
            z: -10,
            dimension: "minecraft:overworld",
            serverProfileId: "isolated-local",
          },
        })
      ).task;
      await expect(
        repository.acquireTaskAssignment(
          taskAssignmentCommand(created, {
            botId: "isolated-context-bot",
            leaseOwner: "coordinator-context-conflict",
            actorId: "coordinator-context-conflict",
            serverProfileId: "different-server",
          }),
        ),
      ).rejects.toMatchObject({
        code: "TASK_SERVER_CONTEXT_CONFLICT",
      });
      await expect(repository.getTask(created.taskId)).resolves.toMatchObject({
        status: "queued",
        revision: 0,
        dispatchBotId: null,
        assignedBotId: null,
        leaseOwner: null,
      });
      await expect(
        repository.getTaskOutbox(created.taskId, created.revision),
      ).resolves.toBeNull();
      await cancelQueuedTask(repository, created.taskId);
    }, REAL_TEST_TIMEOUT_MS);

    it("recovers an assignment lease and dispatch outbox after a Coordinator restart", async () => {
      const created = (
        await repository.createTask(
          taskCreateCommand("test.assignment-coordinator-restart"),
        )
      ).task;
      const command = taskAssignmentCommand(created, {
        botId: "isolated-restart-bot",
        leaseOwner: "coordinator-before-restart",
        actorId: "coordinator-before-restart",
        leaseDurationMs: 300_000,
      });
      const beforeRestartAdapter = new PgTaskPoolAdapter(scopedPoolConfig);
      let acquired: AcquireTaskAssignmentResult;
      try {
        await beforeRestartAdapter.verifyConnection();
        const beforeRestartRepository = new PostgresTaskRepository(
          beforeRestartAdapter,
        );
        acquired = await beforeRestartRepository.acquireTaskAssignment(command);
      } finally {
        await boundedCleanup(
          beforeRestartAdapter.close(),
          "Pre-restart PostgreSQL adapter",
        );
      }

      const restartedAdapter = new PgTaskPoolAdapter(scopedPoolConfig);
      try {
        await restartedAdapter.verifyConnection();
        const restartedRepository = new PostgresTaskRepository(
          restartedAdapter,
        );
        await expect(
          restartedRepository.getTask(created.taskId),
        ).resolves.toEqual(acquired.task);
        await expect(
          restartedRepository.getTaskOutbox(
            created.taskId,
            acquired.task.revision,
          ),
        ).resolves.toEqual(acquired.outbox);
        await expect(
          restartedRepository.acquireTaskAssignment(command),
        ).resolves.toEqual(acquired);
      } finally {
        await boundedCleanup(
          restartedAdapter.close(),
          "Restarted PostgreSQL adapter",
        );
      }

      await repository.cancelTask({
        schemaVersion: "1.0",
        operationId: randomUUID(),
        taskId: acquired.task.taskId,
        actorId: "integration-assignment-cleanup",
        leaseOwner: acquired.task.leaseOwner,
        reasonCode: "TEST_TASK_CLEANUP",
      });
    }, REAL_TEST_TIMEOUT_MS);

    it("reassigns an expired assignment to a substitute Bot at a new revision", async () => {
      const created = (
        await repository.createTask(
          taskCreateCommand("test.assignment-substitute-bot"),
        )
      ).task;
      const assigned = await repository.acquireTaskAssignment(
        taskAssignmentCommand(created, {
          botId: "isolated-expired-bot",
          leaseOwner: "coordinator-expired-owner",
          actorId: "coordinator-expired-owner",
          leaseDurationMs: 1_000,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_200));

      const expired = await repository.recoverExpiredLease({
        schemaVersion: "1.0",
        operationId: randomUUID(),
        taskId: assigned.task.taskId,
        expectedRevision: assigned.task.revision,
        actorId: "coordinator-expiry-recovery",
        reasonCode: "TASK_LEASE_EXPIRED",
      });
      expect(expired).toMatchObject({
        task: {
          status: "queued",
          revision: assigned.task.revision + 1,
          assignedBotId: null,
          leaseOwner: null,
        },
        dispatch: {
          botId: "isolated-expired-bot",
          payload: { expectedRevision: assigned.task.revision + 1 },
        },
        outbox: {
          status: "pending",
          expectedRevision: assigned.task.revision + 1,
        },
      });

      const substitute = await repository.acquireTaskAssignment(
        taskAssignmentCommand(expired.task, {
          botId: "isolated-substitute-bot",
          leaseOwner: "coordinator-substitute-owner",
          actorId: "coordinator-substitute-owner",
          leaseDurationMs: 300_000,
        }),
      );
      expect(substitute).toMatchObject({
        task: {
          status: "assigned",
          revision: expired.task.revision + 1,
          assignedBotId: "isolated-substitute-bot",
          dispatchBotId: "isolated-substitute-bot",
          leaseOwner: "coordinator-substitute-owner",
        },
        dispatch: {
          botId: "isolated-substitute-bot",
          payload: {
            expectedRevision: expired.task.revision + 1,
            assignmentLeaseOwner: "coordinator-substitute-owner",
          },
        },
      });
      await expect(
        repository.getTaskOutbox(
          assigned.task.taskId,
          expired.task.revision,
        ),
      ).resolves.toMatchObject({
        status: "failed",
        lastError: "TASK_DISPATCH_SUPERSEDED",
      });

      await repository.cancelTask({
        schemaVersion: "1.0",
        operationId: randomUUID(),
        taskId: substitute.task.taskId,
        actorId: "integration-assignment-cleanup",
        leaseOwner: substitute.task.leaseOwner,
        reasonCode: "TEST_TASK_CLEANUP",
      });
    }, REAL_TEST_TIMEOUT_MS);

    it("persists a synchronous assignment without creating a BullMQ outbox", async () => {
      const created = (
        await repository.createTask(
          taskCreateCommand("test.synchronous-assignment"),
        )
      ).task;
      const assigned = await repository.acquireSynchronousAssignment(
        taskAssignmentCommand(created, {
          botId: "isolated-synchronous-bot",
          leaseOwner: "coordinator-synchronous-owner",
          actorId: "coordinator-synchronous-owner",
          leaseDurationMs: 300_000,
        }),
      );
      expect(assigned).toMatchObject({
        status: "assigned",
        dispatchBotId: "isolated-synchronous-bot",
        assignedBotId: "isolated-synchronous-bot",
        leaseOwner: "coordinator-synchronous-owner",
        revision: created.revision + 1,
      });
      await expect(
        repository.getTaskOutbox(created.taskId, assigned.revision),
      ).resolves.toBeNull();
      await repository.cancelTask({
        schemaVersion: "1.0",
        operationId: randomUUID(),
        taskId: assigned.taskId,
        actorId: "integration-assignment-cleanup",
        leaseOwner: assigned.leaseOwner,
        reasonCode: "TEST_TASK_CLEANUP",
      });
    }, REAL_TEST_TIMEOUT_MS);

    it("reconciles an assigned outbox after Redis loses its BullMQ job", async () => {
      const queue = createQueue();
      await queue.verifyConnection();
      const created = (
        await repository.createTask(
          taskCreateCommand("test.assignment-redis-reconciliation"),
        )
      ).task;
      const assigned = await repository.acquireTaskAssignment(
        taskAssignmentCommand(created, {
          botId: "isolated-redis-assignment-bot",
          leaseOwner: "coordinator-redis-owner",
          actorId: "coordinator-redis-owner",
          leaseDurationMs: 300_000,
        }),
      );
      const reconciler = new TaskOutboxReconciler({
        repository,
        queue,
        instanceId: "integration-assignment-redis-reconciler",
      });
      await expect(reconciler.reconcileOnce()).resolves.toEqual({
        claimed: 1,
        enqueued: 1,
        skipped: 0,
        failed: 0,
      });
      expect(
        await queue.getJob(assigned.task.taskId, assigned.task.revision),
      ).not.toBeNull();
      expect(
        await queue.remove(assigned.task.taskId, assigned.task.revision),
      ).toBe(true);
      await assertionPool.query(
        `UPDATE studio_task_outbox
         SET available_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE message_id = $1`,
        [assigned.outbox.messageId],
      );

      await expect(reconciler.reconcileOnce()).resolves.toEqual({
        claimed: 1,
        enqueued: 1,
        skipped: 0,
        failed: 0,
      });
      const recreated = await queue.getJob(
        assigned.task.taskId,
        assigned.task.revision,
      );
      expect(recreated).not.toBeNull();
      expect(recreated?.data.messageId).toBe(assigned.outbox.messageId);
      await queue.remove(assigned.task.taskId, assigned.task.revision);
      await repository.cancelTask({
        schemaVersion: "1.0",
        operationId: randomUUID(),
        taskId: assigned.task.taskId,
        actorId: "integration-assignment-cleanup",
        leaseOwner: assigned.task.leaseOwner,
        reasonCode: "TEST_TASK_CLEANUP",
      });
    }, REAL_TEST_TIMEOUT_MS);

    it("blocks new leases and resolves queued cancellation atomically", async () => {
      const task = (
        await repository.createTask(
          taskCreateCommand("test.queued-durable-cancellation"),
        )
      ).task;
      const operationId = randomUUID();
      const request = await repository.requestTaskCancellation({
        operationId,
        taskId: task.taskId,
        actorId: "integration-canceller",
        reasonCode: "TASK_CANCELLED_BEFORE_LEASE",
      });
      await expect(
        repository.acquireLease({
          schemaVersion: "1.0",
          operationId: randomUUID(),
          taskId: task.taskId,
          expectedRevision: task.revision,
          actorId: "worker-after-cancellation",
          botId: "isolated-test-bot",
          leaseOwner: "worker-after-cancellation",
          leaseDurationMs: 3_000,
        }),
      ).rejects.toMatchObject({ code: "TASK_CANCELLATION_PENDING" });

      const resolved = await repository.resolveTaskCancellation({
        taskId: task.taskId,
        resolverId: "integration-cancellation-resolver",
        leaseOwner: null,
      });
      expect(resolved).toMatchObject({
        request: {
          requestId: request.requestId,
          operationId,
          acknowledgedBy: "integration-cancellation-resolver",
        },
        task: {
          taskId: task.taskId,
          status: "cancelled",
          revision: task.revision + 1,
        },
      });
      expect(resolved?.request.acknowledgedAt).not.toBeNull();
      await expect(
        repository.resolveTaskCancellation({
          taskId: task.taskId,
          resolverId: "integration-cancellation-replay",
          leaseOwner: null,
        }),
      ).resolves.toEqual(resolved);
      const history = await assertionPool.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count
         FROM studio_task_history
         WHERE operation_id = $1 AND event_type = 'task.cancelled'`,
        [operationId],
      );
      expect(history.rows[0]?.count).toBe(1);
    }, REAL_TEST_TIMEOUT_MS);

    it("atomically recovers an expired assigned lease with one new-revision outbox", async () => {
      const created = await repository.createTask(
        taskCreateCommand("test.coordinator-expired-lease-recovery"),
      );
      await assertionPool.query(
        `UPDATE studio_tasks
         SET dispatch_bot_id = 'isolated-test-bot'
         WHERE task_id = $1`,
        [created.task.taskId],
      );
      const assigned = await repository.acquireLease({
        schemaVersion: "1.0",
        operationId: randomUUID(),
        taskId: created.task.taskId,
        expectedRevision: created.task.revision,
        actorId: "integration-worker",
        botId: "isolated-test-bot",
        leaseOwner: "integration-worker-lease",
        leaseDurationMs: 1_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_200));

      const expired = await repository.listExpiredLeases(100);
      expect(expired).toContainEqual(
        expect.objectContaining({
          taskId: assigned.taskId,
          status: "assigned",
          revision: assigned.revision,
        }),
      );
      const command = {
        schemaVersion: "1.0" as const,
        operationId: randomUUID(),
        taskId: assigned.taskId,
        expectedRevision: assigned.revision,
        actorId: "integration-coordinator-recovery",
        reasonCode: "TASK_LEASE_EXPIRED" as const,
      };

      const first = await repository.recoverExpiredLease(command);
      const replay = await repository.recoverExpiredLease(command);
      expect(first).toMatchObject({
        task: {
          status: "queued",
          assignedBotId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          revision: assigned.revision + 1,
        },
        dispatch: {
          botId: "isolated-test-bot",
          payload: { expectedRevision: assigned.revision + 1 },
        },
        outbox: {
          taskId: assigned.taskId,
          expectedRevision: assigned.revision + 1,
          status: "pending",
        },
      });
      expect(replay).toEqual(first);

      const persisted = await assertionPool.query<{
        history_count: number;
        outbox_count: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::integer FROM studio_task_history
             WHERE operation_id = $1) AS history_count,
           (SELECT COUNT(*)::integer FROM studio_task_outbox
             WHERE task_id = $2 AND expected_revision = $3) AS outbox_count`,
        [command.operationId, assigned.taskId, assigned.revision + 1],
      );
      expect(persisted.rows[0]).toEqual({
        history_count: 1,
        outbox_count: 1,
      });
      await cancelQueuedTask(repository, assigned.taskId);
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

    it("persists cancellation from one worker and aborts the remote lease owner", async () => {
      const queue = createQueue();
      let observedAbort = false;
      const definition = {
        taskType: "test.worker-cancel",
        handlerVersion: "1.0.0",
        idempotent: true,
        execute: async ({ signal }: { signal: AbortSignal }) =>
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(new Error("cancelled"));
              },
              { once: true },
            );
          }),
      } as const;
      const ownerRegistry = new TaskHandlerRegistry();
      ownerRegistry.register(definition);
      const ownerWorker = createWorker(
        ownerRegistry,
        "integration-worker-cancel-owner",
      );
      await ownerWorker.start();

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
      const requesterRegistry = new TaskHandlerRegistry();
      requesterRegistry.register(definition);
      const requesterWorker = createWorker(
        requesterRegistry,
        "integration-worker-cancel-requester",
      );
      await requesterWorker.start();
      const cancelled = await requesterWorker.cancelTask({
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
      const request = await repository.getTaskCancellationRequest(task.taskId);
      expect(request).toMatchObject({
        acknowledgedBy: running.leaseOwner,
        reasonCode: "TASK_CANCELLED_BY_TEST",
      });
      expect(request?.acknowledgedAt).not.toBeNull();
      await requesterWorker.close();
      await ownerWorker.close();
    }, REAL_TEST_TIMEOUT_MS);

    it("runs cancellation through the isolated independent Task Worker process", async () => {
      const queue = createQueue();
      const child = spawn(process.execPath, [taskWorkerEntry], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: {
          ...process.env,
          TASK_WORKER_PURPOSE: "isolated-test",
          TASK_WORKER_HANDLER_PROFILE: "isolated-acceptance",
          TASK_POSTGRES_URL: config.postgresUrl,
          TASK_REDIS_URL: config.redisUrl,
          // Pin the child process to this test's queue. An inherited
          // TASK_QUEUE_NAME could otherwise make the process consume an
          // unrelated runner queue while the parent publishes here.
          TASK_QUEUE_NAME: config.queueName,
          TASK_INFRA_TEST_NAMESPACE: schemaName,
          TASK_WORKER_CANCELLATION_POLL_INTERVAL_MS: "50",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForTaskWorkerReady(child);
        const task = (
          await repository.createTask(
            taskCreateCommand("isolated.acceptance.wait", 8_000),
          )
        ).task;
        await queue.enqueue(dispatchFor(task));
        const running = await waitForTask(
          repository,
          task.taskId,
          (candidate) => candidate.status === "running",
        );
        const request = await repository.requestTaskCancellation({
          operationId: randomUUID(),
          taskId: task.taskId,
          actorId: "integration-process-canceller",
          reasonCode: "TASK_CANCELLED_BY_PROCESS_TEST",
        });
        expect(request.acknowledgedAt).toBeNull();

        const cancelled = await waitForTask(
          repository,
          task.taskId,
          (candidate) => candidate.status === "cancelled",
        );
        expect(cancelled.leaseOwner).toBeNull();
        const acknowledged = await repository.getTaskCancellationRequest(
          task.taskId,
        );
        expect(acknowledged).toMatchObject({
          operationId: request.operationId,
          acknowledgedBy: running.leaseOwner,
        });
        expect(acknowledged?.acknowledgedAt).not.toBeNull();

        await expectTaskWorkerProcessStopped(child);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          await stopTaskWorkerProcess(child).catch(async () => {
            await forceStopTaskWorkerProcess(child);
          });
        }
      }
    }, REAL_TEST_TIMEOUT_MS);

    it("delivers a submitted digest task through the Coordinator-style reconciler to the independent Worker process", async () => {
      const queue = createQueue();
      const child = spawn(process.execPath, [taskWorkerEntry], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: {
          ...process.env,
          TASK_WORKER_PURPOSE: "isolated-test",
          TASK_WORKER_HANDLER_PROFILE: "isolated-acceptance",
          TASK_POSTGRES_URL: config.postgresUrl,
          TASK_REDIS_URL: config.redisUrl,
          // Keep the independent worker on the queue selected by this test,
          // regardless of the parent runner environment.
          TASK_QUEUE_NAME: config.queueName,
          TASK_INFRA_TEST_NAMESPACE: schemaName,
          TASK_WORKER_CONCURRENCY: "1",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForTaskWorkerReady(child);
        const input = {
          schemaVersion: "1.0" as const,
          value: { operation: "process-e2e", count: 1 },
        };
        const submitted = await repository.submitTask({
          ...taskSubmitCommand("isolated.acceptance.digest"),
          input,
        });
        const reconciler = new TaskOutboxReconciler({
          repository,
          queue,
          instanceId: "integration-process-e2e-reconciler",
        });
        await expect(reconciler.reconcileOnce()).resolves.toMatchObject({
          claimed: 1,
          enqueued: 1,
          failed: 0,
        });
        const completed = await waitForTask(
          repository,
          submitted.task.taskId,
          (candidate) => candidate.status === "completed",
        );
        // PostgreSQL JSONB may normalize object key order before the worker
        // reads the task. Compare against the durable input that was executed,
        // matching the in-process delivery test above.
        const persistedInput = completed.input as typeof input;
        const serialized = JSON.stringify(persistedInput.value);
        expect(completed.result).toEqual({
          schemaVersion: "1.0",
          kind: "isolated.acceptance.digest.v1",
          sha256: createHash("sha256")
            .update(serialized, "utf8")
            .digest("hex"),
          byteLength: Buffer.byteLength(serialized, "utf8"),
        });
        expect(completed.evidence).toEqual([
          { kind: "trace", reference: completed.traceId },
        ]);
        await expect(
          repository.getTaskOutbox(
            submitted.task.taskId,
            submitted.task.revision,
          ),
        ).resolves.toMatchObject({ status: "delivered" });
        await expectTaskWorkerProcessStopped(child);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          await stopTaskWorkerProcess(child).catch(async () => {
            await forceStopTaskWorkerProcess(child);
          });
        }
      }
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
