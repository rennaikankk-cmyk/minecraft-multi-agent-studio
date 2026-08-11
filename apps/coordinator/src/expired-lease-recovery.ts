import { randomUUID } from "node:crypto";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  MAX_EXPIRED_LEASE_BATCH_SIZE,
  TaskSystemError,
  type RecoverExpiredLeaseResult,
  type TaskLeaseExpireCommand,
  type TaskRecord,
} from "@minecraft-studio/task-system";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 300_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONCURRENT_RECOVERY_CODES = new Set([
  "TASK_REVISION_CONFLICT",
  "TASK_LEASE_CONFLICT",
  "TASK_TRANSITION_INVALID",
  "TASK_TERMINAL",
]);

export type ExpiredLeaseRecoveryRepository = Readonly<{
  listExpiredLeases(limit: number): Promise<readonly TaskRecord[]>;
  recoverExpiredLease(
    command: TaskLeaseExpireCommand,
  ): Promise<RecoverExpiredLeaseResult>;
}>;

export type ExpiredLeaseRecoveryResult = Readonly<{
  examined: number;
  requeued: number;
  failedTerminal: number;
  skippedConcurrent: number;
  errors: number;
}>;

export type ExpiredLeaseRecoveryOptions = Readonly<{
  repository: ExpiredLeaseRecoveryRepository;
  actorId: string;
  logger: AppLogger;
  batchSize?: number;
  intervalMs?: number;
  operationIdFactory?: () => string;
}>;

/**
 * Coordinator-owned, bounded recovery loop for PostgreSQL-authoritative leases.
 * The repository performs each lease transition and any new-revision outbox
 * write atomically; this controller only schedules and observes those mutations.
 */
export class ExpiredLeaseRecoveryController {
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly operationIdFactory: () => string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<ExpiredLeaseRecoveryResult> | null = null;

  constructor(private readonly options: ExpiredLeaseRecoveryOptions) {
    if (!IDENTIFIER_PATTERN.test(options.actorId)) {
      throw new TypeError("Expired lease recovery actorId is invalid.");
    }
    this.batchSize = boundedInteger(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      1,
      MAX_EXPIRED_LEASE_BATCH_SIZE,
      "batchSize",
    );
    this.intervalMs = boundedInteger(
      options.intervalMs ?? DEFAULT_INTERVAL_MS,
      100,
      MAX_INTERVAL_MS,
      "intervalMs",
    );
    this.operationIdFactory = options.operationIdFactory ?? randomUUID;
  }

  start(): void {
    if (this.timer !== null) return;
    void this.sweepOnce();
    this.timer = setInterval(() => void this.sweepOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  sweepOnce(): Promise<ExpiredLeaseRecoveryResult> {
    if (this.inFlight !== null) return this.inFlight;
    const sweep = this.executeSweep().finally(() => {
      if (this.inFlight === sweep) this.inFlight = null;
    });
    this.inFlight = sweep;
    return sweep;
  }

  private async executeSweep(): Promise<ExpiredLeaseRecoveryResult> {
    let expired: readonly TaskRecord[];
    try {
      expired = await this.options.repository.listExpiredLeases(this.batchSize);
    } catch (error) {
      this.options.logger.error("coordinator_task_lease_recovery_scan_failed", {
        code: stableErrorCode(error),
      });
      return emptyResult(1);
    }

    let requeued = 0;
    let failedTerminal = 0;
    let skippedConcurrent = 0;
    let errors = 0;

    for (const task of expired) {
      const command: TaskLeaseExpireCommand = {
        schemaVersion: "1.0",
        operationId: this.operationIdFactory(),
        taskId: task.taskId,
        expectedRevision: task.revision,
        actorId: this.options.actorId,
        reasonCode: "TASK_LEASE_EXPIRED",
      };
      try {
        const recovered =
          await this.options.repository.recoverExpiredLease(command);
        if (
          recovered.task.status === "queued" &&
          recovered.task.revision === task.revision + 1 &&
          recovered.dispatch !== null &&
          recovered.dispatch.taskId === task.taskId &&
          recovered.dispatch.payload.expectedRevision ===
            recovered.task.revision &&
          recovered.outbox !== null &&
          recovered.outbox.taskId === task.taskId &&
          recovered.outbox.expectedRevision === recovered.task.revision
        ) {
          requeued += 1;
        } else if (
          recovered.task.status === "failed" &&
          recovered.task.failureReason === "TASK_LEASE_EXPIRED" &&
          recovered.task.revision === task.revision + 1 &&
          recovered.dispatch === null &&
          recovered.outbox === null
        ) {
          failedTerminal += 1;
        } else {
          errors += 1;
          this.options.logger.error(
            "coordinator_task_lease_recovery_result_invalid",
            {
              code: "TASK_LEASE_RECOVERY_RESULT_INVALID",
              taskId: task.taskId,
              expectedRevision: task.revision,
            },
          );
        }
      } catch (error) {
        if (isConcurrentRecovery(error)) {
          skippedConcurrent += 1;
          this.options.logger.warn(
            "coordinator_task_lease_recovery_skipped",
            {
              code: error.code,
              taskId: task.taskId,
              expectedRevision: task.revision,
            },
          );
          continue;
        }
        errors += 1;
        this.options.logger.error("coordinator_task_lease_recovery_failed", {
          code: stableErrorCode(error),
          taskId: task.taskId,
          expectedRevision: task.revision,
        });
      }
    }

    const result = {
      examined: expired.length,
      requeued,
      failedTerminal,
      skippedConcurrent,
      errors,
    };
    if (expired.length > 0 || errors > 0) {
      this.options.logger.info("coordinator_task_lease_recovery_sweep", result);
    }
    return result;
  }
}

function emptyResult(errors: number): ExpiredLeaseRecoveryResult {
  return {
    examined: 0,
    requeued: 0,
    failedTerminal: 0,
    skippedConcurrent: 0,
    errors,
  };
}

function isConcurrentRecovery(error: unknown): error is TaskSystemError {
  return (
    error instanceof TaskSystemError &&
    CONCURRENT_RECOVERY_CODES.has(error.code)
  );
}

function stableErrorCode(error: unknown): string {
  return error instanceof TaskSystemError
    ? error.code
    : "TASK_LEASE_RECOVERY_FAILED";
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `Expired lease recovery ${field} must be between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}
