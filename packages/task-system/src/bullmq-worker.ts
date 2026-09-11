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
  reasonCodeSchema,
  taskEvidenceSchema,
  type TaskCancellationRequest,
  type TaskRecord,
} from "./model.js";
import { PostgresTaskRepository } from "./postgres-repository.js";
import {
  TASK_RETRY_SCHEDULED_REASON_CODE,
  planTaskRecordRetry,
  taskFailureCauseCode,
} from "./retry-policy.js";

const taskHandlerResultSchema = z
  .object({
    result: skillJsonValueSchema.nullable(),
    evidence: z.array(taskEvidenceSchema).max(64),
    terminal: z
      .discriminatedUnion("status", [
        z
          .object({
            status: z.literal("failed"),
            failureReason: z
              .string()
              .min(3)
              .max(128)
              .regex(/^[A-Z][A-Z0-9_]*$/u),
          })
          .strict(),
        z
          .object({
            status: z.enum(["completed", "cancelled", "expired"]),
            failureReason: z.null().optional(),
          })
          .strict(),
      ])
      .optional(),
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
    cancellationPollIntervalMs: z
      .number()
      .int()
      .min(50)
      .max(10_000)
      .default(250),
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
    if (value.cancellationPollIntervalMs > value.cancellationWaitMs) {
      context.addIssue({
        code: "custom",
        path: ["cancellationPollIntervalMs"],
        message:
          "Cancellation polling must occur within the caller wait window.",
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
  abortExecution: ((reason: TaskWorkerError) => void) | null;
};

export type TaskHandlerResult = Readonly<{
  result: SkillJsonValue | null;
  evidence: readonly z.infer<typeof taskEvidenceSchema>[];
  terminal?:
    | Readonly<{ status: "failed"; failureReason: string }>
    | Readonly<{
        status: "completed" | "cancelled" | "expired";
        failureReason?: null;
      }>;
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
  /**
   * AGENTS.md §5 "可重试错误集合": the stable codes this handler declares as
   * retryable. It is an opt-in extension of the platform retry policy
   * (retry-policy.ts) and it can never mark a safety, permission or schema
   * code as retryable — those classes stay terminal.
   */
  retryableErrorCodes?: readonly string[];
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
    const retryableErrorCodes = (definition.retryableErrorCodes ?? []).map(
      (code) => reasonCodeSchema.parse(code),
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
      Object.freeze({
        ...definition,
        taskType,
        handlerVersion,
        ...(definition.retryableErrorCodes === undefined
          ? {}
          : { retryableErrorCodes: Object.freeze(retryableErrorCodes) }),
      }),
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

function cancellationCommand(
  request: TaskCancellationRequest,
): CancelTaskCommand {
  return cancelTaskCommandSchema.parse({
    schemaVersion: "1.0",
    operationId: request.operationId,
    taskId: request.taskId,
    actorId: request.actorId,
    reasonCode: request.reasonCode,
  });
}

function sameCancellation(
  left: CancelTaskCommand,
  right: CancelTaskCommand,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.taskId === right.taskId &&
    left.actorId === right.actorId &&
    left.reasonCode === right.reasonCode
  );
}

async function waitUntilPolled(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  if (task.status === "failed") {
    return {
      schemaVersion: "1.0",
      taskId: task.taskId,
      status: "failed",
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

function requiredTerminalResult(task: TaskRecord): TaskWorkerQueueResult {
  const result = terminalResult(task);
  if (result) return result;
  throw new TaskWorkerError(
    "TASK_WORKER_UNAVAILABLE",
    "Task mutation did not produce a durable terminal state.",
  );
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
      this.closing = true;
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
    const requested = cancelTaskCommandSchema.parse(input);
    const request = await this.repository.requestTaskCancellation({
      operationId: requested.operationId,
      taskId: requested.taskId,
      actorId: requested.actorId,
      reasonCode: requested.reasonCode,
    });
    const command = cancellationCommand(request);
    const active = this.activeExecutionByTask.get(command.taskId);
    if (active) {
      this.attachCancellation(active, command);
      if (request.acknowledgedAt === null) {
        await this.repository.acknowledgeTaskCancellation({
          taskId: command.taskId,
          acknowledgedBy: active.leaseOwner,
          leaseOwner: active.leaseOwner,
        });
      }
      this.abortActiveExecution(active);
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
    if (
      current.status === "completed" ||
      current.status === "expired"
    ) {
      throw new TaskWorkerError(
        "TASK_CANCELLATION_UNACKNOWLEDGED",
        "Task reached another terminal state before cancellation.",
      );
    }
    if (current.status === "assigned" || current.status === "running") {
      return await this.waitForCancellation(command.taskId);
    }
    try {
      const resolved = await this.repository.resolveTaskCancellation({
        taskId: command.taskId,
        resolverId: this.options.instanceId,
        leaseOwner: null,
      });
      if (resolved) return resolved.task;
    } catch (error) {
      if (!isCancellationOwnershipRace(error)) throw error;
    }
    return await this.waitForCancellation(command.taskId);
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
      leaseOwner:
        dispatch.payload.assignmentLeaseOwner ??
        deterministicLeaseOwner(this.options.instanceId, dispatch.messageId, jobId),
      cancellation: null,
      abortExecution: null,
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
        task.dispatchBotId !== null &&
        task.dispatchBotId !== dispatch.botId
      ) {
        throw new TaskWorkerError(
          "TASK_DISPATCH_STALE",
          "Task dispatch Bot target does not match PostgreSQL.",
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

      const cancelledBeforeRecovery = await this.cancelIfRequested(
        task,
        active,
        workerSignal,
      );
      if (cancelledBeforeRecovery) return cancelledBeforeRecovery;

      let recovery: Awaited<ReturnType<BullMqTaskWorker["recoverStalledTask"]>>;
      try {
        recovery = await this.recoverStalledTask(
          task,
          dispatch,
          handler,
          job.attemptsStarted,
        );
      } catch (error) {
        const cancelled = await this.resolvePendingCancellation(
          error,
          task.taskId,
          active,
        );
        if (cancelled) return requiredTerminalResult(cancelled);
        throw error;
      }
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
      const preassigned =
        task.status === "assigned" &&
        dispatch.payload.assignmentLeaseOwner !== undefined &&
        task.assignedBotId === dispatch.botId &&
        task.leaseOwner === dispatch.payload.assignmentLeaseOwner;
      if (task.status !== "queued" && !preassigned) {
        throw new TaskWorkerError(
          "TASK_DISPATCH_STALE",
          "Task is not ready for dispatch or does not own the assignment lease.",
        );
      }

      const cancelledBeforeLease = await this.cancelIfRequested(
        task,
        active,
        workerSignal,
      );
      if (cancelledBeforeLease) return cancelledBeforeLease;

      if (!preassigned) {
        try {
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
        } catch (error) {
          const cancelled = await this.resolvePendingCancellation(
            error,
            task.taskId,
            active,
          );
          if (cancelled) return requiredTerminalResult(cancelled);
          throw error;
        }
      }
      const cancelledAfterLease = await this.cancelIfRequested(
        task,
        active,
        workerSignal,
      );
      if (cancelledAfterLease) return cancelledAfterLease;

      try {
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
      } catch (error) {
        const cancelled = await this.resolvePendingCancellation(
          error,
          task.taskId,
          active,
        );
        if (cancelled) return requiredTerminalResult(cancelled);
        throw error;
      }
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
    // A preassigned dispatch owns the task row lease before it reaches this
    // worker. A BullMQ redelivery while the task is still `assigned` must
    // reuse that lease; expiring it here would race the Coordinator recovery
    // loop and create a second revision/outbox.
    if (
      dispatch.payload.assignmentLeaseOwner !== undefined &&
      task.status === "assigned"
    ) {
      return { task, recoveredFromThisDispatch: false };
    }
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
    let cancellationMonitorError: unknown = null;
    let stopRenewal = false;
    let timedOut = false;
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
    const executionController = new AbortController();
    const renewalController = new AbortController();
    const cancellationController = new AbortController();
    active.abortExecution = (reason) => executionController.abort(reason);
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
    const cancellationPromise = this.monitorTaskCancellation(
      initialTask.taskId,
      active,
      cancellationController.signal,
    ).catch((error: unknown) => {
      cancellationMonitorError = error;
      executionController.abort(
        new TaskWorkerError(
          "TASK_WORKER_UNAVAILABLE",
          "Task cancellation monitor became unavailable.",
        ),
      );
    });
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
      cancellationController.abort();
      await renewalPromise;
      await cancellationPromise;
      active.abortExecution = null;
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

    await this.syncPersistedCancellation(currentTask, active);
    if (active.cancellation) {
      return await this.resolveCancellation(currentTask, active);
    }
    const expiredAfterExecution = await this.finalizeExpiredBudget(
      currentTask,
      dispatch,
      active,
    );
    if (expiredAfterExecution) {
      return requiredTerminalResult(expiredAfterExecution);
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
    if (cancellationMonitorError !== null) {
      throw new TaskWorkerError(
        "TASK_WORKER_UNAVAILABLE",
        "Task cancellation state could not be verified before persistence.",
      );
    }
    if (timedOut) {
      const failed = await this.failTask(currentTask, dispatch, active, {
        failureReason: "TASK_TIMEOUT_EXPIRED",
      });
      return requiredTerminalResult(failed);
    }
    if (handlerError !== null || handlerResult === null) {
      const failed = await this.failTask(currentTask, dispatch, active, {
        failureReason: "TASK_HANDLER_FAILED",
        cause: handlerError,
        retryableErrorCodes: handler.retryableErrorCodes,
      });
      return requiredTerminalResult(failed);
    }

    const expiredBeforeCompletion = await this.finalizeExpiredBudget(
      currentTask,
      dispatch,
      active,
    );
    if (expiredBeforeCompletion) {
      return requiredTerminalResult(expiredBeforeCompletion);
    }

    const handlerTerminal = handlerResult.terminal ?? {
      status: "completed" as const,
      failureReason: null,
    };
    let completed: TaskRecord;
    try {
      completed = await this.repository.transition({
        schemaVersion: "1.0",
        operationId: deterministicOperationId(
          dispatch.messageId,
          `task-${handlerTerminal.status}`,
          currentTask.revision,
        ),
        taskId: currentTask.taskId,
        expectedRevision: currentTask.revision,
        actorId: this.options.instanceId,
        to: handlerTerminal.status,
        reasonCode:
          handlerTerminal.status === "completed"
            ? "TASK_HANDLER_COMPLETED"
            : handlerTerminal.status === "failed"
              ? handlerTerminal.failureReason
              : `TASK_HANDLER_${handlerTerminal.status.toUpperCase()}`,
        leaseOwner: active.leaseOwner,
        failureReason:
          handlerTerminal.status === "failed"
            ? handlerTerminal.failureReason
            : null,
        result: handlerResult.result,
        evidence: handlerResult.evidence,
      });
    } catch (error) {
      const cancelled = await this.resolvePendingCancellation(
        error,
        currentTask.taskId,
        active,
      );
      if (cancelled) return requiredTerminalResult(cancelled);
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
        active,
      );
      if (budgetTerminal) {
        return requiredTerminalResult(budgetTerminal);
      }
      throw new TaskWorkerError(
        "TASK_LEASE_LOST",
        "Task lease expired before completion could be recorded.",
      );
    }
    return requiredTerminalResult(completed);
  }

  private async finalizeExpiredBudget(
    task: TaskRecord,
    dispatch: TaskDispatchV1,
    active: ActiveTaskExecution,
  ): Promise<TaskRecord | null> {
    const leaseOwner = active.leaseOwner;
    if (task.status !== "running" || task.leaseOwner !== leaseOwner) {
      return null;
    }
    const now = await this.repository.getDatabaseTime();
    if (task.deadline !== null && Date.parse(task.deadline) <= now.getTime()) {
      try {
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
      } catch (error) {
        const cancelled = await this.resolvePendingCancellation(
          error,
          task.taskId,
          active,
        );
        if (cancelled) return cancelled;
        throw error;
      }
    }
    if (
      task.startedAt !== null &&
      Date.parse(task.startedAt) + task.timeoutMs <= now.getTime()
    ) {
      return await this.failTask(task, dispatch, active, {
        failureReason: "TASK_TIMEOUT_EXPIRED",
      });
    }
    return null;
  }

  /**
   * Persists the terminal `failed` status and then, when the failure is
   * retryable and the task still owns retry budget, schedules the bounded
   * re-dispatch. The returned record always describes this attempt
   * (`failed`), because the durable outcome of this execution is the failure;
   * a scheduled retry is a new revision owned by the outbox reconciler.
   */
  private async failTask(
    task: TaskRecord,
    dispatch: TaskDispatchV1,
    active: ActiveTaskExecution,
    failure: Readonly<{
      failureReason: "TASK_TIMEOUT_EXPIRED" | "TASK_HANDLER_FAILED";
      cause?: unknown;
      retryableErrorCodes?: readonly string[] | undefined;
    }>,
  ): Promise<TaskRecord> {
    let failed: TaskRecord;
    try {
      failed = await this.repository.transition({
        schemaVersion: "1.0",
        operationId: deterministicOperationId(
          dispatch.messageId,
          failure.failureReason,
          task.revision,
        ),
        taskId: task.taskId,
        expectedRevision: task.revision,
        actorId: this.options.instanceId,
        to: "failed",
        reasonCode: failure.failureReason,
        leaseOwner: active.leaseOwner,
        failureReason: failure.failureReason,
        result: null,
        evidence: [],
      });
    } catch (error) {
      const cancelled = await this.resolvePendingCancellation(
        error,
        task.taskId,
        active,
      );
      if (cancelled) return cancelled;
      throw error;
    }
    await this.scheduleRetryableRequeue(failed, dispatch, failure);
    return failed;
  }

  /**
   * AGENTS.md §5: a retryable failure is retried with bounded exponential
   * backoff and jitter while the budget lasts. The `failed` status is already
   * durable when this runs, so the requeue goes through the same durable
   * `failed -> queued` transition the operator recovery path uses
   * (postgres-repository.ts `retryTaskDispatch`), which charges the retry
   * budget, clears the failure reason and creates the next revision's dispatch
   * outbox atomically. The backoff is carried by that row's `available_at`, so
   * a crashed worker cannot lose or early-deliver the scheduled retry.
   *
   * The operation ID is derived from the dispatch and the failed revision:
   * a redelivery of the same failure replays the recorded operation instead of
   * consuming a second retry, and only the worker holding the execution lease
   * can reach this point (state-machine.ts `assertActiveLease`).
   */
  private async scheduleRetryableRequeue(
    failed: TaskRecord,
    dispatch: TaskDispatchV1,
    failure: Readonly<{
      failureReason: "TASK_TIMEOUT_EXPIRED" | "TASK_HANDLER_FAILED";
      cause?: unknown;
      retryableErrorCodes?: readonly string[] | undefined;
    }>,
  ): Promise<void> {
    const plan = planTaskRecordRetry(failed, {
      causeCode: taskFailureCauseCode(failure.cause),
      retryableErrorCodes: failure.retryableErrorCodes,
    });
    if (!plan) return;
    try {
      await this.repository.retryTaskDispatch({
        schemaVersion: "1.0",
        operationId: deterministicOperationId(
          dispatch.messageId,
          "failure-requeue",
          failed.revision,
        ),
        taskId: failed.taskId,
        expectedRevision: failed.revision,
        actorId: this.options.instanceId,
        reasonCode: TASK_RETRY_SCHEDULED_REASON_CODE,
        delayMs: plan.delayMs,
      });
    } catch (error) {
      // A refusal means another durable actor already decided the task's fate
      // (cancelled, terminal, budget exhausted, concurrent transition). The
      // recorded `failed` status stands; the retry is simply not performed.
      if (isRetryRequeueRefusal(error)) return;
      throw error;
    }
  }

  private attachCancellation(
    active: ActiveTaskExecution,
    command: CancelTaskCommand,
  ): void {
    if (active.cancellation && !sameCancellation(active.cancellation, command)) {
      throw new TaskWorkerError(
        "TASK_CANCELLATION_CONFLICT",
        "Task already has a different cancellation request in progress.",
      );
    }
    active.cancellation = command;
  }

  private abortActiveExecution(active: ActiveTaskExecution): void {
    const cancellation = active.cancellation;
    if (!cancellation) return;
    const reason = new TaskWorkerError(
      "TASK_EXECUTION_CANCELLED",
      "Task execution has a durable cancellation request.",
    );
    if (active.abortExecution) {
      active.abortExecution(reason);
      return;
    }
    this.worker.cancelJob(active.jobId, cancellation.reasonCode);
  }

  private async syncPersistedCancellation(
    task: TaskRecord,
    active: ActiveTaskExecution,
  ): Promise<void> {
    const request = await this.repository.getTaskCancellationRequest(task.taskId);
    if (!request) return;
    this.attachCancellation(active, cancellationCommand(request));
    if (
      request.acknowledgedAt === null &&
      (task.status === "assigned" || task.status === "running") &&
      task.leaseOwner === active.leaseOwner
    ) {
      const acknowledged = await this.repository.acknowledgeTaskCancellation({
        taskId: task.taskId,
        acknowledgedBy: active.leaseOwner,
        leaseOwner: active.leaseOwner,
      });
      if (!acknowledged) {
        const latest = await this.repository.getTaskCancellationRequest(
          task.taskId,
        );
        if (!latest?.acknowledgedAt) {
          throw new TaskWorkerError(
            "TASK_LEASE_LOST",
            "Task cancellation could not be acknowledged by the lease owner.",
          );
        }
      }
    }
  }

  private async monitorTaskCancellation(
    taskId: string,
    active: ActiveTaskExecution,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const task = await this.repository.getTask(taskId);
      if (!task || terminalResult(task)) return;
      await this.syncPersistedCancellation(task, active);
      if (active.cancellation) {
        this.abortActiveExecution(active);
        return;
      }
      await waitUntilPolled(
        this.options.cancellationPollIntervalMs,
        signal,
      );
    }
  }

  private async resolveCancellation(
    task: TaskRecord,
    active: ActiveTaskExecution,
  ): Promise<TaskWorkerQueueResult> {
    return requiredTerminalResult(
      await this.resolveCancellationTask(task, active),
    );
  }

  private async resolveCancellationTask(
    task: TaskRecord,
    active: ActiveTaskExecution,
  ): Promise<TaskRecord> {
    if (!active.cancellation) {
      throw new TaskWorkerError(
        "TASK_CANCELLATION_UNACKNOWLEDGED",
        "Task cancellation resolution was requested without durable intent.",
      );
    }
    const activeLeaseOwner =
      (task.status === "assigned" || task.status === "running") &&
      task.leaseOwner === active.leaseOwner
        ? active.leaseOwner
        : null;
    const resolved = await this.repository.resolveTaskCancellation({
      taskId: task.taskId,
      resolverId: this.options.instanceId,
      leaseOwner: activeLeaseOwner,
    });
    if (!resolved) {
      throw new TaskWorkerError(
        "TASK_CANCELLATION_UNACKNOWLEDGED",
        "Durable cancellation request disappeared before resolution.",
      );
    }
    return resolved.task;
  }

  private async resolvePendingCancellation(
    error: unknown,
    taskId: string,
    active: ActiveTaskExecution,
  ): Promise<TaskRecord | null> {
    if (
      !(error instanceof TaskSystemError) ||
      error.code !== "TASK_CANCELLATION_PENDING"
    ) {
      return null;
    }
    const latest = await this.repository.getTask(taskId);
    if (!latest) {
      throw new TaskWorkerError(
        "TASK_LEASE_LOST",
        "Task disappeared while durable cancellation was pending.",
      );
    }
    await this.syncPersistedCancellation(latest, active);
    if (!active.cancellation) {
      throw new TaskWorkerError(
        "TASK_WORKER_UNAVAILABLE",
        "Task reported pending cancellation without durable request state.",
      );
    }
    return await this.resolveCancellationTask(latest, active);
  }

  private async cancelIfRequested(
    task: TaskRecord,
    active: ActiveTaskExecution,
    workerSignal?: AbortSignal,
  ): Promise<TaskWorkerQueueResult | null> {
    await this.syncPersistedCancellation(task, active);
    if (!active.cancellation) {
      if (workerSignal?.aborted) throw abortError(workerSignal);
      return null;
    }
    return await this.resolveCancellation(task, active);
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
        task.status === "expired"
      ) {
        throw new TaskWorkerError(
          "TASK_CANCELLATION_UNACKNOWLEDGED",
          "Task reached another terminal state before cancellation.",
        );
      }
      const inactive =
        task.status !== "assigned" && task.status !== "running";
      const leasePossiblyExpired =
        !inactive &&
        task.leaseExpiresAt !== null &&
        Date.parse(task.leaseExpiresAt) <= Date.now();
      if (inactive || leasePossiblyExpired) {
        try {
          const resolved = await this.repository.resolveTaskCancellation({
            taskId,
            resolverId: this.options.instanceId,
            leaseOwner: null,
          });
          if (resolved) return resolved.task;
        } catch (error) {
          if (!isCancellationOwnershipRace(error)) throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new TaskWorkerError(
      "TASK_CANCELLATION_UNACKNOWLEDGED",
      "Task handler did not acknowledge cancellation within the allowed time.",
    );
  }
}

function isCancellationOwnershipRace(error: unknown): boolean {
  return (
    error instanceof TaskSystemError &&
    [
      "TASK_LEASE_REQUIRED",
      "TASK_LEASE_OWNER_MISMATCH",
      "TASK_REVISION_CONFLICT",
      "TASK_TRANSITION_INVALID",
      "TASK_CANCELLATION_PENDING",
      "TASK_TERMINAL",
    ].includes(error.code)
  );
}

/**
 * Durable reasons a scheduled retry is intentionally not performed: the budget
 * is spent, another path made the task terminal (cancelled/expired/completed),
 * the cancelled-or-changed task no longer accepts the transition, or the task
 * changed underneath this worker. They are not infrastructure failures, so the
 * already-durable `failed` outcome is returned as-is.
 */
function isRetryRequeueRefusal(error: unknown): boolean {
  return (
    error instanceof TaskSystemError &&
    [
      "TASK_RETRY_EXHAUSTED",
      "TASK_TERMINAL",
      "TASK_TRANSITION_INVALID",
      "TASK_DEADLINE_EXPIRED",
      "TASK_CANCELLATION_PENDING",
      "TASK_REVISION_CONFLICT",
      "TASK_LEASE_REQUIRED",
      "TASK_LEASE_OWNER_MISMATCH",
      "TASK_LEASE_EXPIRED",
      "TASK_LEASE_CONFLICT",
      "TASK_NOT_FOUND",
    ].includes(error.code)
  );
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
