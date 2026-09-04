// perf-spans.ts —— 低扰动分段计时与进程指标（Phase 3 测量面，只观测不改行为）。
//
// 纪律（加固提示词 §5-6）：
//  - 热路径只做单调时钟差 + 小计数；环形缓冲有界；**慢任务才存明细**，
//    周期窗口聚合一条日志——监控绝不逐次写日志制造新阻塞。
//  - 单位：全部对外毫秒；monotonic（performance.now / perf_hooks）。
//  - 脱敏：慢任务明细导出前过 denylist（token/secret/password/key/auth/
//    credential/proxy 一律丢弃原值）。
//  - 旋钮：STUDIO_PERF_SPANS=0 关闭（默认开——开销为微秒级时钟差）。

import { performance, PerformanceObserver } from "node:perf_hooks";

const RING_CAPACITY = 256;
const SLOW_SPAN_LIMIT = 32;
export const DEFAULT_SLOW_THRESHOLD_MS = 50;

/** 敏感键 denylist：导出前丢弃（宁滥勿漏，只影响慢任务明细字段）。 */
const SENSITIVE_KEY_PATTERN = /token|secret|password|passphrase|credential|auth|proxy|cookie|apikey|api_key/i;

function sanitizeDetail(detail: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  if (!detail) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    out[key] =
      typeof value === "number" || typeof value === "boolean" || typeof value === "string"
        ? value
        : Array.isArray(value)
          ? `[${value.length}]`
          : "[object]";
  }
  return out;
}

type SlowSpanRecord = Readonly<{
  atMs: number;
  category: string;
  durationMs: number;
  detail: Record<string, unknown>;
}>;

class CategoryRing {
  readonly samples = new Float64Array(RING_CAPACITY);
  private writeIndex = 0;
  private filled = 0;

  push(durationMs: number): void {
    this.samples[this.writeIndex] = durationMs;
    this.writeIndex = (this.writeIndex + 1) % RING_CAPACITY;
    if (this.filled < RING_CAPACITY) this.filled += 1;
  }

  percentile(p: number): number {
    if (this.filled === 0) return 0;
    const slice = Array.from(this.samples.subarray(0, this.filled)).sort((a, b) => a - b);
    const index = Math.min(slice.length - 1, Math.floor((p / 100) * slice.length));
    return slice[index] ?? 0;
  }

  max(): number {
    if (this.filled === 0) return 0;
    let m = -Infinity;
    for (let i = 0; i < this.filled; i += 1) m = Math.max(m, this.samples[i] ?? 0);
    return m;
  }

  get count(): number {
    return this.filled;
  }
}

export type PerfWindowSummary = Readonly<{
  windowMs: number;
  spans: ReadonlyArray<Readonly<{
    category: string;
    count: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  }>>;
  slowSpans: readonly SlowSpanRecord[];
  elapsedTimerDriftMs: number;
}>;

export class PerfSpanTracker {
  private readonly categories = new Map<string, CategoryRing>();
  private readonly slowSpans: SlowSpanRecord[] = [];
  private readonly slowThresholdMs: number;
  private readonly now: () => number;

  constructor(options: { slowThresholdMs?: number; now?: () => number } = {}) {
    this.slowThresholdMs = options.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
    this.now = options.now ?? (() => performance.now());
  }

  record(category: string, durationMs: number, detail?: Readonly<Record<string, unknown>>): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    let ring = this.categories.get(category);
    if (ring === undefined) {
      ring = new CategoryRing();
      this.categories.set(category, ring);
    }
    ring.push(durationMs);
    if (durationMs >= this.slowThresholdMs) {
      this.slowSpans.push({
        atMs: Math.round(this.now()),
        category,
        durationMs: Math.round(durationMs * 100) / 100,
        detail: sanitizeDetail(detail),
      });
      if (this.slowSpans.length > SLOW_SPAN_LIMIT) this.slowSpans.shift();
    }
  }

  /** 同步段包装：热路径只加一次时钟差。 */
  spanSync<T>(category: string, fn: () => T, detail?: Readonly<Record<string, unknown>>): T {
    const began = this.now();
    try {
      return fn();
    } finally {
      this.record(category, this.now() - began, detail);
    }
  }

  async spanAsync<T>(category: string, fn: () => Promise<T>, detail?: Readonly<Record<string, unknown>>): Promise<T> {
    const began = this.now();
    try {
      return await fn();
    } finally {
      this.record(category, this.now() - began, detail);
    }
  }

  /** 窗口汇总并清零（设计如此：每窗口独立，不累积历史）。 */
  collectWindow(windowMs: number, observedDriftMs: number): PerfWindowSummary {
    const spans = [...this.categories.entries()]
      .map(([category, ring]) => ({
        category,
        count: ring.count,
        p50Ms: round(ring.percentile(50)),
        p95Ms: round(ring.percentile(95)),
        p99Ms: round(ring.percentile(99)),
        maxMs: round(ring.max()),
      }))
      .sort((left, right) => right.maxMs - left.maxMs);
    const slow = [...this.slowSpans];
    this.categories.clear();
    this.slowSpans.length = 0;
    return { windowMs: Math.round(windowMs), spans, slowSpans: slow, elapsedTimerDriftMs: round(observedDriftMs) };
  }
}

type GcAccumulator = {
  count: number;
  totalMs: number;
  maxPauseMs: number;
  byKind: Record<string, { count: number; totalMs: number }>;
};

export type PerfProcessSample = Readonly<{
  cpuUserMs: number;
  cpuSystemMs: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  rssMb: number;
}>;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 进程级周期采集（30s 一窗）：span 聚合 + ELU + CPU + 内存 + GC + 定时器
 * 漂移，汇成一条 runtime_perf_window 日志。观察者与 interval 都 unref。
 */
export function startPerfTelemetry(options: {
  logger: { info?: (event: string, fields?: Record<string, unknown>) => void };
  tracker?: PerfSpanTracker;
  windowMs?: number;
  context?: () => Readonly<Record<string, unknown>>;
  now?: () => number;
}): () => void {
  if (process.env.STUDIO_PERF_SPANS === "0") return () => {};
  const windowMs = options.windowMs ?? 30_000;
  const tracker = options.tracker ?? new PerfSpanTracker();
  const monotonic = options.now ?? (() => performance.now());

  const gc: GcAccumulator = { count: 0, totalMs: 0, maxPauseMs: 0, byKind: {} };
  let gcObserver: PerformanceObserver | null = null;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const kind = (entry as PerformanceEntry & { detail?: { kind?: string } }).detail?.kind ?? "unknown";
        const durationMs = entry.duration;
        gc.count += 1;
        gc.totalMs += durationMs;
        gc.maxPauseMs = Math.max(gc.maxPauseMs, durationMs);
        const bucket = (gc.byKind[kind] ??= { count: 0, totalMs: 0 });
        bucket.count += 1;
        bucket.totalMs += durationMs;
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
  } catch {
    gcObserver = null;
  }

  let previouselu = performance.eventLoopUtilization();
  let previousCpu = process.cpuUsage();
  let windowStart = monotonic();
  let expectedFire = Date.now() + windowMs;

  const timer = setInterval(() => {
    const nowWall = Date.now();
    const driftMs = nowWall - expectedFire - windowMs;
    expectedFire = nowWall + windowMs;
    const elapsed = monotonic() - windowStart;
    windowStart = monotonic();

    const elu = performance.eventLoopUtilization(previouselu);
    previouselu = performance.eventLoopUtilization();
    const cpu = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    const memory = process.memoryUsage();
    const summary = tracker.collectWindow(elapsed, driftMs);

    options.logger.info?.("runtime_perf_window", {
      schemaVersion: "1.0",
      windowMs: summary.windowMs,
      timerDriftMs: summary.elapsedTimerDriftMs,
      elu: {
        utilization: round(elu.utilization * 100) / 100,
        idleMs: round(elu.idle),
        activeMs: round(elu.active),
      },
      cpu: {
        userMs: round(cpu.user / 1000),
        systemMs: round(cpu.system / 1000),
      },
      memoryMb: {
        heapUsed: round(memory.heapUsed / 1048576),
        heapTotal: round(memory.heapTotal / 1048576),
        external: round(memory.external / 1048576),
        arrayBuffers: round(memory.arrayBuffers / 1048576),
        rss: round(memory.rss / 1048576),
      },
      gc: {
        count: gc.count,
        totalMs: round(gc.totalMs),
        maxPauseMs: round(gc.maxPauseMs),
        byKind: Object.fromEntries(
          Object.entries(gc.byKind).map(([kind, bucket]) => [
            kind,
            { count: bucket.count, totalMs: round(bucket.totalMs) },
          ]),
        ),
      },
      spans: summary.spans,
      ...(summary.slowSpans.length > 0
        ? { slowSpans: summary.slowSpans.map((s) => ({ at: s.atMs, category: s.category, ms: s.durationMs, ...s.detail })) }
        : {}),
      ...(options.context ? options.context() : {}),
    });

    gc.count = 0;
    gc.totalMs = 0;
    gc.maxPauseMs = 0;
    gc.byKind = {};
  }, windowMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    gcObserver?.disconnect();
  };
}
