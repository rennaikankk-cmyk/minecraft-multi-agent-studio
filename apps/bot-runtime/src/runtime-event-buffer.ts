// P0-3：per-bot 有界运行时事件环形缓冲（Incident eventWindow 的唯一数据源）。
//
// 不变量（与测试一一对应）：
// - append 是热路径上唯一操作：纯内存、O(1) 摊销、绝不写盘。
// - 三维上限：maxEvents（条数）+ maxAgeMs（年龄）+ approxBytes（字节，按事件
//   序列化长度记账）。超限时丢最旧并计数（droppedCount），绝不无限增长。
// - 高频同类事件（material_progress 等）coalesce：同 kind+source+correlation
//   且在 coalesceWindowMs 内 → 合并计数，不新增条目。
// - detail 有界且统一 redact：截断长串、抹掉疑似 secret 的 token，外部文本
//   （chat/LLM/插件）一律带 UNTRUSTED_EXTERNAL_TEXT 标记后进入。
// - snapshot 只做拷贝（bounded slice），携带 truncated/dropped 元数据。
//
// 事件词汇表（stable，导出校验）：goal_queued/goal_started/goal_preempted/
// goal_cancelled/task_started/skill_started/skill_result/skill_fault/
// movement_started/material_progress/path_recalculated/no_progress_warning/
// oscillation_detected/replan_storm/watchdog_triggered/deadline_exceeded/
// recover_started/recover_result/connection_event/incident_report_enqueued/
// incident_report_sent/incident_report_failed

export const RUNTIME_EVENT_KINDS = [
  "goal_queued", "goal_started", "goal_preempted", "goal_cancelled",
  "task_started", "skill_started", "skill_result", "skill_fault",
  "movement_started", "material_progress", "path_recalculated",
  "no_progress_warning", "oscillation_detected", "replan_storm",
  "watchdog_triggered", "deadline_exceeded",
  "recover_started", "recover_result",
  "connection_event",
  "incident_report_enqueued", "incident_report_sent", "incident_report_failed",
] as const;
export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number];

export interface RuntimeBufferedEvent {
  readonly at: string;
  /** 首次出现的单调时间（wall 对应 at）。 */
  readonly monotonicMs: number;
  /** 最近一次 coalesce 追加的单调时间（滑动窗口判定/年龄裁剪用）。 */
  lastMonotonicMs: number;
  readonly kind: RuntimeEventKind;
  readonly source: string;
  readonly correlationId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly skillId?: string | undefined;
  detail?: string | undefined;
  count: number;
}

export interface RuntimeEventBufferOptions {
  readonly maxEvents?: number;
  readonly maxAgeMs?: number;
  readonly maxTotalBytes?: number;
  readonly maxEventDetailBytes?: number;
  readonly coalesceWindowMs?: number;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
}

export interface RuntimeEventSnapshot {
  readonly events: ReadonlyArray<{ at: string; kind: string; detail?: string }>;
  readonly truncated: boolean;
  readonly droppedCount: number;
  readonly coalescedCount: number;
  readonly totalBuffered: number;
}

const SECRETISH = /(?:api[_-]?key|token|secret|authorization|bearer|password)[\s=:]+[A-Za-z0-9_\-./+]{8,}/giu;
const MAX_DETAIL_BYTES_DEFAULT = 240;

/** detail 统一清洗：secret 模式脱敏 → 长串截断 → 有界返回。 */
export function redactEventDetail(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let text = raw.replace(SECRETISH, "$1=[REDACTED]");
  // 任意超长无空串（key/密钥形态）截断
  text = text.replace(/[A-Za-z0-9_\-./+]{120,}/gu, (m) => `${m.slice(0, 32)}…[truncated]`);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_DETAIL_BYTES_DEFAULT) {
    text = `${Buffer.from(text, "utf8").slice(0, MAX_DETAIL_BYTES_DEFAULT).toString("utf8")}…`;
  }
  return text;
}

export class RuntimeEventBuffer {
  private readonly events: RuntimeBufferedEvent[] = [];
  private readonly maxEvents: number;
  private readonly maxAgeMs: number;
  private readonly maxTotalBytes: number;
  private readonly coalesceWindowMs: number;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private approxBytes = 0;
  private droppedCount = 0;
  private coalescedCount = 0;

  constructor(options: RuntimeEventBufferOptions = {}) {
    this.maxEvents = options.maxEvents ?? 128;
    this.maxAgeMs = options.maxAgeMs ?? 600_000;
    this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024;
    this.coalesceWindowMs = options.coalesceWindowMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 2) {
      throw new TypeError("RuntimeEventBuffer maxEvents must be >= 2.");
    }
  }

  append(input: {
    kind: RuntimeEventKind;
    source: string;
    correlationId?: string | undefined;
    taskId?: string | undefined;
    skillId?: string | undefined;
    detail?: string | undefined;
    untrustedExternalText?: boolean;
  }): void {
    const detail = input.untrustedExternalText
      ? `UNTRUSTED_EXTERNAL_TEXT ${redactEventDetail(input.detail) ?? ""}`.trim()
      : redactEventDetail(input.detail);
    const monotonicMs = this.monotonicNow();
    const last = this.events[this.events.length - 1];
    if (
      last !== undefined &&
      last.kind === input.kind &&
      last.source === input.source &&
      last.correlationId === input.correlationId &&
      monotonicMs - last.lastMonotonicMs <= this.coalesceWindowMs
    ) {
      last.count += 1;
      last.lastMonotonicMs = monotonicMs;
      this.coalescedCount += 1;
      if (detail !== undefined) last.detail = detail;
      return;
    }
    const event: RuntimeBufferedEvent = {
      at: this.now().toISOString(),
      monotonicMs,
      lastMonotonicMs: monotonicMs,
      kind: input.kind,
      source: input.source,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.skillId !== undefined ? { skillId: input.skillId } : {}),
      ...(detail !== undefined ? { detail } : {}),
      count: 1,
    };
    this.events.push(event);
    this.approxBytes += this.eventBytes(event);
    this.pruneAged(monotonicMs);
    while (this.events.length > this.maxEvents || this.approxBytes > this.maxTotalBytes) {
      const dropped = this.events.shift();
      if (dropped === undefined) break;
      this.approxBytes -= this.eventBytes(dropped);
      this.droppedCount += 1;
    }
  }

  /**
   * 拷贝最近 windowMs（默认 60s）的事件为 Incident eventWindow 形态。
   * 只拷贝、不改内部状态；超 maxEvents 截断并标记 truncated。
   */
  snapshot(options: { windowMs?: number; maxEvents?: number } = {}): RuntimeEventSnapshot {
    const windowMs = options.windowMs ?? 60_000;
    const maxEvents = options.maxEvents ?? 60;
    const cutoffMono = this.monotonicNow() - windowMs;
    const selected: RuntimeBufferedEvent[] = [];
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const event = this.events[i]!;
      if (event.lastMonotonicMs < cutoffMono) break;
      selected.unshift(event);
    }
    const truncated = selected.length > maxEvents;
    const window = truncated ? selected.slice(selected.length - maxEvents) : selected;
    return {
      events: window.map((event) => ({
        at: event.at,
        kind: event.kind,
        ...(event.detail !== undefined || event.count > 1
          ? {
              detail: [
                event.detail,
                event.count > 1 ? `x${event.count}` : undefined,
                event.correlationId ? `corr=${event.correlationId}` : undefined,
                event.skillId ? `skill=${event.skillId}` : undefined,
                event.taskId ? `task=${event.taskId}` : undefined,
              ]
                .filter((part) => part !== undefined && part !== "")
                .join(" "),
            }
          : {}),
      })),
      truncated,
      droppedCount: this.droppedCount,
      coalescedCount: this.coalescedCount,
      totalBuffered: this.events.length,
    };
  }

  private pruneAged(currentMono: number): void {
    while (this.events.length > 0) {
      const oldest = this.events[0]!;
      if (currentMono - oldest.lastMonotonicMs <= this.maxAgeMs) break;
      this.events.shift();
      this.approxBytes -= this.eventBytes(oldest);
      this.droppedCount += 1;
    }
  }

  private eventBytes(event: RuntimeBufferedEvent): number {
    return 96 + Buffer.byteLength(event.detail ?? "", "utf8");
  }
}
