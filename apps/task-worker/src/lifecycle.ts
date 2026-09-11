// ---------------------------------------------------------------------------
// Task Worker 生命周期：关闭信号与"基础设施失败"的竞速。
//
// 背景（2026-09-11 实测）：main() 此前只 `await waitForShutdownSignal()`，
// worker.start() 之后没有任何东西观测 worker 失败。而 BullMqTaskWorker 在
// "error" 事件与 worker.run() 拒绝时只把错误记进 lastInfrastructureError，
// 且其 getter `getLastInfrastructureError()` 全仓库**零调用者**——结果是
// worker 静默死亡时进程仍然活着、却不再处理任何任务，也没有任何日志。
//
// 本模块给出可注入、可单测的竞速：信号（正常关闭）或基础设施失败（非零退出，
// 交由外部 supervisor 重启）。不在这里做进程退出决策，只返回结果。
// ---------------------------------------------------------------------------

import type { TaskWorkerError } from "@minecraft-studio/task-system";

export type ShutdownSignal = "SIGINT" | "SIGTERM";

/** worker 侧唯一被本模块观测的方法；BullMqTaskWorker 满足该形状。 */
export interface InfrastructureFailureSource {
  getLastInfrastructureError(): TaskWorkerError | null;
}

export type WorkerOutcome =
  | Readonly<{ kind: "signal"; signal: ShutdownSignal }>
  | Readonly<{ kind: "infrastructure-failure"; error: TaskWorkerError }>;

/** 只用到 once/removeListener，便于测试替换成假实现。 */
export interface SignalSource {
  once(event: ShutdownSignal, listener: () => void): unknown;
  removeListener(event: ShutdownSignal, listener: () => void): unknown;
}

export interface IntervalHandle {
  unref?: () => void;
}

export interface LifecycleDependencies {
  readonly signals?: SignalSource;
  readonly setInterval?: (handler: () => void, ms: number) => IntervalHandle;
  readonly clearInterval?: (handle: IntervalHandle) => void;
  readonly pollIntervalMs?: number;
}

/**
 * 基础设施失败的轮询间隔。BullMqTaskWorker 不提供事件通知，只能轮询它已经
 * 记录好的错误；1s 的检测延迟对"worker 静默死亡"这一场景足够。
 */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

export function waitForShutdownSignal(
  signals: SignalSource = process,
): Promise<ShutdownSignal> {
  return new Promise((resolve) => {
    const onInterrupt = () => {
      signals.removeListener("SIGTERM", onTerminate);
      resolve("SIGINT");
    };
    const onTerminate = () => {
      signals.removeListener("SIGINT", onInterrupt);
      resolve("SIGTERM");
    };
    signals.once("SIGINT", onInterrupt);
    signals.once("SIGTERM", onTerminate);
  });
}

/**
 * 竞速：关闭信号 vs worker 基础设施失败。
 *
 * 立即做一次检查（worker 可能在 start() 与进入本函数之间就已经失败），随后按
 * pollIntervalMs 轮询。无论哪一侧先结束，都会清掉定时器与信号监听，避免泄漏。
 */
export function raceWorkerOutcome(
  source: InfrastructureFailureSource,
  options: LifecycleDependencies = {},
): Promise<WorkerOutcome> {
  const signals = options.signals ?? process;
  const setIntervalFn =
    options.setInterval ??
    ((handler: () => void, ms: number): IntervalHandle => setInterval(handler, ms));
  const clearIntervalFn =
    options.clearInterval ??
    ((handle: IntervalHandle): void => clearInterval(handle as NodeJS.Timeout));
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return new Promise((resolve) => {
    let settled = false;
    let handle: IntervalHandle | null = null;

    const finish = (outcome: WorkerOutcome): void => {
      if (settled) return;
      settled = true;
      if (handle !== null) clearIntervalFn(handle);
      signals.removeListener("SIGINT", onInterrupt);
      signals.removeListener("SIGTERM", onTerminate);
      resolve(outcome);
    };
    const onInterrupt = () => finish({ kind: "signal", signal: "SIGINT" });
    const onTerminate = () => finish({ kind: "signal", signal: "SIGTERM" });

    const alreadyFailed = source.getLastInfrastructureError();
    if (alreadyFailed !== null) {
      finish({ kind: "infrastructure-failure", error: alreadyFailed });
      return;
    }

    handle = setIntervalFn(() => {
      const error = source.getLastInfrastructureError();
      if (error !== null) finish({ kind: "infrastructure-failure", error });
    }, intervalMs);
    handle.unref?.();
    signals.once("SIGINT", onInterrupt);
    signals.once("SIGTERM", onTerminate);
  });
}
