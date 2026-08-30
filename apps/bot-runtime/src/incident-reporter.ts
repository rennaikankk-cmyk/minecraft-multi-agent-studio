// ---------------------------------------------------------------------------
// IncidentReporter —— runtime 侧非阻塞上报端口
//
// 契约（十节 hot path）：
//   - enqueue 是同步 O(1)，绝不做网络/磁盘 IO
//   - 有界队列：满则丢弃并计数（可观测降级，不阻塞、不膨胀内存）
//   - 后台串行 POST 到 Studio Manager（STUDIO_INCIDENT_ENDPOINT + Bearer token）
//   - 失败重试一次后丢弃；绝不抛出到调用方
// ---------------------------------------------------------------------------

const MAX_QUEUE = 32;
const MAX_BODY_BYTES = 128 * 1024;

export interface IncidentSignal {
  readonly botId: string;
  readonly sessionId?: string | undefined;
  readonly serverProfileId?: string | undefined;
  readonly minecraftVersion?: string | undefined;
  readonly protocolVersion?: number | undefined;
  readonly gitCommit?: string | undefined;
  readonly branch?: string | undefined;
  readonly goal?: string | undefined;
  readonly skillId?: string | undefined;
  readonly skillStep?: string | undefined;
  readonly phase?: string | undefined;
  readonly position?: { x: number; y: number; z: number } | undefined;
  readonly dimension?: string | undefined;
  readonly failureCode: string;
  readonly incidentType: string;
  readonly sourceComponent: string;
  readonly severity?: "INFO" | "WARNING" | "ERROR" | "CRITICAL" | undefined;
  readonly expected?: string | undefined;
  readonly actual?: string | undefined;
  readonly eventWindow?: ReadonlyArray<{ at: string; kind: string; detail?: string }> | undefined;
  readonly snapshots?: Record<string, unknown> | undefined;
  readonly normalizedErrorSignature?: string | undefined;
  readonly actionFamily?: string | undefined;
}

export interface IncidentReporterOptions {
  /** 例如 http://127.0.0.1:3230/v1/incidents；未配置时为 no-op（仅计数）。 */
  readonly endpoint?: string | undefined;
  readonly token?: string | undefined;
  readonly botId: string;
  readonly logger?: { warn(message: string, meta?: unknown): void };
}

export class IncidentReporter {
  private readonly queue: IncidentSignal[] = [];
  private droppedCount = 0;
  private sentCount = 0;
  private failedCount = 0;
  private draining = false;
  private readonly endpoint: string | undefined;
  private readonly token: string | undefined;
  private readonly botId: string;
  private readonly logger: IncidentReporterOptions["logger"];

  constructor(options: IncidentReporterOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.botId = options.botId;
    this.logger = options.logger;
  }

  /** 热路径入口：入队即返回。队列满 → 丢弃 + 计数。 */
  report(signal: Omit<IncidentSignal, "botId"> & Partial<Pick<IncidentSignal, "botId">>): void {
    const full: IncidentSignal = { ...signal, botId: signal.botId ?? this.botId } as IncidentSignal;
    if (!this.endpoint) {
      this.droppedCount += 1;
      return;
    }
    if (this.queue.length >= MAX_QUEUE) {
      this.droppedCount += 1;
      return;
    }
    this.queue.push(full);
    void this.drain();
  }

  get stats(): { queued: number; dropped: number; sent: number; failed: number } {
    return { queued: this.queue.length, dropped: this.droppedCount, sent: this.sentCount, failed: this.failedCount };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const signal = this.queue.shift()!;
        const ok = await this.post(signal);
        if (ok) this.sentCount += 1;
        else {
          // 恰好一次重试
          const retried = await this.post(signal);
          if (retried) this.sentCount += 1;
          else this.failedCount += 1;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async post(signal: IncidentSignal): Promise<boolean> {
    if (!this.endpoint) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...signal, botId: signal.botId || this.botId }).slice(0, MAX_BODY_BYTES),
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

/** watchdog 事件 → Incident 信号映射（十三/十一节）。 */
export function watchdogEventToSignal(params: Readonly<{
  event: { kind: string; goalKey: string | null; ageMs: number; phaseKey?: string; diagnostics?: { windowNetDisplacement: number; windowTargetDistanceDrop: number | null; windowPathLength: number; reversals: number; noMaterialProgressMs: number } | undefined };
  position: { x: number; y: number; z: number };
  dimension: string | null;
  skillId?: string | undefined;
  expectedProgress?: string | undefined;
  actualProgress?: string | undefined;
  minecraftVersion?: string | undefined;
  protocolVersion?: number | undefined;
  gitCommit?: string | undefined;
  branch?: string | undefined;
  phase?: string | undefined;
  replanCount?: number | undefined;
  eventWindow?: Array<{ at: string; kind: string; detail?: string }> | undefined;
}>): IncidentSignal {
  const { event } = params;
  const failureCode = event.kind === "stuck" ? "PATH_NO_PROGRESS"
    : event.kind === "no-progress" ? "TASK_PROGRESS_TIMEOUT"
    : event.kind === "oscillation" ? "PATH_OSCILLATION"
    : event.kind === "loop" ? "PATH_REPLAN_STORM"
    : "TASK_PROGRESS_TIMEOUT";
  return {
    botId: "",
    failureCode,
    incidentType: "STUCK",
    sourceComponent: "progress-watchdog",
    severity: "ERROR",
    expected: params.expectedProgress ?? `steady progress toward ${event.goalKey ?? "active goal"} (phase expectation: movement)`,
    actual: params.actualProgress ?? `${event.kind} after ${event.ageMs}ms without material progress${params.replanCount !== undefined ? `; pathResets=${params.replanCount}` : ""}${event.diagnostics ? ` [window: net=${event.diagnostics.windowNetDisplacement?.toFixed(2)}, distDrop=${event.diagnostics.windowTargetDistanceDrop === null || event.diagnostics.windowTargetDistanceDrop === undefined ? "n/a" : event.diagnostics.windowTargetDistanceDrop.toFixed(2)}, path=${event.diagnostics.windowPathLength?.toFixed(2)}, reversals=${event.diagnostics.reversals}, noProgressMs=${event.diagnostics.noMaterialProgressMs}]` : ""}`,
    position: params.position,
    ...(params.dimension ? { dimension: params.dimension } : {}),
    ...(params.minecraftVersion ? { minecraftVersion: params.minecraftVersion } : {}),
    ...(params.protocolVersion !== undefined ? { protocolVersion: params.protocolVersion } : {}),
    ...(params.gitCommit ? { gitCommit: params.gitCommit } : {}),
    ...(params.branch ? { branch: params.branch } : {}),
    ...(params.skillId ? { skillId: params.skillId } : {}),
    ...(params.phase ? { phase: params.phase } : {}),
    ...(event.phaseKey ? { phase: event.phaseKey } : {}),
    ...(params.replanCount !== undefined ? { normalizedErrorSignature: `path-resets:${params.replanCount}` } : {}),
    actionFamily: "navigation",
    ...(params.eventWindow ? { eventWindow: params.eventWindow.slice(-60) } : {}),
    snapshots: event.diagnostics ? { windowDiagnostics: { ...event.diagnostics } } : {},
  };
}
