// ---------------------------------------------------------------------------
// SharedStateServer —— Coordinator-backed 共享状态 HTTP 服务（Phase 5）
//
// 把 InMemoryWorkstationRegistry + FacilityRegistry 暴露为跨进程共享控制面：
//   POST /rpc       versioned operation identity + {op, args}; correlated response
//   GET  /snapshot  完整快照（可观测性 / 持久化）
//
// 安全契约：
//   - 默认只绑 127.0.0.1；跨机部署由运维显式配置 host + token
//   - STUDIO_SHARED_STATE_TOKEN 设置后强制 Bearer 校验；token 永不出现在日志
//   - 请求体上限 256KB；未知 op / 坏 JSON → 4xx，不泄漏内部栈
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { botPersonalMemoryScopeSchema, botPersonalMemoryResponseV1Schema } from "@minecraft-studio/protocol";
import { PersonalMemoryError, type PersonalMemoryStore } from "./personal-memory-store.js";

import { BaseRegistry, DurableStateStore, durableSnapshotFrom, stripEphemeralState, type DurableStateSnapshot } from '@minecraft-studio/base-management';
import { WorldAssetAuthority } from '@minecraft-studio/asset-policy';
import { captureSharedStateSnapshot, createSharedStateDispatcher, dispatchSharedState, sharedStateRequestSchema, restoreSharedStateSnapshot, type SharedStateResponse, type SharedStateSnapshot } from '@minecraft-studio/skills';
import { FacilityRegistry } from '@minecraft-studio/asset-policy';
import { InMemoryWorkstationRegistry } from '@minecraft-studio/asset-policy';
import { registriesFromDurableSnapshot } from '@minecraft-studio/base-management';

const MAX_BODY_BYTES = 256 * 1024;

export interface SharedStateServerOptions {
  readonly host?: string;
  readonly port?: number;
  /** 共享密钥；省略则不鉴权（仅限本机回环部署）。 */
  readonly token?: string;
  readonly workstations?: InMemoryWorkstationRegistry;
  readonly facilities?: FacilityRegistry;
  readonly bases?: BaseRegistry;
  readonly provenanceDir?: string;
  /**
   * 持久化文件路径（Phase 6 durable world-memory）。
   * 设置后：启动时加载（durable 恢复，ephemeral 丢弃）、定时落盘、stop 时落盘。
   */
  readonly persistPath?: string;
  readonly persistState?: () => void;
  /** Private, explicitly scoped historical observations. Requires a token even on loopback. */
  readonly personalMemory?: PersonalMemoryStore;
  /** Phase B：手动触发 lesson 复盘（Bearer 鉴权同其它端点）。 */
  readonly lessonReview?: { requestReview(serverProfileId: string, trigger: "manual" | "session-end"): Readonly<{ queued: boolean; reason?: string }> };
  /** Phase B：lesson 卡只读列表（同 profile，按时间倒序）。 */
  readonly lessonStore?: { list(serverProfileId: string): readonly unknown[] };
  /** Phase D1：skill gap 只读视图（含 composition 建议，D4 Gap Console 消费）。 */
  readonly skillGaps?: {
    list(): ReadonlyArray<Record<string, unknown>>;
    compositionSuggestions?(): ReadonlyArray<Readonly<{ fingerprint: string; suggestion: unknown }>>;
  };
  /** Phase D3/D4：release lifecycle 运行时（gap→bundle→draft；operator 决策）。 */
  readonly skillReleases?: {
    list(): ReadonlyArray<Record<string, unknown>>;
    createDraftFromGap(input: Readonly<{ gapFingerprint: string; skillId?: string }>): Readonly<{ ok: boolean; error?: string; releaseId?: string; implementationPrompt?: string }>;
    operatorDecision(input: Readonly<{ releaseId: string; decision: "promote-canary" | "promote-active" | "revoke"; operator: string; note?: string }>): Readonly<{ ok: boolean; error?: string; status?: string }>;
    /** 无隔离服形态：手动记录真实服执行信号（自动钩之外的补充通道）。 */
    recordLiveRun?(input: Readonly<{ releaseId: string; passed: boolean; label?: string }>): Readonly<{ ok: boolean; error?: string; status?: string }>;
  };
  /** 定时落盘间隔；默认 60s；<=0 表示只在 stop 时落盘。 */
  readonly persistIntervalMs?: number;
  readonly logger?: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
}

export interface SharedStateAddress {
  readonly host: string;
  readonly port: number;
}

export class SharedStateServer {
  private readonly httpServer: Server;
  private readonly dispatcher: ReturnType<typeof createSharedStateDispatcher>;
  private readonly token: string | undefined;
  private readonly logger: SharedStateServerOptions["logger"];
  private readonly persistStore: DurableStateStore | null;
  private readonly persistIntervalMs: number;
  private persistTimer: NodeJS.Timeout | null = null;
  readonly workstations: InMemoryWorkstationRegistry;
  readonly facilities: FacilityRegistry;
  readonly bases: BaseRegistry;
  readonly assets: WorldAssetAuthority;
  private started = false;
  private stopped = false;

  constructor(private readonly options: SharedStateServerOptions = {}) {
    this.workstations = options.workstations ?? new InMemoryWorkstationRegistry();
    this.facilities = options.facilities ?? new FacilityRegistry();
    this.bases = options.bases ?? new BaseRegistry();
    this.assets = new WorldAssetAuthority({ bases: this.bases,
      ...(options.provenanceDir ? { persistDir: options.provenanceDir } : {}) });
    this.dispatcher = createSharedStateDispatcher(this.workstations, this.facilities, this.assets, this.assets.workAreas);
    this.token = options.token;
    this.logger = options.logger;
    this.persistStore = options.persistPath ? new DurableStateStore(options.persistPath) : null;
    this.persistIntervalMs = options.persistIntervalMs ?? 60_000;
    this.httpServer = createServer(
      { maxHeaderSize: 16_384, requestTimeout: 15_000, headersTimeout: 15_000 },
      (request, response) => {
        void this.handleRequest(request, response);
      },
    );
    this.httpServer.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
  }

  /** durable 快照（含 bases；GET /snapshot 也用它）。 */
  private currentDurableSnapshot(): DurableStateSnapshot {
    return stripEphemeralState(
      durableSnapshotFrom(this.workstations, this.facilities, this.bases),
    );
  }

  private persist(reason: string): void {
    if (!this.persistStore) return;
    try {
      this.persistStore.save(durableSnapshotFrom(this.workstations, this.facilities, this.bases));
    } catch (error) {
      // 持久化失败不阻塞服务，但必须可见
      this.logger?.warn("shared_state_persist_failed", {
        reason,
        code: error instanceof Error ? error.name : "Unknown",
      });
    }
  }

  private writeJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(payload);
  }

  private authorized(request: IncomingMessage): boolean {
    if (!this.token) return true;
    const header = request.headers.authorization;
    return header === `Bearer ${this.token}`;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://shared-state.local");
      if (request.method === "GET" && url.pathname === "/personal-memory") {
        if (!this.token || !this.authorized(request)) {
          this.writeJson(response, 403, { ok: false, error: "unauthorized" });
          return;
        }
        if (!this.options.personalMemory) {
          this.writeJson(response, 503, { ok: false, error: "personal_memory_unavailable" });
          return;
        }
        const scope = botPersonalMemoryScopeSchema.parse({
          botId: url.searchParams.get("botId"), serverProfileId: url.searchParams.get("serverProfileId"),
          worldId: url.searchParams.get("worldId"),
        });
        this.writeJson(response, 200, botPersonalMemoryResponseV1Schema.parse({
          schemaVersion: "1.0", durability: this.options.personalMemory.durability,
          freshness: "historical", memory: this.options.personalMemory.get(scope),
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/lessons") {
        // Lesson 数据面与 personal-memory 同级敏感：token 必须配置且匹配。
        if (!this.token || !this.authorized(request)) {
          this.writeJson(response, 403, { ok: false, error: "unauthorized" });
          return;
        }
        if (!this.options.lessonStore) {
          this.writeJson(response, 503, { ok: false, error: "lesson_store_unavailable" });
          return;
        }
        const serverProfileId = url.searchParams.get("serverProfileId") ?? "";
        if (serverProfileId.length === 0 || serverProfileId.length > 128) {
          this.writeJson(response, 400, { ok: false, error: "invalid_server_profile" });
          return;
        }
        this.writeJson(response, 200, { ok: true, lessons: this.options.lessonStore.list(serverProfileId) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/lessons/review") {
        // 写触发面：同样 fail-closed 于未配置 token 的部署。
        if (!this.token || !this.authorized(request)) {
          this.writeJson(response, 403, { ok: false, error: "unauthorized" });
          return;
        }
        if (!this.options.lessonReview) {
          this.writeJson(response, 503, { ok: false, error: "lesson_review_unavailable" });
          return;
        }
        const body = await this.readBody(request);
        const serverProfileId = typeof (body as { serverProfileId?: unknown }).serverProfileId === "string"
          ? (body as { serverProfileId: string }).serverProfileId : "";
        if (serverProfileId.length === 0 || serverProfileId.length > 128) {
          this.writeJson(response, 400, { ok: false, error: "invalid_server_profile" });
          return;
        }
        this.writeJson(response, 202, { ok: true, review: this.options.lessonReview.requestReview(serverProfileId, "manual") });
        return;
      }
      if (request.method === "GET" && url.pathname === "/skill-gaps") {
        if (!this.token || !this.authorized(request)) {
          this.writeJson(response, 403, { ok: false, error: "unauthorized" });
          return;
        }
        if (!this.options.skillGaps) {
          this.writeJson(response, 503, { ok: false, error: "skill_gaps_unavailable" });
          return;
        }
        this.writeJson(response, 200, {
          ok: true,
          gaps: this.options.skillGaps.list(),
          ...(this.options.skillGaps.compositionSuggestions
            ? { compositionSuggestions: this.options.skillGaps.compositionSuggestions() }
            : {}),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/skill-releases") {
        // 写面（创建 bundle draft / operator 决策）：强制 token。
        if (!this.token || !this.authorized(request)) {
          this.writeJson(response, 403, { ok: false, error: "unauthorized" });
          return;
        }
        if (!this.options.skillReleases) {
          this.writeJson(response, 503, { ok: false, error: "skill_releases_unavailable" });
          return;
        }
        const body = await this.readBody(request) as { action?: unknown; gapFingerprint?: unknown; skillId?: unknown; releaseId?: unknown; decision?: unknown; operator?: unknown; note?: unknown; passed?: unknown; label?: unknown };
        if (body.action === "create-draft") {
          if (typeof body.gapFingerprint !== "string" || !/^[a-f0-9]{16,64}$/u.test(body.gapFingerprint)) {
            this.writeJson(response, 400, { ok: false, error: "invalid_gap_fingerprint" });
            return;
          }
          const result = this.options.skillReleases.createDraftFromGap({
            gapFingerprint: body.gapFingerprint,
            ...(typeof body.skillId === "string" && body.skillId.length > 0 ? { skillId: body.skillId } : {}),
          });
          this.writeJson(response, result.ok ? 201 : 409, result);
          return;
        }
        if (body.action === "record-live-run") {
          if (typeof body.releaseId !== "string" || typeof body.passed !== "boolean") {
            this.writeJson(response, 400, { ok: false, error: "invalid_request" });
            return;
          }
          if (!this.options.skillReleases.recordLiveRun) {
            this.writeJson(response, 501, { ok: false, error: "live_run_unsupported" });
            return;
          }
          const result = this.options.skillReleases.recordLiveRun({
            releaseId: body.releaseId,
            passed: body.passed,
            ...(typeof body.label === "string" ? { label: body.label.slice(0, 128) } : {}),
          });
          this.writeJson(response, result.ok ? 200 : 409, result);
          return;
        }
        if (body.action === "operator-decision") {
          if (typeof body.releaseId !== "string" || typeof body.decision !== "string" ||
              typeof body.operator !== "string" || body.operator.length === 0) {
            this.writeJson(response, 400, { ok: false, error: "invalid_request" });
            return;
          }
          if (body.decision !== "promote-canary" && body.decision !== "promote-active" && body.decision !== "revoke") {
            this.writeJson(response, 400, { ok: false, error: "invalid_decision" });
            return;
          }
          const result = this.options.skillReleases.operatorDecision({
            releaseId: body.releaseId,
            decision: body.decision,
            operator: body.operator.slice(0, 128),
            ...(typeof body.note === "string" ? { note: body.note.slice(0, 300) } : {}),
          });
          this.writeJson(response, result.ok ? 200 : 409, result);
          return;
        }
        this.writeJson(response, 400, { ok: false, error: "unknown_action" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/skill-releases") {
        if (!this.token || !this.authorized(request)) {
          this.writeJson(response, 403, { ok: false, error: "unauthorized" });
          return;
        }
        if (!this.options.skillReleases) {
          this.writeJson(response, 503, { ok: false, error: "skill_releases_unavailable" });
          return;
        }
        this.writeJson(response, 200, { ok: true, releases: this.options.skillReleases.list() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/snapshot") {
        if (!this.authorized(request)) {
          this.writeJson(response, 403, { ok: false, error: "unauthorized" });
          return;
        }
        this.writeJson(response, 200, this.currentDurableSnapshot());
        return;
      }
      if (request.method === "PUT" && url.pathname === "/snapshot") {
        if (!this.authorized(request)) {
          this.writeJson(response, 403, { ok: false, error: "unauthorized" });
          return;
        }
        const body = await this.readBody(request);
        const restored = restoreSharedStateSnapshot(body as SharedStateSnapshot);
        this.workstations.absorb(restored.workstations);
        this.facilities.absorb(restored.facilities);
        this.writeJson(response, 200, { ok: true, result: { workstations: this.workstations.size, facilities: this.facilities.size } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/rpc") {
        if (!this.authorized(request)) {
          this.writeJson(response, 403, { ok: false, error: "unauthorized" });
          return;
        }
        const body = await this.readBody(request);
        const parsed = sharedStateRequestSchema.parse(body);
        const envelope: SharedStateResponse = dispatchSharedState(this.dispatcher, parsed);
        if (envelope.ok && (parsed.op === "ws.register" || parsed.op === "ws.invalidate" ||
          parsed.op === "ws.clearServer" || (parsed.op.startsWith("fac.") &&
          !["fac.get", "fac.findCandidates", "fac.findByBase", "fac.nextPlannableSlot",
            "fac.reserveSlot", "fac.releaseReservation", "fac.renewSlotReservation", "fac.expireReservations"].includes(parsed.op)))) {
          this.options.persistState?.();
          this.persist("mutation");
        }
        this.writeJson(response, 200, envelope);
        return;
      }
      this.writeJson(response, 404, { ok: false, error: "not_found" });
    } catch (error) {
      this.logger?.warn("shared_state_request_failed", { code: error instanceof Error ? error.name : "Unknown" });
      if (error instanceof PersonalMemoryError) {
        this.writeJson(response, 503, { ok: false, error: error.code });
        return;
      }
      this.writeJson(response, 400, { ok: false, error: "bad_request" });
    }
  }

  private readBody(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("body_too_large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        try {
          resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("invalid_json"));
        }
      });
      request.on("error", reject);
    });
  }

  async start(): Promise<SharedStateAddress> {
    if (this.started || this.stopped) throw new Error("SharedStateServer cannot be started more than once.");
    // Phase 6：启动时先恢复 durable 状态（ephemeral lease/reservation 天然丢弃）
    if (this.persistStore) {
      const persisted = this.persistStore.load();
      if (persisted) {
        const restored = registriesFromDurableSnapshot(persisted);
        this.workstations.absorb(restored.workstations);
        this.facilities.absorb(restored.facilities);
        this.bases.absorb(restored.bases);
        this.logger?.info("shared_state_durable_restored", {
          workstations: this.workstations.size,
          facilities: this.facilities.size,
          bases: this.bases.size,
        });
      }
    }
    const host = this.options.host ?? "127.0.0.1";
    // An unauthenticated shared-state endpoint is safe only on loopback. A
    // typo such as 0.0.0.0 must fail closed before binding /rpc and snapshot
    // mutation routes to the network.
    const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!loopback && !this.token) throw new Error("SHARED_STATE_AUTH_REQUIRED");
    const port = this.options.port ?? 0;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.httpServer.once("error", onError);
      this.httpServer.listen({ host, port, exclusive: true }, () => {
        this.httpServer.off("error", onError);
        resolve();
      });
    });
    this.started = true;
    if (this.persistStore && this.persistIntervalMs > 0) {
      this.persistTimer = setInterval(() => this.persist("interval"), this.persistIntervalMs);
      this.persistTimer.unref?.();
    }
    const address = this.httpServer.address() as AddressInfo;
    this.logger?.info("shared_state_server_started", { host: address.address, port: address.port });
    return { host: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist("shutdown");
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SharedStateConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string | undefined;
  readonly persistPath: string | undefined;
}

/** Default loopback lease authority; this does not start a Minecraft server. */
export function loadSharedStateConfig(env: NodeJS.ProcessEnv = process.env): SharedStateConfig | undefined {
  const port = env.STUDIO_SHARED_STATE_PORT ?? "8791";
  const parsedPort = Number.parseInt(port, 10);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) {
    throw new Error("STUDIO_SHARED_STATE_PORT must be an integer in 1..65535");
  }
  return {
    host: env.STUDIO_SHARED_STATE_HOST ?? "127.0.0.1",
    port: parsedPort,
    token: env.STUDIO_SHARED_STATE_TOKEN,
    persistPath: env.STUDIO_SHARED_STATE_PERSIST_PATH,
  };
}
