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
//   - F-C2 出站边界（两条，都在本文件内自足）：
//       1) endpoint 只允许显式回环 / 显式白名单私网主机 + http:（否则拒绝出站，
//          绝不静默跳过：计入 refused + warn，且日志不回显完整 endpoint）；
//       2) position 默认粗化到 256 格网格且不含 Y（AGENTS.md §6：基地坐标不得
//          离开本机）；只有显式 operator opt-in 才发送完整坐标。
// ---------------------------------------------------------------------------

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";

const MAX_QUEUE = 32;
const MAX_BODY_BYTES = 128 * 1024;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5_000;
const RETRY_MAX_ATTEMPTS = 3;
/** spool 上限（条）：超出丢最旧；0 = 不启用。 */
const SPOOL_MAX_ENTRIES = 64;

/* ---------------------------------------------------------------------------
 * F-C2：incident endpoint 出口策略（回环 / 显式私网白名单）
 * ------------------------------------------------------------------------- */

/** 私网主机显式白名单（逗号分隔的 IP 字面量或 host.docker.internal）。 */
export const INCIDENT_ENDPOINT_ALLOWLIST_ENV = "STUDIO_INCIDENT_ENDPOINT_ALLOWLIST";
/** 显式 opt-in：=1/true/yes 才发送完整坐标；空串/垃圾值不当作同意。 */
export const INCIDENT_POSITION_FULL_ENV = "STUDIO_INCIDENT_ALLOW_FULL_POSITION";

/** 默认坐标粗化网格（格）；256 = 一个 Minecraft region 的边长。 */
export const INCIDENT_POSITION_COARSE_GRID = 256;

/** 拒绝出站的稳定错误码（logs / stats / 测试共用，不随文案漂移）。 */
export const INCIDENT_ENDPOINT_REFUSED_CODE = "INCIDENT_ENDPOINT_REFUSED";
/** 拒绝出站的稳定日志事件名。 */
export const INCIDENT_ENDPOINT_REFUSED_EVENT = "incident_reporter_endpoint_refused";

export type IncidentEndpointRefusalCode =
  /** 非法 URL / 非 http: / 带凭据 / 带查询或片段。 */
  | "ENDPOINT_UNPARSEABLE"
  /** 主机不是回环，也不在显式私网白名单里（域名一律不算）。 */
  | "ENDPOINT_HOST_NOT_ALLOWED";

export type IncidentEndpointResolution =
  | { readonly allowed: true; readonly endpoint: string; readonly hostRule: string }
  | { readonly allowed: false; readonly code: IncidentEndpointRefusalCode; readonly redactedEndpoint: string };

/** 坐标出站精度：coarse = 默认（网格粗化 + 无 Y）；full = 显式 operator opt-in。 */
export type IncidentPositionPolicy = "coarse" | "full";

/** 坐标粗化结果（网格单元 + 确定性绑定标识）。 */
export type IncidentPositionSummary = Readonly<{
  /** 网格单元内坐标，格式 `coarse-<grid>:<x>:<z>`，不含 Y。 */
  readonly cell: string;
  /** botId:x:z 的确定性绑定，防止跨实例关联。 */
  readonly bind: string;
}>;

/**
 * 主机是否显式落在私网范围（IP 字面量判定，绝不做 DNS 解析）。
 * 与 SECURITY.md §10「目标只允许 loopback、RFC1918、链路本地/唯一本地 IPv6 或
 * host.docker.internal」同一口径——DNS 名可能解析到任意地址，因此不进白名单。
 */
function classifyPrivateHost(host: string): string | null {
  if (host === "host.docker.internal") return "docker-host";
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    const first = octets[0];
    const second = octets[1];
    if (first === undefined || second === undefined) return null;
    if (first === 10) return "rfc1918-10";
    if (first === 172 && second >= 16 && second <= 31) return "rfc1918-172";
    if (first === 192 && second === 168) return "rfc1918-192";
    if (first === 169 && second === 254) return "link-local-ipv4";
    return null;
  }
  if (version === 6) {
    if (/^f[cd]/u.test(host)) return "unique-local-ipv6";
    if (/^fe[89ab]/u.test(host)) return "link-local-ipv6";
    return null;
  }
  return null;
}

/**
 * 解析出站主机：回环 IP 字面量（127.0.0.0/8 / ::1）或显式私网白名单命中才放行。
 * 刻意不接受 `localhost` 这类域名（与 SECURITY.md §7「拒绝域名」一致：域名解析
 * 可被 hosts / DNS 改到任何地址）。只回传粗粒度规则名，绝不回显主机名本身。
 */
function resolveIncidentHost(hostname: string, allowlist: ReadonlySet<string>): { rule: string } | null {
  const host = normalizeHostname(hostname);
  if (!host) return null;
  if (isIP(host) === 4 && host.startsWith("127.")) return { rule: "loopback-ipv4" };
  // URL.hostname 的 IPv6 字面量形如 `[::1]`；两种写法都归一化后再判定。
  if (host === "::1" || host === "[::1]") return { rule: "loopback-ipv6" };
  const privateRule = classifyPrivateHost(host);
  if (privateRule !== null && allowlist.has(host)) return { rule: `allowlisted:${privateRule}` };
  return null;
}

/** 取主机名的小写裸形式（去 IPv6 方括号、去尾点），空串 → null。 */
function normalizeHostname(hostname: string): string | null {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host.length > 0 ? host : null;
}

/**
 * P0-3：endpoint 出口守卫。非法 URL、非 http:、带凭据/查询/片段的主机一律拒绝；
 * 主机只接受回环或显式私网白名单（`STUDIO_INCIDENT_ENDPOINT_ALLOWLIST`）。
 * 纯函数，无副作用——调用方负责把拒绝写进日志。
 */
export function resolveIncidentEndpoint(
  rawEndpoint: string | undefined,
  options: Readonly<{ readonly allowlist?: readonly string[] | undefined }> = {},
): IncidentEndpointResolution {
  const raw = rawEndpoint?.trim() ?? "";
  if (raw.length === 0) {
    return { allowed: false, code: "ENDPOINT_UNPARSEABLE", redactedEndpoint: "(unconfigured)" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { allowed: false, code: "ENDPOINT_UNPARSEABLE", redactedEndpoint: "(unparseable)" };
  }
  const redactedEndpoint = redactEndpoint(parsed);
  if (
    parsed.protocol !== "http:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return { allowed: false, code: "ENDPOINT_UNPARSEABLE", redactedEndpoint };
  }
  const host = resolveIncidentHost(parsed.hostname, new Set(options.allowlist ?? []));
  if (host === null) {
    return { allowed: false, code: "ENDPOINT_HOST_NOT_ALLOWED", redactedEndpoint };
  }
  return { allowed: true, endpoint: parsed.toString(), hostRule: host.rule };
}

/**
 * 解析 `STUDIO_INCIDENT_ENDPOINT_ALLOWLIST`：只接受 IP 字面量或
 * host.docker.internal，大小写不敏感、去重、**拒绝通配符**（通配符等于没有白名单）。
 */
export function parseIncidentEndpointAllowlist(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  const entries: string[] = [];
  for (const value of raw.split(",")) {
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length === 0 || entries.includes(trimmed)) continue;
    if (trimmed === "host.docker.internal" || isIP(trimmed) !== 0) {
      entries.push(trimmed);
      continue;
    }
    throw new IncidentEndpointAllowlistError(trimmed);
  }
  return entries;
}

/** 白名单条目非法（域名/通配符/空串族）—— 配置错误必须显式失败，不能静默忽略。 */
export class IncidentEndpointAllowlistError extends Error {
  readonly code: string = "INCIDENT_ENDPOINT_ALLOWLIST_INVALID";
  /** 非法条目的字符数（不存原文：避免把地址带进错误对象/日志）。 */
  readonly entryLength: number;

  constructor(entry: string) {
    super(
      `${INCIDENT_ENDPOINT_ALLOWLIST_ENV} 只接受 IP 字面量或 host.docker.internal；` +
        `不接受域名或通配符（非法条目长度 ${entry.length}，不回显条目本身）。`,
    );
    this.name = "IncidentEndpointAllowlistError";
    this.entryLength = entry.length;
  }
}

/** 坐标出站精度：只有 1/true/yes 才算显式 opt-in（空串不当作同意）。 */
export function resolveIncidentPositionPolicy(raw: string | undefined): IncidentPositionPolicy {
  const normalized = raw?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" ? "full" : "coarse";
}

/**
 * 坐标粗化：默认出站载荷不含原坐标，只带 region 级网格单元（256 格）且**不含 Y**
 * ——Y 会直接暴露地下基地深度。`bind` 用 botId 参与哈希，避免不同 bot 的同格
 * 记录被关联成同一条踪迹。
 */
export function coarsenIncidentPosition(
  position: { readonly x: number; readonly y: number; readonly z: number },
  options: Readonly<{ readonly gridBlocks?: number | undefined; readonly bind?: string | undefined }> = {},
): IncidentPositionSummary {
  const grid = Math.max(1, Math.trunc(options.gridBlocks ?? INCIDENT_POSITION_COARSE_GRID));
  const x = Number.isFinite(position.x) ? Math.floor(position.x / grid) * grid : null;
  const z = Number.isFinite(position.z) ? Math.floor(position.z / grid) * grid : null;
  return {
    // 非有限数值显式标 null，绝不落 NaN 到出站载荷。
    cell: `coarse-${grid}:${x === null ? "null" : x}:${z === null ? "null" : z}`,
    bind: `bot:${stableHash(`${options.bind ?? ""}:${x === null ? "null" : x}:${z === null ? "null" : z}`)}`,
  };
}

/** 默认出站字段（粗化坐标或显式标记）：绝不携带原始 x/y/z。 */
export function coarsenedPositionFields(
  position: { readonly x: number; readonly y: number; readonly z: number },
  botId: string,
): Readonly<Record<string, unknown>> {
  return {
    positionRedacted: true,
    positionPolicy: "coarse",
    positionPrecision: `grid-${INCIDENT_POSITION_COARSE_GRID}`,
    yOmitted: true,
    positionCoarse: coarsenIncidentPosition(position, { bind: botId }),
  };
}

/** 稳定的 32 位 FNV-1a：只为绑定标识，不做安全用途。 */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 脱敏展示：只留协议、端口和一个字符，绝不回显主机名/路径。 */
function redactEndpoint(parsed: URL): string {
  const protocol = parsed.protocol.replace(/:$/u, "");
  const host = parsed.hostname.replace(/^\[|\]$/gu, "");
  const head = host.charAt(0);
  return `${protocol}://${head}***:${parsed.port === "" ? "(default)" : parsed.port}`;
}

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
  /**
   * F-C2：进程内完整坐标（诊断需要）。**出站默认不发送**——post() 会把它换成
   * 256 格网格的粗化单元（无 Y）；只有 operator 显式 opt-in 才原样出站。
   */
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
  /**
   * F-C2：允许出站的私网主机白名单（来自 STUDIO_INCIDENT_ENDPOINT_ALLOWLIST）。
   * 回环永远允许；不在白名单里的主机一律拒绝出站。
   */
  readonly endpointAllowlist?: readonly string[] | undefined;
  /** F-C2：坐标出站精度；缺省 coarse（粗化 + 无 Y），full 必须 operator 显式 opt-in。 */
  readonly positionPolicy?: IncidentPositionPolicy | undefined;
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
  private refusedCount = 0;
  private sentCount = 0;
  private failedCount = 0;
  private spooledCount = 0;
  private replayedCount = 0;
  private draining = false;
  /**
   * F-C2：只有通过出口守卫的 endpoint 才会落到这里；被拒绝时恒为 undefined，
   * 因此 `post()` 的 `if (!this.endpoint)` 早退同时也是深防御——守卫一旦被
   * 回退/绕过，也不存在可用的出站地址。
   */
  private readonly endpoint: string | undefined;
  private readonly endpointRefusalCode: IncidentEndpointRefusalCode | null;
  private readonly positionPolicy: IncidentPositionPolicy;
  private readonly token: string | undefined;
  private readonly botId: string;
  private readonly spoolPath: string | undefined;
  private readonly retryBaseDelayMs: number;
  private readonly logger: IncidentReporterOptions["logger"];
  private readonly eventSink: IncidentReporterOptions["eventSink"];

  constructor(options: IncidentReporterOptions) {
    const configured = options.endpoint?.trim();
    const resolution = resolveIncidentEndpoint(configured, {
      allowlist: options.endpointAllowlist ?? [],
    });
    this.endpoint = resolution.allowed ? resolution.endpoint : undefined;
    // 未配置 endpoint 是既有的 no-op（只计数、不告警），与「配置了但被拒绝」区分开：
    // 后者必须可见，前者不该在每台未接 manager 的机器上刷告警。
    this.endpointRefusalCode = resolution.allowed || !configured ? null : resolution.code;
    this.positionPolicy = options.positionPolicy ?? "coarse";
    this.token = options.token;
    this.botId = options.botId;
    this.spoolPath = options.spoolPath;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    this.logger = options.logger;
    this.eventSink = options.eventSink;
    if (resolution.allowed) {
      // 只有通过出口守卫（回环 / 显式白名单私网）才回显完整 endpoint：这条 URL
      // 已证明不出本机私有范围，运维需要它确认「事件到底发去哪」。
      this.logger?.warn?.("incident_reporter_endpoint_allowed", {
        hostRule: resolution.hostRule,
        endpoint: resolution.endpoint,
        positionPolicy: this.positionPolicy,
      });
    } else if (configured) {
      // 拒绝必须可见（不是静默跳过）：稳定错误码 + 脱敏 endpoint，绝不回显主机名。
      this.logger?.warn?.(INCIDENT_ENDPOINT_REFUSED_EVENT, {
        code: INCIDENT_ENDPOINT_REFUSED_CODE,
        reason: resolution.code,
        endpoint: resolution.redactedEndpoint,
        action: "incident_delivery_disabled",
        hint: `只允许回环或 ${INCIDENT_ENDPOINT_ALLOWLIST_ENV} 中的显式私网主机`,
      });
    }
    if (this.positionPolicy === "full") {
      this.logger?.warn?.("incident_reporter_full_position_enabled", {
        code: "INCIDENT_FULL_POSITION_ENABLED",
        optIn: INCIDENT_POSITION_FULL_ENV,
        note: "完整坐标将离开本机；仅限显式排障，用后立即撤销该环境变量",
      });
    }
    this.replaySpool();
  }

  /** 热路径入口：入队即返回。队列满 → 丢弃 + 计数 + warn（可观测，不静默）。 */
  report(signal: Omit<IncidentSignal, "botId"> & Partial<Pick<IncidentSignal, "botId">>): void {
    const full: IncidentSignal = { ...signal, botId: signal.botId ?? this.botId } as IncidentSignal;
    if (this.endpointRefusalCode !== null) {
      // F-C2：endpoint 未通过出口守卫 → 拒绝出站（连队列都不进，绝不静默直发）。
      this.refusedCount += 1;
      if (this.refusedCount === 1) {
        this.logger?.warn?.(INCIDENT_ENDPOINT_REFUSED_EVENT, {
          code: INCIDENT_ENDPOINT_REFUSED_CODE,
          reason: this.endpointRefusalCode,
          action: "incident_report_refused",
          refused: this.refusedCount,
        });
      }
      return;
    }
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
    queued: number; dropped: number; refused: number; sent: number; failed: number;
    spooled: number; replayed: number; endpointConfigured: boolean;
    endpointRefusedCode: IncidentEndpointRefusalCode | null; positionPolicy: IncidentPositionPolicy;
  } {
    return {
      queued: this.queue.length,
      dropped: this.droppedCount,
      refused: this.refusedCount,
      sent: this.sentCount,
      failed: this.failedCount,
      spooled: this.spooledCount,
      replayed: this.replayedCount,
      endpointConfigured: this.endpoint !== undefined,
      endpointRefusedCode: this.endpointRefusalCode,
      positionPolicy: this.positionPolicy,
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
        body: JSON.stringify(this.outboundPayload(signal, eventId)).slice(0, MAX_BODY_BYTES),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * F-C2：出站载荷唯一构造点（post 只走这里，`build` 逻辑不再有第二条路径）。
   * 默认把 `position` 换成粗化网格单元 + 显式脱敏标记；只有 positionPolicy=full
   * 才原样发送。这是 AGENTS.md §6「基地坐标不得进入公开日志或未授权响应」的
   * 出站侧对应物：不允许它悄悄以原始形式离开本机。
   */
  private outboundPayload(signal: IncidentSignal, eventId: string): Record<string, unknown> {
    const botId = signal.botId || this.botId;
    const payload: Record<string, unknown> = { ...signal, reporterEventId: eventId, botId };
    if (signal.position === undefined || this.positionPolicy === "full") {
      return {
        ...payload,
        positionPolicy: this.positionPolicy,
        positionRedacted: false,
        ...(signal.position !== undefined ? { positionPrecision: "full-opt-in" } : {}),
      };
    }
    delete payload.position;
    return { ...payload, ...coarsenedPositionFields(signal.position, botId) };
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
