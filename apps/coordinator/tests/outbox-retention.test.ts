import type { AppLogger } from "@minecraft-studio/observability";
import { TaskSystemError } from "@minecraft-studio/task-system";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OutboxRetentionController } from "../src/outbox-retention.js";

function logger(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as AppLogger;
}

function repository(
  purge: (input: { deliveredBeforeMs: number; limit: number }) => Promise<number>,
) {
  return { purgeDeliveredOutbox: vi.fn(purge) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OutboxRetentionController", () => {
  it("rejects invalid interval, retention and batch options", () => {
    const base = { repository: repository(async () => 0), logger: logger() };
    expect(() => new OutboxRetentionController({ ...base, intervalMs: 999 })).toThrow(RangeError);
    expect(() => new OutboxRetentionController({ ...base, intervalMs: 3_600_001 })).toThrow(RangeError);
    expect(() => new OutboxRetentionController({ ...base, retentionMs: 59_999 })).toThrow(RangeError);
    expect(() => new OutboxRetentionController({ ...base, batchSize: 0 })).toThrow(RangeError);
    expect(() => new OutboxRetentionController({ ...base, batchSize: 1_001 })).toThrow(RangeError);
    expect(() => new OutboxRetentionController(base)).not.toThrow();
  });

  it("purges with the configured retention window and batch size, logging only non-zero sweeps", async () => {
    const store = repository(async () => 0);
    const log = logger();
    const controller = new OutboxRetentionController({
      repository: store,
      logger: log,
      retentionMs: 86_400_000,
      batchSize: 5,
    });

    await expect(controller.sweepOnce()).resolves.toEqual({ purged: 0 });
    expect(store.purgeDeliveredOutbox).toHaveBeenCalledWith({
      deliveredBeforeMs: 86_400_000,
      limit: 5,
    });
    expect(log.info).not.toHaveBeenCalled();

    store.purgeDeliveredOutbox.mockResolvedValueOnce(7);
    await expect(controller.sweepOnce()).resolves.toEqual({ purged: 7 });
    expect(log.info).toHaveBeenCalledWith(
      "coordinator_outbox_retention_purged",
      { purged: 7, retentionMs: 86_400_000 },
    );
  });

  it("survives repository failures with a stable error code and keeps sweeping", async () => {
    const store = repository(async () => {
      throw new TaskSystemError("TASK_PERSISTENCE_FAILED", "pg down");
    });
    const log = logger();
    const controller = new OutboxRetentionController({
      repository: store,
      logger: log,
    });

    await expect(controller.sweepOnce()).resolves.toEqual({ purged: 0 });
    expect(log.error).toHaveBeenCalledWith("coordinator_outbox_retention_failed", {
      code: "TASK_PERSISTENCE_FAILED",
    });

    store.purgeDeliveredOutbox.mockResolvedValueOnce(3);
    await expect(controller.sweepOnce()).resolves.toEqual({ purged: 3 });
  });

  it("never overlaps sweeps and stops cleanly", async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    const store = repository(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(2);
        }),
    );
    const controller = new OutboxRetentionController({
      repository: store,
      logger: logger(),
      intervalMs: 1_000,
    });

    const first = controller.sweepOnce();
    const duplicate = controller.sweepOnce();
    expect(duplicate).toBe(first);

    release?.();
    await expect(first).resolves.toEqual({ purged: 2 });
    expect(store.purgeDeliveredOutbox).toHaveBeenCalledTimes(1);

    controller.start();
    vi.advanceTimersByTime(1_000);
    release?.();
    await Promise.resolve();
    expect(store.purgeDeliveredOutbox).toHaveBeenCalledTimes(2);
    await controller.stop();
    const callsAfterStop = store.purgeDeliveredOutbox.mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(store.purgeDeliveredOutbox).toHaveBeenCalledTimes(callsAfterStop);
  });
});
