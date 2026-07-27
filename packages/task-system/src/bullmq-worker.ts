import { createHash } from "node:crypto";

import {
  identifierSchema,
  skillJsonValueSchema,
  skillVersionSchema,
  taskDispatchV1Schema,
  type SkillJsonValue,
  type TaskDispatchV1,
} from "@minecraft-studio/protocol";
import { Worker, type Job } from "bullmq";
import { z } from "zod";

import {
  TASK_DISPATCH_JOB_NAME,
  bullMqTaskConnectionOptions,
  taskDispatchJobId,
  type TaskWorkerQueueResult,
} from "./bullmq-queue.js";
import { TaskSystemError } from "./errors.js";
import {
  taskEvidenceSchema,
  type TaskRecord,
} from "./model.js";
import { PostgresTaskRepository } from "./postgres-repository.js";

const taskHandlerResultSchema = z
  .object({
    result: skillJsonValueSchema.nullable(),
    evidence: z.array(taskEvidenceSchema).max(64),
  })
  .strict();

const workerOptionsSchema = z
  .object({
    redisUrl: z.string().min(1).max(2_048),
    queueName: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
    prefix: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
    instanceId: identifierSchema,
    concurrency: z.number().int().min(1).max(32),
    leaseDurationMs: z.number().int().min(1_000).max(5 * 60_000),
    renewIntervalMs: z.number().int().min(100).max(60_000),
    lockDurationMs: z.number().int().min(2_000).max(10 * 60_000),
    stalledIntervalMs: z.number().int().min(500).max(60_000),
    cancellationWaitMs: z
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.renewIntervalMs * 2 > value.leaseDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["renewIntervalMs"],
        message: "Lease renewal must run at least twice per lease duration.",
      });
    }
    if (value.lockDurationMs <= value.leaseDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["lockDurationMs"],
        message:
          "BullMQ lock duration must exceed the PostgreSQL lease duration.",
      });
    }
  });

const cancelTaskCommandSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    operationId: z.string().uuid(),
    taskId: z.string().uuid(),
    actorId: identifierSchema,
    reasonCode: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[A-Z][A-Z0-9_]*$/u),
  })
  .strict();

type CancelTaskCommand = z.output<typeof cancelTaskCommandSchema>;

type ActiveTaskExecution = {
  readonly jobId: string;
  readonly leaseOwner: string;
  cancellation: CancelTaskCommand | null;
};

export type TaskHandlerResult = Readonly<{
  result: SkillJsonValue | null;
  evidence: readonly z.infer<typeof taskEvidenceSchema>[];
}>;

export type TaskHandlerContext = Readonly<{
  task: TaskRecord;
  dispatch: TaskDispatchV1;
  signal: AbortSignal;
}>;

export type TaskHandlerDefinition = Readonly<{
  taskType: string;
  handlerVersion: string;
  idempotent: boolean;
  execute(context: TaskHandlerContext): Promise<TaskHandlerResult>;
}>;

export type BullMqTaskWorkerOptions = z.input<typeof workerOptionsSchema>;

export class TaskWorkerError extends Error {
  constructor(
    readonly code:
      | "TASK_DISPATCH_INVALID"
      | "TASK_DISPATCH_STALE"
      | "TASK_HANDLER_ALREADY_REGISTERED"
      | "TASK_HANDLER_NOT_REGISTERED"
      | "TASK_HANDLER_CONTRACT_MISMATCH"
      | "TASK_HANDLER_OUTPUT_INVALID"
      | "TASK_HANDLER_FAILED"
      | "TASK_RECOVERY_UNSAFE"
      | "TASK_LEASE_LOST"
      | "TASK_EXECUTION_CANCELLED"
      | "TASK_CANCELLATION_CONFLICT"
      | "TASK_CANCELLATION_NOT_LOCAL"
      | "TASK_CANCELLATION_UNACKNOWLEDGED"
      | "TASK_WORKER_UNAVAILABLE"
      | "TASK_WORKER_SHUTDOWN",
    message: string,
  ) {
    super(message);
    this.name = "TaskWorkerError";
  }
}

async function waitForWorkerReady<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new TaskWorkerError(
                "TASK_WORKER_UNAVAILABLE",
                "Task worker readiness timed out.",
              ),
            ),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TaskHandlerRegistry {
  private readonly handlers = new Map<string, TaskHandlerDefinition>();

  register(definition: TaskHandlerDefinition): void {
    const taskType = z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/u)
      .parse(definition.taskType);
    const handlerVersion = skillVersionSchema.parse(
      definition.handlerVersion,
    );
    const key = `${taskType}@${handlerVersion}`;
    if (this.handlers.has(key)) {
      throw new TaskWorkerError(
        "TASK_HANDLER_ALREADY_REGISTERED",
        "Task handler version is already registered.",
      );
    }
    this.handlers.set(
      key,
      Object.freeze({ ...definition, taskType, handlerVersion }),
    );
  }

  get(taskType: string, handlerVersion: string): TaskHandlerDefinition | null {
    return this.handlers.get(`${taskType}@${handlerVersion}`) ?? null;
  }
}

function deterministicOperationId(
  messageId: string,
  stage: string,
  revision: number,
): string {
  const bytes = createHash("sha256")
    .update(`${messageId}\u0000${stage}\u0000${revision}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function abortError(signal: AbortSignal): TaskWorkerError {
  const reason = signal.reason;
  if (reason instanceof TaskWorkerError) return reason;
  return new TaskWorkerError(
    "TASK_EXECUTION_CANCELLED",
    "Task execution was cancelled.",
  );
}

async function executeHandlerUntilAbort(
  handler: TaskHandlerDefinition,
  context: TaskHandlerContext,
): Promise<TaskHandlerResult> {
  if (context.signal.aborted) throw abortError(context.signal);

  let rejectAborted: ((error: TaskWorkerError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => rejectAborted?.(abortError(context.signal));
  context.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const execution = handler.execute(context);
    // The trusted in-process handler may settle after cancellation. Observe its
    // rejection while the worker releases the durable lease immediately.
    void execution.catch(() => undefined);
    return await Promise.race([execution, aborted]);
  } finally {
    context.signal.removeEventListener("abort", onAbort);
  }
}

function terminalResult(task: TaskRecord): TaskWorkerQueueResult | null {
  if (task.status === "cancelled") {
    return {
      schemaVersion: "1.0",
      taskId: task.taskId,
      status: "cancelled",
      revision: task.revision,
    };
  }
  if (task.status === "completed") {
    return {
      schemaVersion: "1.0",
      taskId: task.taskId,
      status: "completed",
      revision: task.revision,
    };
  }
  if (task.status === "expired") {
    return {
      schemaVersion: "1.0",
      taskId: task.taskId,
      status: "already-terminal",
      revision: task.revision,
    };
  }
  return null;
}

export class BullMqTaskWorker {
  private readonly options: z.output<typeof workerOptionsSchema>;
  private readonly worker: Worker<
    TaskDispatchV1,
    TaskWorkerQueueResult,
    typeof TASK_DISPATCH_JOB_NAME
  >;
  private readonly activeExecutionByTask = new Map<
    string,
    ActiveTaskExecution
  >();
  private runPromise: Promise<void> | null = null;
  private closing = false;
  private lastInfrastructureError: TaskWorkerError | null = null;

  constructor(
    private readonly repository: PostgresTaskRepository,
    private readonly handlers: TaskHandlerRegistry,
    options: BullMqTaskWorkerOptions,
  ) {
    this.options = workerOptionsSchema.parse(options);
    this.worker = new Worker<
      TaskDispatchV1,
      TaskWorkerQueueResult,
      typeof TASK_DISPATCH_JOB_NAME
    >(
      this.options.queueName,
      async (job, _token, signal) =>
        await this.process(job, signal),
      {
        autorun: false,
        connection: bullMqTaskConnectionOptions(this.options.redisUrl),
        prefix: this.options.prefix,
        name: this.options.instanceId,
        concurrency: this.options.concurrency,
        lockDuration: this.options.lockDurationMs,
        maxStalledCount: 1,
        maxStartedAttempts: 3,
        stalledInterval: this.options.stalledIntervalMs,
        removeOnComplete: {
          age: 24 * 60 * 60,
          count: 10_000,
        },
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
          count: 10_000,
        },
      },
    );
    this.worker.on("error", () => {
      this.lastInfrastructureError = new TaskWorkerError(
        "TASK_WORKER_UNAVAILABLE",
        "Task worker infrastructure became unavailable.",
      );
    });
  }

  async start(): Promise<void> {
    if (this.runPromise) return;
    try {
      await waitForWorkerReady(this.worker.waitUntilReady(), 10_000);
    } catch {
      await this.worker.close(true).catch(() => undefined);
      throw new TaskWorkerError(
        "TASK_WORKER_UNAVAILABLE",
        "Task worker could not connect to Redis.",
      );
    }
    this.runPromise = this.worker.run();
    this.runPromise.catch(() => {
      this.lastInfrastructureError = new TaskWorkerError(
        "TASK_WORKER_UNAVAILABLE",
        "Task worker stopped unexpectedly.",
      );
    });
  }

  getLastInfrastructureError(): TaskWorkerError | null {
    return this.lastInfrastructureError;
  }

  async cancelTask(input: unknown): Promise<TaskRecord> {
    const command = cancelTaskCommandSchema.parse(input);
    const active = this.activeExecutionByTask.get(command.taskId);
    if (active) {
      if (active.cancellation) {
        if (
          active.cancellation.operationId !== command.operationId ||
          active.cancellation.actorId !== command.actorId ||
          active.cancellation.reasonCode !== command.reasonCode
        ) {
          throw new TaskWorkerError(
            "TASK_CANCELLATION_CONFLICT",
            "Task already has a different cancellation request in progress.",
          );
        }
        return await this.waitForCancellation(command.taskId);
      }
      active.cancellation = command;
      this.worker.cancelJob(active.jobId, command.reasonCode);
      return await this.waitForCancellation(command.taskId);
    }

    const current = await this.repository.getTask(command.taskId);
    if (!current) {
      throw new TaskWorkerError(
        "TASK_DISPATCH_STALE",
        "Cancellation references an unavailable task.",
      );
    }
    if (current.status === "cancelled") return current;
    if (current.status === "assigned" || current.status === "running") {
      throw new TaskWorkerError(
        "TASK_CANCELLATION_NOT_LOCAL",
        "Active task belongs to another worker and cannot be cancelled locally.",
      );
    }
    return await this.repository.cancelTask({
      schemaVersion: "1.0",
      operationId: command.operationId,
      taskId: command.taskId,
      actorId: command.actorId,
      leaseOwner: null,
      reasonCode: command.reasonCode,
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.worker.cancelAllJobs("TASK_WORKER_SHUTDOWN");
    await this.worker.close(false);
    if (this.runPromise) {
      await this.runPromise.catch(() => undefined);
    }
  }

  private async process(
    job: Job<
      TaskDispatchV1,
      TaskWorkerQueueResult,
      typeof TASK_DISPATCH_JOB_NAME
    >,
    workerSignal?: AbortSignal,
  ): Promise<TaskWorkerQueueResult> {
    let dispatch: TaskDispatchV1;
    try {
      dispatch = taskDispatchV1Schema.parse(job.data);
    } catch {
      throw new TaskWorkerError(
        "TASK_DISPATCH_INVALID",
        "Task dispatch message is invalid.",
      );
    }
    if (
      job.name !== TASK_DISPATCH_JOB_NAME ||
      job.id !==
        taskDispatchJobId(
          dispatch.taskId,
          dispatch.payload.expectedRevision,
        )
    ) {
      throw new TaskWorkerError(
        "TASK_DISPATCH_INVALID",
        "Task dispatch identity is invalid.",
      );
    }

    const jobId = job.id;
    if (this.activeExecutionByTask.has(dispatch.taskId)) {
      throw new TaskWorkerError(
        "TASK_DISPATCH_STALE",
        "Task already has an active execution in this worker.",
      );
    }
    const active: ActiveTaskExecution = {
      jobId,
      leaseOwner: deterministicLeaseOwner(
        this.options.instanceId,
        dispatch.messageId,
        jobId,
      ),
      cancellation: null,
    };
    this.activeExecutionByTask.set(dispatch.taskId, active);
    try {
      let task = await this.repository.getTask(dispatch.taskId);
      if (!task) {
        throw new TaskWorkerError(
          "TASK_DISPATCH_STALE",
          "Task dispatch references an unavailable task.",
        );
      }
      const alreadyTerminal = terminalResult(task);
      if (alreadyTerminal) return alreadyTerminal;
      if (task.taskType !== dispatch.payload.taskType) {
        throw new TaskWorkerError(
          "TASK_DISPATCH_STALE",
          "Task dispatch type does not match PostgreSQL.",
        );
      }
      if (task.traceId !== dispatch.traceId) {
        throw new TaskWorkerError(
          "TASK_DISPATCH_STALE",
          "Task dispatch trace does not match PostgreSQL.",
        );
      }
      if (
        task.handlerVersion !== dispatch.payload.handlerVersion ||
        task.executionIdempotent !==
          dispatch.payload.executionIdempotent
      ) {
        throw new TaskWorkerError(
          "TASK_DISPATCH_STALE",
          "Task dispatch execution contract does not match PostgreSQL.",
        );
      }

      const handler = this.handlers.get(
        task.taskType,
        task.handlerVersion,
      );
      if (!handler) {
        throw new TaskWorkerError(
          "TASK_HANDLER_NOT_REGISTERED",
          "No exact deterministic handler is registered for the task type.",
        );
      }
      if (handler.idempotent !== task.executionIdempotent) {
        throw new TaskWorkerError(
          "TASK_HANDLER_CONTRACT_MISMATCH",
          "Registered handler does not match the persisted execution contract.",
        );
      }

      const recovery = await this.recoverStalledTask(
        task,
        dispatch,
        handler,
        job.attemptsStarted,
      );
      task = recovery.task;
      if (
        task.revision !== dispatch.payload.expectedRevision &&
        !recovery.recoveredFromThisDispatch
      ) {
        throw new TaskWorkerError(
          "TASK_DISPATCH_STALE",
          "Task dispatch revision is stale.",
        );
      }
      if (task.status !== "queued") {
        throw new TaskWorkerError(
          "TASK_DISPATCH_STALE",
          "Task is not ready for dispatch.",
        );
      }

      const cancelledBeforeLease = await this.cancelIfRequested(
        task,
        active,
        workerSignal,
      );
      if (cancelledBeforeLease) return cancelledBeforeLease;

      task = await this.repository.acquireLease({
        schemaVersion: "1.0",
        operationId: deterministicOperationId(
          dispatch.messageId,
          "lease-acquire",
          task.revision,
        ),
        taskId: task.taskId,
        expectedRevision: task.revision,
        actorId: this.options.instanceId,
        botId: dispatch.botId,
        leaseOwner: active.leaseOwner,
        leaseDurationMs: this.options.leaseDurationMs,
      });
      const cancelledAfterLease = await this.cancelIfRequested(
        task,
        active,
        workerSignal,
      );
      if (cancelledAfterLease) return cancelledAfterLease;

      task = await this.repository.transition({
        schemaVersion: "1.0",
        operationId: deterministicOperationId(
          dispatch.messageId,
          "task-start",
          task.revision,
        ),
        taskId: task.taskId,
        expectedRevision: task.revision,
        actorId: this.options.instanceId,
        to: "running",
        reasonCode: "TASK_WORKER_STARTED",
        leaseOwner: active.leaseOwner,
        failureReason: null,
        result: null,
        evidence: [],
      });
      const cancelledBeforeHandler = await this.cancelIfRequested(
        task,
        active,
        workerSignal,
      );
      if (cancelledBeforeHandler) return cancelledBeforeHandler;

      return await this.executeWithLease(
        task,
        dispatch,
        handler,
        active,
        workerSignal,
      );
    } finally {
      if (this.activeExecutionByTask.get(dispatch.taskId) === active) {
        this.activeExecutionByTask.delete(dispatch.taskId);
      }
    }
  }

  private async recoverStalledTask(
    task: TaskRecord,
    dispatch: TaskDispatchV1,
    handler: TaskHandlerDefinition,
    attemptsStarted: number,
  ): Promise<
    Readonly<{
      task: TaskRecord;
      recoveredFromThisDispatch: boolean;
    }>
  > {
    if (
      attemptsStarted <= 1 ||
      (task.status !== "assigned" && task.status !== "running")
    ) {
      return { task, recoveredFromThisDispatch: false };
    }
    if (task.assignedBotId !== dispatch.botId) {
      throw new TaskWorkerError(
        "TASK_DISPATCH_STALE",
        "Stalled dispatch Bot does not match PostgreSQL assignment.",
      );
    }
    let recovered: TaskRecord;
    try {
      recovered = await this.repository.expireLease({
        schemaVersion: "1.0",
        operationId: deterministicOperationId(
          dispatch.messageId,
          "lease-expire",
          task.revision,
        ),
        taskId: task.taskId,
        expectedRevision: task.revision,
        actorId: this.options.instanceId,
        reasonCode: "TASK_LEASE_EXPIRED",
      });
    } catch (error) {
      if (
        error instanceof TaskSystemError &&
        error.code === "TASK_LEASE_CONFLICT"
      ) {
        throw new TaskWorkerError(
          "TASK_DISPATCH_STALE",
          "Stalled task lease has not expired.",
        );
      }
      throw error;
    }

    if (recovered.status !== "failed") {
      return { task: recovered, recoveredFromThisDispatch: true };
    }
    if (
      !task.executionIdempotent ||
      recovered.retryCount >= recovered.maxRetries
    ) {
      throw new TaskWorkerError(
        "TASK_RECOVERY_UNSAFE",
        "Stalled task cannot be retried safely.",
      );
    }
    const requeued = await this.repository.transition({
      schemaVersion: "1.0",
      operationId: deterministicOperationId(
        dispatch.messageId,
        "stalled-requeue",
        recovered.revision,
      ),
      taskId: recovered.taskId,
      expectedRevision: recovered.revision,
      actorId: this.options.instanceId,
      to: "queued",
      reasonCode: "TASK_STALLED_REQUEUED",
      leaseOwner: null,
      failureReason: null,
      result: null,
      evidence: [],
    });
    return { task: requeued, recoveredFromThisDispatch: true };
  }

  private async executeWithLease(
    initialTask: TaskRecord,
    dispatch: TaskDispatchV1,
    handler: TaskHandlerDefinition,
    active: ActiveTaskExecution,
    workerSignal?: AbortSignal,
  ): Promise<TaskWorkerQueueResult> {
    let currentTask = initialTask;
    let renewalError: unknown = null;
    let stopRenewal = false;
    let timedOut = false;
    const executionController = new AbortController();
    const renewalController = new AbortController();
    const onWorkerAbort = () => {
      executionController.abort(
        this.closing
          ? new TaskWorkerError(
              "TASK_WORKER_SHUTDOWN",
              "Task worker is shutting down.",
            )
          : new TaskWorkerError(
              "TASK_EXECUTION_CANCELLED",
              "Task execution was cancelled.",
            ),
      );
    };
    if (workerSignal) {
      if (workerSignal.aborted) onWorkerAbort();
      else workerSignal.addEventListener("abort", onWorkerAbort, { once: true });
    }
    const databaseNow = await this.repository.getDatabaseTime();
    const startedAtMs =
      currentTask.startedAt === null
        ? databaseNow.getTime()
        : Date.parse(currentTask.startedAt);
    const timeoutRemainingMs = Math.max(
      0,
      currentTask.timeoutMs -
        Math.max(0, databaseNow.getTime() - startedAtMs),
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      executionController.abort(
        new TaskWorkerError(
          "TASK_EXECUTION_CANCELLED",
          "Task execution exceeded its persisted timeout.",
        ),
      );
    }, timeoutRemainingMs);
    timeout.unref();

    const renewalPromise = (async () => {
      while (!stopRenewal) {
        try {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              reject(
                new TaskWorkerError(
                  "TASK_EXECUTION_CANCELLED",
                  "Lease renewal stopped.",
                ),
              );
            };
            const timer = setTimeout(() => {
              renewalController.signal.removeEventListener(
                "abort",
                onAbort,
              );
              resolve();
            }, this.options.renewIntervalMs);
            timer.unref();
            renewalController.signal.addEventListener("abort", onAbort, {
              once: true,
            });
          });
        } catch {
          break;
        }
        if (stopRenewal) break;
        try {
          currentTask = await this.repository.renewLease({
            schemaVersion: "1.0",
            operationId: deterministicOperationId(
              dispatch.messageId,
              "lease-renew",
              currentTask.revision,
            ),
            taskId: currentTask.taskId,
            expectedRevision: currentTask.revision,
            actorId: this.options.instanceId,
            leaseOwner: active.leaseOwner,
            leaseDurationMs: this.options.leaseDurationMs,
          });
        } catch (error) {
          renewalError = error;
          executionController.abort(
            new TaskWorkerError(
              "TASK_LEASE_LOST",
              "Task lease renewal failed.",
            ),
          );
          break;
        }
      }
    })();

    let handlerResult: z.output<typeof taskHandlerResultSchema> | null = null;
    let handlerError: unknown = null;
    try {
      const output = await executeHandlerUntilAbort(handler, {
        task: initialTask,
        dispatch,
        signal: executionController.signal,
      });
      const parsed = taskHandlerResultSchema.safeParse(output);
      if (!parsed.success) {
        handlerError = new TaskWorkerError(
          "TASK_HANDLER_OUTPUT_INVALID",
          "Task handler returned invalid structured output.",
        );
      } else {
        handlerResult = parsed.data;
      }
    } catch (error) {
      handlerError = error;
    } finally {
      clearTimeout(timeout);
      stopRenewal = true;
      renewalController.abort();
      await renewalPromise;
      if (workerSignal) {
        workerSignal.removeEventListener("abort", onWorkerAbort);
      }
    }

    const persisted = await this.repository.getTask(initialTask.taskId);
    if (!persisted) {
      throw new TaskWorkerError(
        "TASK_LEASE_LOST",
        "Task disappeared while the handler was active.",
      );
    }
    const terminal = terminalResult(persisted);
    if (terminal) return terminal;
    currentTask = persisted;

    if (active.cancellation) {
      const cancelled = await this.repository.cancelTask({
        schemaVersion: "1.0",
        operationId: active.cancellation.operationId,
        taskId: currentTask.taskId,
        actorId: active.cancellation.actorId,
        leaseOwner: active.leaseOwner,
        reasonCode: active.cancellation.reasonCode,
      });
      return {
        schemaVersion: "1.0",
        taskId: cancelled.taskId,
        status: "cancelled",
        revision: cancelled.revision,
      };
    }
    const expiredAfterExecution = await this.finalizeExpiredBudget(
      currentTask,
      dispatch,
      active.leaseOwner,
    );
    if (expiredAfterExecution) {
      return {
        schemaVersion: "1.0",
        taskId: expiredAfterExecution.taskId,
        status:
          expiredAfterExecution.status === "failed"
            ? "failed"
            : "already-terminal",
        revision: expiredAfterExecution.revision,
      };
    }
    if (this.closing) {
      throw new TaskWorkerError(
        "TASK_WORKER_SHUTDOWN",
        "Task worker stopped before a durable result was recorded.",
      );
    }
    if (renewalError !== null) {
      throw new TaskWorkerError(
        "TASK_LEASE_LOST",
        "Task lease was lost before a durable result was recorded.",
      );
    }
    if (timedOut) {
      const failed = await this.failTask(
        currentTask,
        dispatch,
        active.leaseOwner,
        "TASK_TIMEOUT_EXPIRED",
      );
      return {
        schemaVersion: "1.0",
        taskId: failed.taskId,
        status: "failed",
        revision: failed.revision,
      };
    }
    if (handlerError !== null || handlerResult === null) {
      const failed = await this.failTask(
        currentTask,
        dispatch,
        active.leaseOwner,
        "TASK_HANDLER_FAILED",
      );
      return {
        schemaVersion: "1.0",
        taskId: failed.taskId,
        status: "failed",
        revision: failed.revision,
      };
    }

    const expiredBeforeCompletion = await this.finalizeExpiredBudget(
      currentTask,
      dispatch,
      active.leaseOwner,
    );
    if (expiredBeforeCompletion) {
      return {
        schemaVersion: "1.0",
        taskId: expiredBeforeCompletion.taskId,
        status:
          expiredBeforeCompletion.status === "failed"
            ? "failed"
            : "already-terminal",
        revision: expiredBeforeCompletion.revision,
      };
    }

    let completed: TaskRecord;
    try {
      completed = await this.repository.transition({
        schemaVersion: "1.0",
        operationId: deterministicOperationId(
          dispatch.messageId,
          "task-complete",
          currentTask.revision,
        ),
        taskId: currentTask.taskId,
        expectedRevision: currentTask.revision,
        actorId: this.options.instanceId,
        to: "completed",
        reasonCode: "TASK_HANDLER_COMPLETED",
        leaseOwner: active.leaseOwner,
        failureReason: null,
        result: handlerResult.result,
        evidence: handlerResult.evidence,
      });
    } catch (error) {
      if (
        !(error instanceof TaskSystemError) ||
        ![
          "TASK_TIMEOUT_EXPIRED",
          "TASK_DEADLINE_EXPIRED",
          "TASK_LEASE_EXPIRED",
        ].includes(error.code)
      ) {
        throw error;
      }
      const latest = await this.repository.getTask(currentTask.taskId);
      if (!latest) {
        throw new TaskWorkerError(
          "TASK_LEASE_LOST",
          "Task disappeared before completion could be recorded.",
        );
      }
      const terminal = terminalResult(latest);
      if (terminal) return terminal;
      const budgetTerminal = await this.finalizeExpiredBudget(
        latest,
        dispatch,
        active.leaseOwner,
      );
      if (budgetTerminal) {
        return {
          schemaVersion: "1.0",
          taskId: budgetTerminal.taskId,
          status:
            budgetTerminal.status === "failed"
              ? "failed"
              : "already-terminal",
          revision: budgetTerminal.revision,
        };
      }
      throw new TaskWorkerError(
        "TASK_LEASE_LOST",
        "Task lease expired before completion could be recorded.",
      );
    }
    return {
      schemaVersion: "1.0",
      taskId: completed.taskId,
      status: "completed",
      revision: completed.revision,
    };
  }

  private async finalizeExpiredBudget(
    task: TaskRecord,
    dispatch: TaskDispatchV1,
    leaseOwner: string,
  ): Promise<TaskRecord | null> {
    if (task.status !== "running" || task.leaseOwner !== leaseOwner) {
      return null;
    }
    const now = await this.repository.getDatabaseTime();
    if (task.deadline !== null && Date.parse(task.deadline) <= now.getTime()) {
      return await this.repository.transition({
        schemaVersion: "1.0",
        operationId: deterministicOperationId(
          dispatch.messageId,
          "TASK_DEADLINE_EXPIRED",
          task.revision,
        ),
        taskId: task.taskId,
        expectedRevision: task.revision,
        actorId: this.options.instanceId,
        to: "expired",
        reasonCode: "TASK_DEADLINE_EXPIRED",
        leaseOwner,
        failureReason: null,
        result: null,
        evidence: [],
      });
    }
    if (
      task.startedAt !== null &&
      Date.parse(task.startedAt) + task.timeoutMs <= now.getTime()
    ) {
      return await this.failTask(
        task,
        dispatch,
        leaseOwner,
        "TASK_TIMEOUT_EXPIRED",
      );
    }
    return null;
  }

  private async failTask(
    task: TaskRecord,
    dispatch: TaskDispatchV1,
    leaseOwner: string,
    failureReason: "TASK_TIMEOUT_EXPIRED" | "TASK_HANDLER_FAILED",
  ): Promise<TaskRecord> {
    return await this.repository.transition({
      schemaVersion: "1.0",
      operationId: deterministicOperationId(
        dispatch.messageId,
        failureReason,
        task.revision,
      ),
      taskId: task.taskId,
      expectedRevision: task.revision,
      actorId: this.options.instanceId,
      to: "failed",
      reasonCode: failureReason,
      leaseOwner,
      failureReason,
      result: null,
      evidence: [],
    });
  }

  private async cancelIfRequested(
    task: TaskRecord,
    active: ActiveTaskExecution,
    workerSignal?: AbortSignal,
  ): Promise<TaskWorkerQueueResult | null> {
    if (!active.cancellation) {
      if (workerSignal?.aborted) throw abortError(workerSignal);
      return null;
    }
    const cancelled = await this.repository.cancelTask({
      schemaVersion: "1.0",
      operationId: active.cancellation.operationId,
      taskId: task.taskId,
      actorId: active.cancellation.actorId,
      leaseOwner:
        task.status === "assigned" || task.status === "running"
          ? active.leaseOwner
          : null,
      reasonCode: active.cancellation.reasonCode,
    });
    return {
      schemaVersion: "1.0",
      taskId: cancelled.taskId,
      status: "cancelled",
      revision: cancelled.revision,
    };
  }

  private async waitForCancellation(taskId: string): Promise<TaskRecord> {
    const deadline = Date.now() + this.options.cancellationWaitMs;
    while (Date.now() < deadline) {
      const task = await this.repository.getTask(taskId);
      if (!task) {
        throw new TaskWorkerError(
          "TASK_DISPATCH_STALE",
          "Task disappeared while cancellation was pending.",
        );
      }
      if (task.status === "cancelled") return task;
      if (
        task.status === "completed" ||
        task.status === "expired" ||
        task.status === "failed"
      ) {
        throw new TaskWorkerError(
          "TASK_CANCELLATION_UNACKNOWLEDGED",
          "Task reached another terminal state before cancellation.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new TaskWorkerError(
      "TASK_CANCELLATION_UNACKNOWLEDGED",
      "Task handler did not acknowledge cancellation within the allowed time.",
    );
  }
}

function deterministicLeaseOwner(
  instanceId: string,
  messageId: string,
  jobId: string,
): string {
  return `worker-${createHash("sha256")
    .update(`${instanceId}\u0000${messageId}\u0000${jobId}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}
