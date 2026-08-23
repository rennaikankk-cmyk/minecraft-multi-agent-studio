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

// BullMQ job states that mean a dispatch is still runnable for this exact task
// revision. Only these are safe to acknowledge as delivered without re-driving.
// Terminal states (completed, failed) and any unrecognized state must trigger a
// fresh re-enqueue so the still-queued durable task never ends up with no
// runnable job (fail-closed: unknown state is treated as not-live).
const LIVE_DISPATCH_JOB_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "waiting-children",
  "prioritized",
  "active",
  "delayed",
]);

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
          delayMs: this.retryDelay(entry.attemptCount + 1),
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
      if (LIVE_DISPATCH_JOB_STATES.has(state)) {
        // A live job is already runnable for this exact task revision. Let the
        // queue adapter compare the existing payload before we acknowledge the
        // durable outbox record.
        await this.options.queue.enqueue(entry.payload);
        return;
      }
      // Any terminal or unrecognized state (completed, failed, unknown, ...)
      // must not be acknowledged as delivered: the durable task is still
      // queued, so a completed/failed job leaves no runnable dispatch. Remove
      // the stale job and re-drive a fresh one (fail-closed on unknown states).
      const removed = await this.options.queue.remove(
        entry.taskId,
        entry.expectedRevision,
      );
      if (!removed) {
        // A false result can mean the job disappeared in the race between
        // getJob() and remove(), or that BullMQ could not remove a locked
        // job.  Only the former is safe to redrive.  Re-read the exact job
        // identity before enqueueing; if it is still present, fail closed so
        // the outbox claim is retried instead of being acknowledged against
        // a non-runnable/unknown job.
        const stillPresent = await this.options.queue.getJob(
          entry.taskId,
          entry.expectedRevision,
        );
        if (stillPresent) {
          throw new Error(
            "Stale task dispatch job could not be removed before redrive.",
          );
        }
      }
    }
    await this.options.queue.enqueue(entry.payload);
  }

  private retryDelay(failureCount: number): number {
    return Math.min(
      this.options.retryMaxMs,
      this.options.retryBaseMs *
        2 ** Math.min(Math.max(0, failureCount - 1), 20),
    );
  }
}
