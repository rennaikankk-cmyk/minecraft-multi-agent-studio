import type { AppLogger } from "@minecraft-studio/observability";
import {
  MAX_OUTBOX_RETENTION_BATCH_SIZE,
  MIN_OUTBOX_RETENTION_MS,
  TaskSystemError,
} from "@minecraft-studio/task-system";

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 3_600_000;
/** 与 BullMQ 侧 removeOnComplete 的 24h 对齐：事实源不比队列侧更短保留。 */
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000;

export type OutboxRetentionRepository = Readonly<{
  purgeDeliveredOutbox(input: {
    deliveredBeforeMs: number;
    limit: number;
  }): Promise<number>;
  purgeResolvedCancellations(input: {
    requestedBeforeMs: number;
    limit: number;
  }): Promise<number>;
}>;

export type OutboxRetentionResult = Readonly<{
  purgedOutbox: number;
  purgedCancellations: number;
}>;

export type OutboxRetentionOptions = Readonly<{
  repository: OutboxRetentionRepository;
  logger: AppLogger;
  intervalMs?: number;
  retentionMs?: number;
  batchSize?: number;
}>;

/**
 * Coordinator 拥有的有界保留清扫循环（与 ExpiredLeaseRecoveryController
 * 同构）：repository 执行删除并承担全部 WHERE 语义（只删终态任务 +
 * 超过保留期的死行），本控制器只调度与观察。同一节拍清扫两张死数据表：
 * studio_task_outbox 的 delivered 行与 studio_task_cancellation_requests
 * 的终态请求行。此前 task-system 全库无任何 DELETE，两张表在长运行
 * 部署下无界增长。
 */
export class OutboxRetentionController {
  private readonly intervalMs: number;
  private readonly retentionMs: number;
  private readonly batchSize: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<OutboxRetentionResult> | null = null;

  constructor(private readonly options: OutboxRetentionOptions) {
    if (!Number.isInteger(options.intervalMs ?? DEFAULT_INTERVAL_MS)) {
      throw new TypeError("Outbox retention intervalMs must be an integer.");
    }
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.intervalMs < 1_000 || this.intervalMs > MAX_INTERVAL_MS) {
      throw new RangeError(
        `Outbox retention intervalMs must be between 1000 and ${MAX_INTERVAL_MS}.`,
      );
    }
    if (!Number.isInteger(options.retentionMs ?? DEFAULT_RETENTION_MS)) {
      throw new TypeError("Outbox retentionMs must be an integer.");
    }
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    if (this.retentionMs < MIN_OUTBOX_RETENTION_MS) {
      throw new RangeError(
        `Outbox retentionMs must be at least ${MIN_OUTBOX_RETENTION_MS}.`,
      );
    }
    this.batchSize = options.batchSize ?? MAX_OUTBOX_RETENTION_BATCH_SIZE;
    if (
      !Number.isInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > MAX_OUTBOX_RETENTION_BATCH_SIZE
    ) {
      throw new RangeError(
        `Outbox retention batchSize must be between 1 and ${MAX_OUTBOX_RETENTION_BATCH_SIZE}.`,
      );
    }
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

  sweepOnce(): Promise<OutboxRetentionResult> {
    if (this.inFlight !== null) return this.inFlight;
    const sweep = this.executeSweep().finally(() => {
      if (this.inFlight === sweep) this.inFlight = null;
    });
    this.inFlight = sweep;
    return sweep;
  }

  private async executeSweep(): Promise<OutboxRetentionResult> {
    // 两张死数据表同一节拍清扫；一张失败不阻断另一张（各自稳定错误码）。
    let purgedOutbox = 0;
    try {
      purgedOutbox = await this.options.repository.purgeDeliveredOutbox({
        deliveredBeforeMs: this.retentionMs,
        limit: this.batchSize,
      });
    } catch (error) {
      this.options.logger.error("coordinator_outbox_retention_failed", {
        code: error instanceof TaskSystemError
          ? error.code
          : "OUTBOX_RETENTION_FAILED",
      });
    }
    let purgedCancellations = 0;
    try {
      purgedCancellations = await this.options.repository.purgeResolvedCancellations({
        requestedBeforeMs: this.retentionMs,
        limit: this.batchSize,
      });
    } catch (error) {
      this.options.logger.error(
        "coordinator_cancellation_retention_failed",
        {
          code: error instanceof TaskSystemError
            ? error.code
            : "CANCELLATION_RETENTION_FAILED",
        },
      );
    }
    if (purgedOutbox > 0 || purgedCancellations > 0) {
      this.options.logger.info("coordinator_task_retention_purged", {
        purgedOutbox,
        purgedCancellations,
        retentionMs: this.retentionMs,
      });
    }
    return { purgedOutbox, purgedCancellations };
  }
}
