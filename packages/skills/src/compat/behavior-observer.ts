// ---------------------------------------------------------------------------
// Round 7 —— Server Behavior Observer：结构化、bounded、确定性信号采集。
//
// 纪律：
// - 不依赖自然语言日志解析——所有信号是调用方（capability/mineflayer 层）
//   显式上报的结构化事件；
// - monotonic time 驱动窗口与间隔；
// - 每 Bot bounded（条数上限），绝不阻塞移动/战斗循环（append 是 O(1) 摊销）；
// - redaction：detail 在入口即清洗（与 incident reporter 同规则）。
// ---------------------------------------------------------------------------

import type { ActionFamily } from "./server-behavior-profile.js";

export const OBSERVER_MAX_EVENTS = 256;
export const OBSERVER_DEFAULT_WINDOW_MS = 120_000;

export type BehaviorSignalKind =
  | "position-correction"
  | "action-rejected"
  | "block-divergence"
  | "inventory-divergence"
  | "kick"
  | "timeout"
  | "accepted";

export interface BehaviorSignalEvent {
  readonly at: string;
  readonly monotonicMs: number;
  readonly kind: BehaviorSignalKind;
  readonly family: ActionFamily;
  readonly detail: string | undefined;
}

// 键名组必须是捕获组：替换串里的 `$1` 只有在键名真的被捕获时才会展开成键名。
// 旧写法用 (?:...) 非捕获组，于是脱敏结果里原样留下字面量 `$1=`——既不安全
// （读的人以为脱敏生效）也不可用（detail 是 incident 的证据字段）。
const SECRETISH = /(api[_-]?key|token|secret|authorization|bearer|password)[\s=:]+[A-Za-z0-9_\-./+]{8,}/giu;

/**
 * detail 在 schema 上是 z.string().optional()，运行期却可能拿到任何东西。
 * 旧实现只判 undefined，非字符串会在这里 .replace 抛错，被 record 的 try/catch
 * 静默吞掉——整条事件随之消失（观测缺口：丢掉的恰好是服务器异常行为的证据）。
 * 现在非字符串一律降级为 undefined：只丢不可清洗的 detail，不丢事件。
 */
function redact(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  let text = raw.replace(SECRETISH, "$1=[REDACTED]");
  text = text.replace(/[A-Za-z0-9_\-./+]{120,}/gu, (m) => `${m.slice(0, 32)}…[truncated]`);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export interface FamilyWindowStats {
  readonly corrections: number;
  readonly rejections: number;
  readonly divergences: number;
  readonly accepted: number;
  readonly total: number;
}

export class ServerBehaviorObserver {
  private readonly events: BehaviorSignalEvent[] = [];
  private droppedCount = 0;
  private readonly maxEvents: number;
  private readonly windowMs: number;
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => Date;

  constructor(options: Readonly<{
    maxEvents?: number;
    windowMs?: number;
    monotonicNow?: () => number;
    wallNow?: () => Date;
  }> = {}) {
    this.maxEvents = options.maxEvents ?? OBSERVER_MAX_EVENTS;
    this.windowMs = options.windowMs ?? OBSERVER_DEFAULT_WINDOW_MS;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => new Date());
  }

  /** 热路径入口：纯内存 append，红黑界内 O(1)，绝不抛错阻断调用方。 */
  record(input: {
    kind: BehaviorSignalKind;
    family: ActionFamily;
    detail?: string;
  }): void {
    try {
      const detail = redact(input.detail);
      const event: BehaviorSignalEvent = {
        at: this.wallNow().toISOString(),
        monotonicMs: this.monotonicNow(),
        kind: input.kind,
        family: input.family,
        detail,
      };
      this.events.push(event);
      while (this.events.length > this.maxEvents) {
        this.events.shift();
        this.droppedCount += 1;
      }
    } catch {
      // 观测绝不能反向破坏动作主流程
    }
  }

  /** 窗口内按 family 的确定性统计。 */
  familyStats(family: ActionFamily, nowMonotonicMs?: number): FamilyWindowStats {
    const now = nowMonotonicMs ?? this.monotonicNow();
    const cutoff = now - this.windowMs;
    let corrections = 0;
    let rejections = 0;
    let divergences = 0;
    let accepted = 0;
    let total = 0;
    for (const event of this.events) {
      if (event.family !== family || event.monotonicMs < cutoff) continue;
      total += 1;
      if (event.kind === "position-correction") corrections += 1;
      else if (event.kind === "action-rejected") rejections += 1;
      else if (event.kind === "block-divergence" || event.kind === "inventory-divergence") divergences += 1;
      else if (event.kind === "accepted") accepted += 1;
    }
    return { corrections, rejections, divergences, accepted, total };
  }

  /** 全窗口快照（供 Incident eventWindow 复制最近 30-60 秒）。 */
  snapshot(lastMs?: number): readonly BehaviorSignalEvent[] {
    if (lastMs === undefined) return [...this.events];
    const cutoff = this.monotonicNow() - lastMs;
    return this.events.filter((event) => event.monotonicMs >= cutoff);
  }

  get stats(): Readonly<{ buffered: number; dropped: number }> {
    return { buffered: this.events.length, dropped: this.droppedCount };
  }
}
