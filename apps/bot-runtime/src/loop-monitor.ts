// loop-monitor.ts —— 事件循环延迟直方图（"哪里计算高"的进程级真值）。
//
// monitorEventLoopDelay 测的是每次事件循环轮转之间的延迟（被同步计算/
// 同步 IO 挤占的直接证据）。P50=常态，P99=尖峰，MAX=最坏。30s 一报，
// 与 rustPathStats（每技能阶段耗时）构成两层归因：先看进程健康度，
// 再下钻到具体阶段。

import { monitorEventLoopDelay } from "node:perf_hooks";

export type LoopMonitorStop = () => void;

export function startLoopMonitor(
  logger: { info?: (event: string, fields?: Record<string, unknown>) => void },
  intervalMs = 30_000,
): LoopMonitorStop {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    // percentile() 返回纳秒——转毫秒再报。
    const p50 = histogram.percentile(50) / 1e6;
    const p99 = histogram.percentile(99) / 1e6;
    const max = histogram.max / 1e6;
    const mean = histogram.mean / 1e6;
    histogram.reset();
    logger.info?.("runtime_event_loop_delay", {
      p50Ms: round(p50),
      p99Ms: round(p99),
      maxMs: round(max),
      meanMs: round(mean),
    });
  }, intervalMs);
  timer.unref?.();
  return () => {
    histogram.disable();
    clearInterval(timer);
  };
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : -1;
}
