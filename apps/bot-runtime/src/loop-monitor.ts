// loop-monitor.ts —— 事件循环延迟直方图（"哪里计算高"的进程级真值）。
//
// monitorEventLoopDelay 测的是每次事件循环轮转之间的延迟（被同步计算/
// 同步 IO 挤占的直接证据）。P50=常态，P99=尖峰，MAX=最坏。30s 一报，
// 与 rustPathStats（每技能阶段耗时）构成两层归因：先看进程健康度，
// 再下钻到具体阶段。

import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * 布尔旋钮探针（Phase 2c）：门语义严格对齐 `=== "1"`。
 * "1"=开；"0"/空=关；**其他任何值（"true"/"yes"/"on"/垃圾）都是显式降级**
 * ——按关处理并打 invalid 标记，让 typo 在 runtime_env_probe 里可见，
 * 而不是悄悄当 false（§10.5：无效值不许静默）。
 */
export function probeBooleanKnob(
  raw: string | undefined,
): { effective: boolean; source: "default" | "env"; raw: string | null; invalid: boolean } {
  if (raw === undefined) return { effective: false, source: "default", raw: null, invalid: false };
  // 与消费点严格同语义：不 trim（" 1 " 在门那里是 falsy，探针不能报开）。
  if (raw === "1") return { effective: true, source: "env", raw, invalid: false };
  if (raw === "0" || raw === "") return { effective: false, source: "env", raw, invalid: false };
  return { effective: false, source: "env", raw, invalid: true };
}

export type LoopMonitorStop = () => void;
export type LoopDelaySample = { observedAt: string; samples: number; p99DelayMs: number; maxDelayMs: number };

export function startLoopMonitor(
  logger: { info?: (event: string, fields?: Record<string, unknown>) => void },
  intervalMs = 30_000,
  onSample?: (sample: LoopDelaySample) => void,
): LoopMonitorStop {
  // 口径（Phase 3 校准）：resolution=1ms（采样分辨率；直方图输出值仍是纳秒，/1e6 换算在下方唯一换算点）（Windows
  // 定时器粒度仍影响下限，报告须连同平台说明）；warmup 一窗不计（启动
  // require/连接峰值不混入正式窗口）；每窗 reset；ns→ms 在此唯一换算点
  // 统一，调用方禁止自行转换。
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  let warmupWindowSkipped = false;
  const timer = setInterval(() => {
    if (!warmupWindowSkipped) {
      warmupWindowSkipped = true;
      histogram.reset();
      return;
    }
    // percentile() 返回纳秒——转毫秒再报（唯一换算点）。
    const p50 = histogram.percentile(50) / 1e6;
    const p95 = histogram.percentile(95) / 1e6;
    const p99 = histogram.percentile(99) / 1e6;
    const max = histogram.max / 1e6;
    const mean = histogram.mean / 1e6;
    const samples = histogram.count;
    histogram.reset();
    if (samples > 0 && Number.isFinite(p99) && Number.isFinite(max)) {
      onSample?.({ observedAt: new Date().toISOString(), samples, p99DelayMs: round(p99), maxDelayMs: round(max) });
    }
    logger.info?.("runtime_event_loop_delay", {
      p50Ms: round(p50),
      p95Ms: round(p95),
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
