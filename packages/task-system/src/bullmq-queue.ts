import {
  Queue,
  type ConnectionOptions,
  type Job,
  type JobsOptions,
} from "bullmq";
import {
  taskDispatchV1Schema,
  type TaskDispatchV1,
} from "@minecraft-studio/protocol";

import { parseIsolatedRedisUrl } from "./infrastructure-config.js";
import { taskOperationFingerprint } from "./postgres-repository.js";

export const TASK_DISPATCH_JOB_NAME = "task.dispatch.v1" as const;
export const TASK_QUEUE_OPERATION_TIMEOUT_MS = 5_000;

export type TaskDispatchQueueResult = Readonly<{
  jobId: string;
  accepted: true;
}>;

export class TaskQueueError extends Error {
  constructor(
    readonly code:
      | "TASK_QUEUE_MESSAGE_CONFLICT"
      | "TASK_QUEUE_JOB_ID_INVALID"
      | "TASK_QUEUE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "TaskQueueError";
  }
}

export type BullMqTaskQueueOptions = Readonly<{
  redisUrl: string;
  queueName: string;
  prefix: string;
}>;

const JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: {
    age: 24 * 60 * 60,
    count: 10_000,
  },
  removeOnFail: {
    age: 7 * 24 * 60 * 60,
    count: 10_000,
  },
};

const connectionBase = (redisUrl: string) => ({
  url: parseIsolatedRedisUrl(redisUrl),
  connectTimeout: 5_000,
  enableReadyCheck: true,
});

function queueConnectionOptions(redisUrl: string): ConnectionOptions {
  return {
    ...connectionBase(redisUrl),
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) =>
      attempt <= 3
        ? Math.min(100 * 2 ** (attempt - 1), 1_000)
        : null,
  };
}

function workerConnectionOptions(redisUrl: string): ConnectionOptions {
  return {
    ...connectionBase(redisUrl),
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(100 * 2 ** (attempt - 1), 2_000),
  };
}

async function within<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new TaskQueueError(
                "TASK_QUEUE_UNAVAILABLE",
                timeoutMessage,
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

async function runQueueOperation<T>(
  operation: () => Promise<T>,
  unavailableMessage: string,
): Promise<T> {
  try {
    return await within(
      Promise.resolve().then(operation),
      TASK_QUEUE_OPERATION_TIMEOUT_MS,
      unavailableMessage,
    );
  } catch (error) {
    if (error instanceof TaskQueueError) throw error;
    throw new TaskQueueError(
      "TASK_QUEUE_UNAVAILABLE",
      unavailableMessage,
    );
  }
}

export function taskDispatchJobId(
  taskId: string,
  expectedRevision: number,
): string {
  const taskIdResult =
    taskDispatchV1Schema.shape.taskId.safeParse(taskId);
  const revisionResult =
    taskDispatchV1Schema.shape.payload.shape.expectedRevision.safeParse(
      expectedRevision,
    );
  if (!taskIdResult.success || !revisionResult.success) {
    throw new TaskQueueError(
      "TASK_QUEUE_JOB_ID_INVALID",
      "Task dispatch job ID is invalid.",
    );
  }
  const parsedTaskId = taskIdResult.data;
  const parsedRevision = revisionResult.data;
  const jobId = `${parsedTaskId}-r${parsedRevision}`;
  if (jobId.includes(":")) {
    throw new TaskQueueError(
      "TASK_QUEUE_JOB_ID_INVALID",
      "Task dispatch job ID is invalid.",
    );
  }
  return jobId;
}

export function taskDispatchEquivalenceFingerprint(
  input: unknown,
): string {
  const message = taskDispatchV1Schema.parse(input);
  return taskOperationFingerprint({
    schemaVersion: message.schemaVersion,
    type: message.type,
    taskId: message.taskId,
    botId: message.botId,
    traceId: message.traceId,
    payload: message.payload,
  });
}

function sameDispatch(
  left: TaskDispatchV1,
  right: TaskDispatchV1,
): boolean {
  return (
    taskDispatchEquivalenceFingerprint(left) ===
    taskDispatchEquivalenceFingerprint(right)
  );
}

export class BullMqTaskQueue {
  private readonly queue: Queue<
    TaskDispatchV1,
    TaskWorkerQueueResult,
    typeof TASK_DISPATCH_JOB_NAME
  >;

  constructor(options: BullMqTaskQueueOptions) {
    this.queue = new Queue<
      TaskDispatchV1,
      TaskWorkerQueueResult,
      typeof TASK_DISPATCH_JOB_NAME
    >(options.queueName, {
      connection: queueConnectionOptions(options.redisUrl),
      prefix: options.prefix,
      defaultJobOptions: JOB_OPTIONS,
    });
  }

  async verifyConnection(): Promise<void> {
    try {
      await runQueueOperation(
        async () => await this.queue.waitUntilReady(),
        "Redis task queue readiness timed out.",
      );
      await runQueueOperation(
        async () => await this.queue.getVersion(),
        "Redis task queue version check timed out.",
      );
    } catch {
      throw new TaskQueueError(
        "TASK_QUEUE_UNAVAILABLE",
        "Redis task queue is unavailable.",
      );
    }
  }

  async enqueue(input: unknown): Promise<TaskDispatchQueueResult> {
    const message = taskDispatchV1Schema.parse(input);
    const jobId = taskDispatchJobId(
      message.taskId,
      message.payload.expectedRevision,
    );
    return await runQueueOperation(async () => {
      const existing = await this.queue.getJob(jobId);
      if (existing) {
        const stored = taskDispatchV1Schema.safeParse(existing.data);
        if (!stored.success || !sameDispatch(stored.data, message)) {
          throw new TaskQueueError(
            "TASK_QUEUE_MESSAGE_CONFLICT",
            "Task revision is already queued with different dispatch data.",
          );
        }
        return { jobId, accepted: true as const };
      }

      await this.queue.add(
        TASK_DISPATCH_JOB_NAME,
        message,
        {
          ...JOB_OPTIONS,
          jobId,
        },
      );
      const persisted = await this.queue.getJob(jobId);
      if (!persisted) {
        throw new TaskQueueError(
          "TASK_QUEUE_UNAVAILABLE",
          "Task dispatch disappeared after enqueue.",
        );
      }
      const stored = taskDispatchV1Schema.safeParse(persisted.data);
      if (!stored.success || !sameDispatch(stored.data, message)) {
        throw new TaskQueueError(
          "TASK_QUEUE_MESSAGE_CONFLICT",
          "Concurrent task dispatch used different data for the same revision.",
        );
      }
      return { jobId, accepted: true as const };
    }, "Redis task enqueue failed or timed out.");
  }

  async getJob(
    taskId: string,
    expectedRevision: number,
  ): Promise<Job<
    TaskDispatchV1,
    TaskWorkerQueueResult,
    typeof TASK_DISPATCH_JOB_NAME
  > | null> {
    const jobId = taskDispatchJobId(taskId, expectedRevision);
    return await runQueueOperation(
      async () => (await this.queue.getJob(jobId)) ?? null,
      "Redis task lookup failed or timed out.",
    );
  }

  async remove(
    taskId: string,
    expectedRevision: number,
  ): Promise<boolean> {
    const jobId = taskDispatchJobId(taskId, expectedRevision);
    return await runQueueOperation(
      async () => (await this.queue.remove(jobId)) === 1,
      "Redis task removal failed or timed out.",
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export type TaskWorkerQueueResult = Readonly<{
  schemaVersion: "1.0";
  taskId: string;
  status: "completed" | "cancelled" | "failed" | "already-terminal";
  revision: number;
}>;

export function bullMqTaskConnectionOptions(
  redisUrl: string,
): ConnectionOptions {
  return workerConnectionOptions(redisUrl);
}

export function bullMqTaskQueueConnectionOptions(
  redisUrl: string,
): ConnectionOptions {
  return queueConnectionOptions(redisUrl);
}
