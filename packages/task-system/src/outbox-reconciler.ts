import type { TaskOutboxRecord } from "./model.js";
import type {
  TaskOutboxAckOptions,
  TaskOutboxClaimOptions,
  TaskOutboxRetryOptions,
} from "./postgres-repository.js";

const MAX_OUTBOX_BATCH_SIZE = 100;
const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 60_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

export type TaskDispatchQueueLike = Readonly<{
  enqueue(input: unknown): Promise<unknown>;
  getJob(
    taskId: string,
    expectedRevision: number,
  ): Promise<Readonly<{ getState: () => Promise<string> }> | null>;
  remove(taskId: string, expectedRevision: number): Promise<boolean>;
}>;

export type TaskOutboxRepositoryLike = Readonly<{
  claimTaskOutbox(
    input: TaskOutboxClaimOptions,
  ): Promise<readonly TaskOutboxRecord[]>;
  markTaskOutboxDelivered(input: TaskOutboxAckOptions): Promise<boolean>;
  retryTaskOutbox(input: TaskOutboxRetryOptions): Promise<boolean>;
}>;

export type TaskOutboxReconcilerOptions = Readonly<{
  repository: TaskOutboxRepositoryLike;
  queue: TaskDispatchQueueLike;
  instanceId: string;
  batchSize?: number;
  claimTtlMs?: number;
  pollIntervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}>;

export type TaskOutboxReconcileResult = Readonly<{
  claimed: number;
  enqueued: number;
  skipped: number;
  failed: number;
}>;

type ResolvedOptions = Readonly<{
  repository: TaskOutboxRepositoryLike;
  queue: TaskDispatchQueueLike;
  instanceId: string;
  batchSize: number;
  claimTtlMs: number;
  pollIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}>;

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `Value must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 4_000);
  return "Task dispatch reconciliation failed.";
}

export class TaskOutboxReconciler {
  private readonly options: ResolvedOptions;
  private runPromise: Promise<void> | null = null;
  private sleepTimer: NodeJS.Timeout | null = null;
  private wakeSleep: (() => void) | null = null;
  private stopping = false;

  constructor(options: TaskOutboxReconcilerOptions) {
    const resolved: ResolvedOptions = {
      repository: options.repository,
      queue: options.queue,
      instanceId: options.instanceId,
      batchSize: clampInteger(
        options.batchSize ?? 25,
        1,
        MAX_OUTBOX_BATCH_SIZE,
      ),
      claimTtlMs: clampInteger(
        options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS,
        1_000,
        5 * 60_000,
      ),
      pollIntervalMs: clampInteger(
        options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        50,
        60_000,
      ),
      retryBaseMs: clampInteger(
        options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
        10,
        60_000,
      ),
      retryMaxMs: clampInteger(
        options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
        100,
        MAX_RETRY_DELAY_MS,
      ),
    };
    if (resolved.retryBaseMs > resolved.retryMaxMs) {
      throw new RangeError("Outbox retry base must not exceed retry maximum.");
    }
    this.options = resolved;
  }

  async reconcileOnce(): Promise<TaskOutboxReconcileResult> {
    const outbox = await this.options.repository.claimTaskOutbox({
      claimerId: this.options.instanceId,
      limit: this.options.batchSize,
      leaseDurationMs: this.options.claimTtlMs,
    });
    let enqueued = 0;
    let failed = 0;
    for (const entry of outbox) {
      try {
        await this.ensureEnqueued(entry);
        const acknowledged = await this.options.repository.markTaskOutboxDelivered(
          {
            messageId: entry.messageId,
            claimerId: this.options.instanceId,
          },
        );
        if (!acknowledged) {
          throw new Error("Task dispatch outbox claim was lost before acknowledgement.");
        }
        enqueued += 1;
      } catch (error) {
        const retryRecorded = await this.options.repository.retryTaskOutbox({
          messageId: entry.messageId,
          claimerId: this.options.instanceId,
          error: errorMessage(error),
          delayMs: this.retryDelay(entry.attemptCount),
        });
        if (!retryRecorded) {
          throw new Error(
            "Task dispatch outbox claim was lost before retry scheduling.",
          );
        }
        failed += 1;
      }
    }
    // claimTaskOutbox filters task status and exact revision in PostgreSQL,
    // so stale outbox rows are never offered to the queue.
    return { claimed: outbox.length, enqueued, skipped: 0, failed };
  }

  async start(): Promise<void> {
    if (this.runPromise) return;
    this.stopping = false;
    this.runPromise = this.runLoop();
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.wakeSleep?.();
    this.wakeSleep = null;
    const running = this.runPromise;
    if (running) await running;
    this.runPromise = null;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.reconcileOnce();
      } catch {
        // The next polling pass retries PostgreSQL or Redis infrastructure failures.
      }
      if (!this.stopping) await this.sleep();
    }
  }

  private async sleep(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.wakeSleep = resolve;
      this.sleepTimer = setTimeout(resolve, this.options.pollIntervalMs);
      this.sleepTimer.unref();
    });
    this.sleepTimer = null;
    this.wakeSleep = null;
  }

  private async ensureEnqueued(entry: TaskOutboxRecord): Promise<void> {
    const existing = await this.options.queue.getJob(
      entry.taskId,
      entry.expectedRevision,
    );
    if (existing) {
      const state = await existing.getState();
      if (state === "failed") {
        await this.options.queue.remove(entry.taskId, entry.expectedRevision);
      } else {
        // Let the queue adapter compare the existing job payload before
        // acknowledging the durable outbox record.
        await this.options.queue.enqueue(entry.payload);
        return;
      }
    }
    await this.options.queue.enqueue(entry.payload);
  }

  private retryDelay(attemptCount: number): number {
    return Math.min(
      this.options.retryMaxMs,
      this.options.retryBaseMs * 2 ** Math.min(Math.max(0, attemptCount - 1), 20),
    );
  }
}
