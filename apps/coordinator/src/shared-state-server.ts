// ---------------------------------------------------------------------------
// SharedStateServer —— Coordinator-backed 共享状态 HTTP 服务（Phase 5）
//
// 把 InMemoryWorkstationRegistry + FacilityRegistry 暴露为跨进程共享控制面：
//   POST /rpc       {op, args} → {ok:true, result} | {ok:false, error}
//   GET  /snapshot  完整快照（可观测性 / 持久化）
//
// 安全契约：
//   - 默认只绑 127.0.0.1；跨机部署由运维显式配置 host + token
//   - STUDIO_SHARED_STATE_TOKEN 设置后强制 Bearer 校验；token 永不出现在日志
//   - 请求体上限 256KB；未知 op / 坏 JSON → 4xx，不泄漏内部栈
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import {
  captureSharedStateSnapshot,
  createSharedStateDispatcher,
  dispatchSharedState,
  restoreSharedStateSnapshot,
  type SharedStateResponse,
  type SharedStateSnapshot,
} from "@minecraft-studio/skills";
import { FacilityRegistry } from "@minecraft-studio/skills";
import { InMemoryWorkstationRegistry } from "@minecraft-studio/skills";

const MAX_BODY_BYTES = 256 * 1024;

export interface SharedStateServerOptions {
  readonly host?: string;
  readonly port?: number;
  /** 共享密钥；省略则不鉴权（仅限本机回环部署）。 */
  readonly token?: string;
  readonly workstations?: InMemoryWorkstationRegistry;
  readonly facilities?: FacilityRegistry;
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
  readonly workstations: InMemoryWorkstationRegistry;
  readonly facilities: FacilityRegistry;
  private started = false;
  private stopped = false;

  constructor(private readonly options: SharedStateServerOptions = {}) {
    this.workstations = options.workstations ?? new InMemoryWorkstationRegistry();
    this.facilities = options.facilities ?? new FacilityRegistry();
    this.dispatcher = createSharedStateDispatcher(this.workstations, this.facilities);
    this.token = options.token;
    this.logger = options.logger;
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
      if (request.method === "GET" && url.pathname === "/snapshot") {
        if (!this.authorized(request)) {
          this.writeJson(response, 403, { ok: false, error: "unauthorized" });
          return;
        }
        this.writeJson(response, 200, captureSharedStateSnapshot(this.workstations, this.facilities));
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
        const envelope: SharedStateResponse = dispatchSharedState(this.dispatcher, body as { op: string; args?: Record<string, unknown> });
        this.writeJson(response, 200, envelope);
        return;
      }
      this.writeJson(response, 404, { ok: false, error: "not_found" });
    } catch (error) {
      this.logger?.warn("shared_state_request_failed", { code: error instanceof Error ? error.name : "Unknown" });
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
    const host = this.options.host ?? "127.0.0.1";
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
    const address = this.httpServer.address() as AddressInfo;
    this.logger?.info("shared_state_server_started", { host: address.address, port: address.port });
    return { host: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
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
}

/** 从环境变量读取；全部字段缺省 → undefined（不启动）。 */
export function loadSharedStateConfig(env: NodeJS.ProcessEnv = process.env): SharedStateConfig | undefined {
  const port = env.STUDIO_SHARED_STATE_PORT;
  if (!port) return undefined;
  const parsedPort = Number.parseInt(port, 10);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) {
    throw new Error("STUDIO_SHARED_STATE_PORT must be an integer in 1..65535");
  }
  return {
    host: env.STUDIO_SHARED_STATE_HOST ?? "127.0.0.1",
    port: parsedPort,
    token: env.STUDIO_SHARED_STATE_TOKEN,
  };
}
