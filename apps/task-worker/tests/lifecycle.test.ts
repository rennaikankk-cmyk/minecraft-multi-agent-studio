// ---------------------------------------------------------------------------
// Task Worker 生命周期竞速测试。
//
// 锁定的是"worker 基础设施失败必须被观测到"这一接线属性：此前 main() 只等关闭
// 信号，worker 静默死亡时进程活着却不再处理任务，且没有任何日志。
// ---------------------------------------------------------------------------

import { TaskWorkerError } from "@minecraft-studio/task-system";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_POLL_INTERVAL_MS,
  raceWorkerOutcome,
  waitForShutdownSignal,
  type IntervalHandle,
  type ShutdownSignal,
  type SignalSource,
} from "../src/lifecycle.js";

/** 可手动触发的信号源，并暴露监听器数量以便断言清理。 */
class FakeSignals implements SignalSource {
  private readonly listeners = new Map<ShutdownSignal, Set<() => void>>();

  once(event: ShutdownSignal, listener: () => void): void {
    const set = this.listeners.get(event) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(event, set);
  }

  removeListener(event: ShutdownSignal, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: ShutdownSignal): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

/** 可手动触发的定时器替身。 */
function fakeIntervals(): {
  setInterval: (handler: () => void, ms: number) => IntervalHandle;
  clearInterval: (handle: IntervalHandle) => void;
  tick: () => void;
  readonly armed: boolean;
  readonly clearedCount: number;
  readonly requestedMs: number[];
  readonly unrefCount: number;
} {
  let handler: (() => void) | null = null;
  let clearedCount = 0;
  let unrefCount = 0;
  const requestedMs: number[] = [];
  return {
    setInterval: (next: () => void, ms: number): IntervalHandle => {
      handler = next;
      requestedMs.push(ms);
      return { unref: () => { unrefCount += 1; } };
    },
    clearInterval: (): void => {
      clearedCount += 1;
      handler = null;
    },
    tick: (): void => {
      handler?.();
    },
    get armed(): boolean {
      return handler !== null;
    },
    get clearedCount(): number {
      return clearedCount;
    },
    get requestedMs(): number[] {
      return requestedMs;
    },
    get unrefCount(): number {
      return unrefCount;
    },
  };
}

/** 由测试控制的基础设施失败源。 */
class FakeFailureSource {
  private error: TaskWorkerError | null = null;
  readCount = 0;

  fail(code = "TASK_WORKER_UNAVAILABLE"): void {
    this.error = new TaskWorkerError(code, "worker unavailable");
  }

  getLastInfrastructureError(): TaskWorkerError | null {
    this.readCount += 1;
    return this.error;
  }
}

describe("waitForShutdownSignal", () => {
  it("resolves SIGINT and removes the SIGTERM listener", async () => {
    const signals = new FakeSignals();
    const pending = waitForShutdownSignal(signals);
    expect(signals.listenerCount).toBe(2);
    signals.emit("SIGINT");
    await expect(pending).resolves.toBe("SIGINT");
    expect(signals.listenerCount).toBe(1);
  });

  it("resolves SIGTERM and removes the SIGINT listener", async () => {
    const signals = new FakeSignals();
    const pending = waitForShutdownSignal(signals);
    signals.emit("SIGTERM");
    await expect(pending).resolves.toBe("SIGTERM");
    expect(signals.listenerCount).toBe(1);
  });
});

describe("raceWorkerOutcome", () => {
  it("reports a failure that was already recorded before the race started", async () => {
    // worker 可能在 start() 与本竞速之间就已失败，必须立即检出而不是等轮询。
    const source = new FakeFailureSource();
    source.fail();
    const intervals = fakeIntervals();
    const outcome = await raceWorkerOutcome(source, {
      signals: new FakeSignals(),
      setInterval: intervals.setInterval,
      clearInterval: intervals.clearInterval,
    });
    expect(outcome).toMatchObject({
      kind: "infrastructure-failure",
      error: { code: "TASK_WORKER_UNAVAILABLE" },
    });
    // 立即检出时不应再装定时器
    expect(intervals.armed).toBe(false);
    expect(intervals.requestedMs).toEqual([]);
  });

  it("detects a failure that appears later via polling", async () => {
    const source = new FakeFailureSource();
    const intervals = fakeIntervals();
    const pending = raceWorkerOutcome(source, {
      signals: new FakeSignals(),
      setInterval: intervals.setInterval,
      clearInterval: intervals.clearInterval,
    });

    // 第一次轮询：尚无错误
    intervals.tick();
    source.fail("TASK_PERSISTENCE_FAILED");
    intervals.tick();

    await expect(pending).resolves.toMatchObject({
      kind: "infrastructure-failure",
      error: { code: "TASK_PERSISTENCE_FAILED" },
    });
    expect(intervals.clearedCount).toBe(1);
  });

  it("uses the documented poll interval and unrefs the timer", async () => {
    const source = new FakeFailureSource();
    const intervals = fakeIntervals();
    const pending = raceWorkerOutcome(source, {
      signals: new FakeSignals(),
      setInterval: intervals.setInterval,
      clearInterval: intervals.clearInterval,
    });
    expect(intervals.requestedMs).toEqual([DEFAULT_POLL_INTERVAL_MS]);
    // unref 让定时器不阻止进程退出
    expect(intervals.unrefCount).toBe(1);
    source.fail();
    intervals.tick();
    await pending;
  });

  it("lets the shutdown signal win when no failure occurs", async () => {
    const source = new FakeFailureSource();
    const signals = new FakeSignals();
    const intervals = fakeIntervals();
    const pending = raceWorkerOutcome(source, {
      signals,
      setInterval: intervals.setInterval,
      clearInterval: intervals.clearInterval,
    });
    signals.emit("SIGTERM");
    await expect(pending).resolves.toEqual({ kind: "signal", signal: "SIGTERM" });
  });

  it("cleans up the interval and both listeners whichever side wins", async () => {
    const signals = new FakeSignals();
    const intervals = fakeIntervals();
    const source = new FakeFailureSource();
    const pending = raceWorkerOutcome(source, {
      signals,
      setInterval: intervals.setInterval,
      clearInterval: intervals.clearInterval,
    });
    expect(signals.listenerCount).toBe(2);

    signals.emit("SIGINT");
    await pending;
    expect(intervals.armed).toBe(false);
    expect(intervals.clearedCount).toBe(1);
    expect(signals.listenerCount).toBe(0);

    // 失败侧获胜时同样必须清干净
    const signals2 = new FakeSignals();
    const intervals2 = fakeIntervals();
    const source2 = new FakeFailureSource();
    const pending2 = raceWorkerOutcome(source2, {
      signals: signals2,
      setInterval: intervals2.setInterval,
      clearInterval: intervals2.clearInterval,
    });
    source2.fail();
    intervals2.tick();
    await pending2;
    expect(intervals2.clearedCount).toBe(1);
    expect(signals2.listenerCount).toBe(0);
  });

  it("ignores a second outcome after settling", async () => {
    const signals = new FakeSignals();
    const intervals = fakeIntervals();
    const source = new FakeFailureSource();
    const outcome = await (async () => {
      const pending = raceWorkerOutcome(source, {
        signals,
        setInterval: intervals.setInterval,
        clearInterval: intervals.clearInterval,
      });
      signals.emit("SIGINT");
      // 结束后再制造失败与信号，不得改变已定结果
      source.fail();
      intervals.tick();
      signals.emit("SIGTERM");
      return await pending;
    })();
    expect(outcome).toEqual({ kind: "signal", signal: "SIGINT" });
  });
});
