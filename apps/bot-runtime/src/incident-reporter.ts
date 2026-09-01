// ---------------------------------------------------------------------------
// IncidentReporter —— runtime 侧非阻塞上报端口
//
// 契约（十节 hot path）：
//   - enqueue 是同步 O(1)，绝不做网络/磁盘 IO（spool 写在 drain 失败后，后台协程）
//   - 有界队列：满则丢弃并计数 + logger.warn（不静默）；不阻塞、不膨胀内存
//   - 后台串行 POST 到 Studio Manager（STUDIO_INCIDENT_ENDPOINT + Bearer token）
//   - 失败重试：指数退避 + jitter（有界），最终失败 → bounded 本地 spool，
//     manager 恢复后重放（reporterEventId 幂等，manager 去重）
//   - 绝不抛出到调用方；网络失败绝不递归产生新 Incident
// ---------------------------------------------------------------------------

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const MAX_QUEUE = 32;
const MAX_BODY_BYTES = 128 * 1024;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5_000;
const RETRY_MAX_ATTEMPTS = 3;
/** spool 上限（条）：超出丢最旧；0 = 不启用。 */
const SPOOL_MAX_ENTRIES = 64;

export interface IncidentSignal {
  readonly botId: string;
  readonly sessionId?: string | undefined;
  /** runtime 实例 ID（与 sessionId 分离：sessionId 语义留给业务会话）。 */
  readonly runtimeInstanceId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly goalId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly serverProfileId?: string | undefined;
  readonly minecraftVersion?: string | undefined;
  readonly protocolVersion?: number | undefined;
  readonly gitCommit?: string | undefined;
  readonly branch?: string | undefined;
  readonly buildVersion?: string | undefined;
  readonly dirtyBuild?: boolean | undefined;
  readonly goal?: string | undefined;
  readonly skillId?: string | undefined;
  readonly skillStep?: string | undefined;
  readonly phase?: string | undefined;
  readonly position?: { x: number; y: number; z: number } | undefined;
  readonly dimension?: string | undefined;
  readonly failureCode: string;
  /** 终态 Outcome 码（如 SKILL_RECOVERY_EXHAUSTED）；根因在 failureCode/causedBy。 */
  readonly terminalFailureCode?: string | undefined;
  readonly causedByFailureCodes?: readonly string[] | undefined;
  readonly incidentType: string;
  readonly sourceComponent: string;
  readonly severity?: "INFO" | "WARNING" | "ERROR" | "CRITICAL" | undefined;
  readonly expected?: string | undefined;
  readonly actual?: string | undefined;
  readonly eventWindow?: ReadonlyArray<{ at: string; kind: string; detail?: string }> | undefined;
  readonly snapshots?: Record<string, unknown> | undefined;
  readonly normalizedErrorSignature?: string | undefined;
  readonly actionFamily?: string | undefined;
  /** 幂等 ID：manager 据此去重（spool 重放不产生重复 occurrence）。 */
  readonly reporterEventId?: string | undefined;
}

export interface IncidentReporterOptions {
  /** 例如 http://127.0.0.1:3230/v1/incidents；未配置时为 no-op（仅计数）。 */
  readonly endpoint?: string | undefined;
  readonly token?: string | undefined;
  readonly botId: string;
  /** crash-safe 本地 spool 文件（JSONL）；缺省则不 spool。 */
  readonly spoolPath?: string | undefined;
  /** 退避基线（测试注入用）；生产默认 500ms。 */
  readonly retryBaseDelayMs?: number | undefined;
  readonly logger?: { warn(message: string, meta?: unknown): void };
  /**
   * P0-3：reporter 生命周期事件进入运行时事件缓冲（Incident eventWindow 的
   * incident_report_enqueued/sent/failed 条目）。回调必须非阻塞、绝不抛错。
   */
  readonly eventSink?: ((
    event: { kind: "incident_report_enqueued" | "incident_report_sent" | "incident_report_failed"; detail: string; correlationId?: string | undefined },
  ) => void) | undefined;
}

interface QueuedSignal {
  readonly signal: IncidentSignal;
  readonly eventId: string;
  /** 重放自 spool 的信号（重放失败不再 spool，防循环）。 */
  readonly replayed: boolean;
}

export class IncidentReporter {
  private readonly queue: QueuedSignal[] = [];
  private droppedCount = 0;
  private sentCount = 0;
  private failedCount = 0;
  private spooledCount = 0;
  private replayedCount = 0;
  private draining = false;
  private readonly endpoint: string | undefined;
  private readonly token: string | undefined;
  private readonly botId: string;
  private readonly spoolPath: string | undefined;
  private readonly retryBaseDelayMs: number;
  private readonly logger: IncidentReporterOptions["logger"];
  private readonly eventSink: IncidentReporterOptions["eventSink"];

  constructor(options: IncidentReporterOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.botId = options.botId;
    this.spoolPath = options.spoolPath;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    this.logger = options.logger;
    this.eventSink = options.eventSink;
    this.replaySpool();
  }

  /** 热路径入口：入队即返回。队列满 → 丢弃 + 计数 + warn（可观测，不静默）。 */
  report(signal: Omit<IncidentSignal, "botId"> & Partial<Pick<IncidentSignal, "botId">>): void {
    const full: IncidentSignal = { ...signal, botId: signal.botId ?? this.botId } as IncidentSignal;
    if (!this.endpoint) {
      this.droppedCount += 1;
      return;
    }
    if (this.queue.length >= MAX_QUEUE) {
      this.droppedCount += 1;
      this.logger?.warn("incident_reporter_queue_full", {
        dropped: this.droppedCount,
        eventId: full.reporterEventId ?? null,
      });
      return;
    }
    this.queue.push({
      signal: full,
      eventId: full.reporterEventId ?? randomEventId(),
      replayed: false,
    });
    this.emitToSink("incident_report_enqueued", full.failureCode, full.correlationId);
    void this.drain();
  }

  /** 关闭前冲刷（graceful shutdown 调用；有界等待）。 */
  async flush(deadlineMs = 3_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (this.queue.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  get stats(): {
    queued: number; dropped: number; sent: number; failed: number;
    spooled: number; replayed: number; endpointConfigured: boolean;
  } {
    return {
      queued: this.queue.length,
      dropped: this.droppedCount,
      sent: this.sentCount,
      failed: this.failedCount,
      spooled: this.spooledCount,
      replayed: this.replayedCount,
      endpointConfigured: this.endpoint !== undefined,
    };
  }

  /** 启动时重放 spool（bounded；重放项优先级低于新事件，进队尾）。 */
  private replaySpool(): void {
    if (!this.endpoint || !this.spoolPath || !existsSync(this.spoolPath)) return;
    try {
      const lines = readFileSync(this.spoolPath, "utf8").split("\n").filter((line) => line.trim().length > 0);
      const entries = lines.slice(-SPOOL_MAX_ENTRIES);
      let replayed = 0;
      for (const line of entries) {
        if (this.queue.length >= MAX_QUEUE) break;
        try {
          const parsed = JSON.parse(line) as { eventId: string; signal: IncidentSignal };
          this.queue.push({ signal: parsed.signal, eventId: parsed.eventId, replayed: true });
          replayed += 1;
        } catch {
          // 单行损坏跳过（spool 是 JSONL，容错按行）
        }
      }
      this.replayedCount = replayed;
      if (replayed > 0) {
        this.logger?.warn("incident_reporter_spool_replayed", { count: replayed });
        // 入队后启动后台投递（report() 之外唯一的入队路径）
        void this.drain();
      }
      // 重放完成即清空 spool；发送失败的会按需重写（不残留已处理条目）
      rmSync(this.spoolPath, { force: true });
    } catch {
      // spool 不可读 → 不阻塞启动
    }
  }

  /** 生命周期事件外发（P0-3）；sink 抛错绝不影响投递主流程。 */
  private emitToSink(
    kind: "incident_report_enqueued" | "incident_report_sent" | "incident_report_failed",
    failureCode: string,
    correlationId: string | undefined,
  ): void {
    if (this.eventSink === undefined) return;
    try {
      this.eventSink({
        kind,
        detail: `${failureCode}${correlationId ? ` corr=${correlationId}` : ""}`,
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
    } catch {
      // sink 故障静默：缓冲是诊断辅助，绝不能反向破坏上报
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        let delivered = false;
        for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS && !delivered; attempt += 1) {
          delivered = await this.post(item.signal, item.eventId);
          if (!delivered && attempt < RETRY_MAX_ATTEMPTS) {
            // 指数退避 + 全抖动 jitter（有界）
            const cap = Math.min(RETRY_MAX_DELAY_MS, this.retryBaseDelayMs * 2 ** (attempt - 1));
            await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * cap)));
          }
        }
        if (delivered) {
          this.sentCount += 1;
          this.emitToSink("incident_report_sent", item.signal.failureCode, item.signal.correlationId);
        } else {
          this.failedCount += 1;
          this.emitToSink("incident_report_failed", item.signal.failureCode, item.signal.correlationId);
          // crash-safe spool：仅原生信号（重放失败不再 spool，防无限循环）
          if (!item.replayed) this.spool(item);
          this.logger?.warn("incident_reporter_delivery_failed", {
            eventId: item.eventId,
            failureCode: item.signal.failureCode,
            spooled: !item.replayed && this.spoolPath !== undefined,
            failed: this.failedCount,
          });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private spool(item: QueuedSignal): void {
    if (!this.spoolPath) return;
    try {
      const line = `${JSON.stringify({ eventId: item.eventId, signal: item.signal })}\n`;
      if (existsSync(this.spoolPath)) {
        const existing = readFileSync(this.spoolPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
        const kept = existing.slice(-(SPOOL_MAX_ENTRIES - 1));
        writeFileSync(this.spoolPath, `${[...kept, line.trim()].join("\n")}\n`, "utf8");
      } else {
        appendFileSync(this.spoolPath, line, "utf8");
      }
      this.spooledCount += 1;
    } catch {
      // spool 失败只计数（磁盘满/权限），不影响主流程
    }
  }

  private async post(signal: IncidentSignal, eventId: string): Promise<boolean> {
    if (!this.endpoint) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...signal, reporterEventId: eventId, botId: signal.botId || this.botId }).slice(0, MAX_BODY_BYTES),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function randomEventId(): string {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** watchdog 事件 → Incident 信号映射（十三/十一节）。 */
export function watchdogEventToSignal(params: Readonly<{
  event: { kind: string; goalKey: string | null; ageMs: number; phaseKey?: string; diagnostics?: { windowNetDisplacement: number; windowTargetDistanceDrop: number | null; windowPathLength: number; reversals: number; noMaterialProgressMs: number } | undefined };
  position: { x: number; y: number; z: number };
  dimension: string | null;
  skillId?: string | undefined;
  taskId?: string | undefined;
  goalId?: string | undefined;
  goal?: string | null | undefined;
  runtimeInstanceId?: string | undefined;
  correlationId?: string | undefined;
  expectedProgress?: string | undefined;
  actualProgress?: string | undefined;
  minecraftVersion?: string | null | undefined;
  protocolVersion?: number | null | undefined;
  gitCommit?: string | undefined;
  branch?: string | undefined;
  buildVersion?: string | undefined;
  dirtyBuild?: boolean | undefined;
  sessionId?: string | null | undefined;
  serverProfileId?: string | null | undefined;
  phase?: string | undefined;
  replanCount?: number | undefined;
  eventWindow?: Array<{ at: string; kind: string; detail?: string }> | undefined;
}>): IncidentSignal {
  const { event } = params;
  const failureCode = event.kind === "stuck" ? "PATH_NO_PROGRESS"
    : event.kind === "no-progress" ? "TASK_PROGRESS_TIMEOUT"
    : event.kind === "oscillation" ? "PATH_OSCILLATION"
    : event.kind === "loop" ? "PATH_REPLAN_STORM"
    : event.kind === "deadline-exceeded" ? "TASK_PROGRESS_TIMEOUT"
    : "TASK_PROGRESS_TIMEOUT";
  const incidentType = event.kind === "deadline-exceeded" ? "TASK_TIMEOUT" : "STUCK";
  return {
    botId: "",
    failureCode,
    incidentType,
    sourceComponent: "progress-watchdog",
    severity: "ERROR",
    expected: params.expectedProgress ?? `steady progress toward ${event.goalKey ?? "active goal"} (phase expectation: movement)`,
    actual: params.actualProgress ?? `${event.kind} after ${event.ageMs}ms without material progress${params.replanCount !== undefined ? `; pathResets=${params.replanCount}` : ""}${event.diagnostics ? ` [window: net=${event.diagnostics.windowNetDisplacement?.toFixed(2)}, distDrop=${event.diagnostics.windowTargetDistanceDrop === null || event.diagnostics.windowTargetDistanceDrop === undefined ? "n/a" : event.diagnostics.windowTargetDistanceDrop.toFixed(2)}, path=${event.diagnostics.windowPathLength?.toFixed(2)}, reversals=${event.diagnostics.reversals}, noProgressMs=${event.diagnostics.noMaterialProgressMs}]` : ""}`,
    position: params.position,
    ...(params.dimension ? { dimension: params.dimension } : {}),
    ...(params.minecraftVersion ? { minecraftVersion: params.minecraftVersion } : {}),
    ...(params.protocolVersion ? { protocolVersion: params.protocolVersion } : {}),
    ...(params.gitCommit ? { gitCommit: params.gitCommit } : {}),
    ...(params.branch ? { branch: params.branch } : {}),
    ...(params.buildVersion ? { buildVersion: params.buildVersion } : {}),
    ...(params.dirtyBuild !== undefined ? { dirtyBuild: params.dirtyBuild } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.runtimeInstanceId ? { runtimeInstanceId: params.runtimeInstanceId } : {}),
    ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    ...(params.serverProfileId ? { serverProfileId: params.serverProfileId } : {}),
    ...(params.skillId ? { skillId: params.skillId } : {}),
    ...(params.taskId ? { taskId: params.taskId } : {}),
    ...(params.goalId ? { goalId: params.goalId } : {}),
    ...(params.goal ? { goal: params.goal } : {}),
    ...(params.phase ? { phase: params.phase } : {}),
    ...(event.phaseKey ? { phase: event.phaseKey } : {}),
    // replan 计数是诊断数值，不进 fingerprint（stuck/no-progress/oscillation
    // 跨场景必须聚合到同一 Issue）；仅 loop（PATH_REPLAN_STORM）以 replan
    // 为身份本质时保留。
    ...(params.replanCount !== undefined && event.kind === "loop"
      ? { normalizedErrorSignature: `path-resets:${params.replanCount}` }
      : {}),
    actionFamily: "navigation",
    ...(params.eventWindow ? { eventWindow: params.eventWindow.slice(-60) } : {}),
    snapshots: event.diagnostics ? { windowDiagnostics: { ...event.diagnostics } } : {},
  };
}
