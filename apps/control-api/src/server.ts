import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
  CoordinatorStopError,
  type BotRegistry,
} from "@minecraft-studio/coordinator";
import {
  botDetailResponseV1Schema,
  botListResponseV1Schema,
  botStreamEventV1Schema,
  botStreamSnapshotV1Schema,
  controlApiErrorV1Schema,
  submitGoalHttpRequestV1Schema,
  submitGoalHttpResponseV1Schema,
  stopBotHttpRequestV1Schema,
  stopBotHttpResponseV1Schema,
  taskDetailResponseV1Schema,
  taskHistoryListQueryV1Schema,
  taskListResponseV1Schema,
  type ControlApiErrorCode,
  type GoalDispatchResultV1,
  type TaskHistoryListQueryV1,
} from "@minecraft-studio/protocol";
import { WebSocket, WebSocketServer } from "ws";

import {
  TokenAuthenticator,
  applicationWebSocketProtocol,
  hasSupportedWebSocketProtocol,
  type ApiPrincipal,
  type ApiPrincipalConfig,
} from "./auth.js";
import {
  BotStateHub,
  type BotStateEvent,
  type BotStateSubscription,
} from "./bot-state-hub.js";
import {
  normalizeBotStateSource,
  type BotStateSource,
  type BotStopRequester,
} from "./bot-state-source.js";
import {
  CoordinatorGoalError,
  CoordinatorLinkClientError,
} from "./coordinator-link-client.js";
import { toPublicBotDetail, toPublicBotSummary } from "./public-view.js";
import { ConnectionLimiter, FixedWindowRateLimiter } from "./rate-limit.js";
import {
  TaskHistorySourceError,
  type TaskHistorySource,
} from "./task-history-source.js";

const BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export type ControlApiLogger = Readonly<{
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}>;

export type SubmitGoalRequest = Readonly<{
  operationId: string;
  taskId: string;
  botId: string;
  actorId: string;
  operatorGoal: string;
  timeoutMs: number;
  issuedAt: Date;
  expiresAt: Date;
}>;

export type GoalSubmitter = Readonly<{
  submitGoal(request: SubmitGoalRequest): Promise<GoalDispatchResultV1>;
}>;

export type ControlApiServerOptions = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
  registry: BotRegistry | BotStateSource;
  stopController?: BotStopRequester;
  goalController?: GoalSubmitter;
  taskHistorySource?: TaskHistorySource;
  principals: readonly ApiPrincipalConfig[];
  logger: ControlApiLogger;
  requestLimitPerMinute?: number;
  handshakeLimitPerMinute?: number;
  maxConnectionsPerSubject?: number;
  staleSweepIntervalMs?: number;
  webSocketPingIntervalMs?: number;
  maxWebSocketBufferedBytes?: number;
  now?: () => Date;
  randomId?: () => string;
}>;

export type ControlApiAddress = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
}>;

export class ControlApiServer {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly authenticator: TokenAuthenticator;
  private readonly remoteRequestLimiter: FixedWindowRateLimiter;
  private readonly principalRequestLimiter: FixedWindowRateLimiter;
  private readonly handshakeLimiter: FixedWindowRateLimiter;
  private readonly connectionLimiter: ConnectionLimiter;
  private readonly stateSource: BotStateSource;
  private readonly hub: BotStateHub;
  private readonly unsubscribeAvailability: () => void;
  private readonly httpServer: HttpServer;
  private readonly webSocketServer: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private readonly socketAlive = new Map<WebSocket, boolean>();
  private readonly staleSweepIntervalMs: number;
  private readonly webSocketPingIntervalMs: number;
  private readonly maxWebSocketBufferedBytes: number;
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;

  constructor(private readonly options: ControlApiServerOptions) {
    if (options.host !== "127.0.0.1" && options.host !== "::1") {
      throw new TypeError("Control API only permits an explicit loopback bind.");
    }
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.authenticator = new TokenAuthenticator(options.principals);
    this.remoteRequestLimiter = new FixedWindowRateLimiter(
      options.requestLimitPerMinute ?? 240,
      60_000,
    );
    this.principalRequestLimiter = new FixedWindowRateLimiter(
      options.requestLimitPerMinute ?? 120,
      60_000,
    );
    this.handshakeLimiter = new FixedWindowRateLimiter(
      options.handshakeLimitPerMinute ?? 30,
      60_000,
    );
    this.connectionLimiter = new ConnectionLimiter(
      options.maxConnectionsPerSubject ?? 5,
    );
    this.stateSource = normalizeBotStateSource(options.registry);
    this.staleSweepIntervalMs = boundedInteger(
      options.staleSweepIntervalMs ?? 1_000,
      100,
      60_000,
      "staleSweepIntervalMs",
    );
    this.webSocketPingIntervalMs = boundedInteger(
      options.webSocketPingIntervalMs ?? 30_000,
      1_000,
      120_000,
      "webSocketPingIntervalMs",
    );
    this.maxWebSocketBufferedBytes = boundedInteger(
      options.maxWebSocketBufferedBytes ?? 1_048_576,
      1_024,
      16_777_216,
      "maxWebSocketBufferedBytes",
    );
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new TypeError("Control API port is invalid.");
    }

    this.hub = new BotStateHub(this.stateSource);
    this.unsubscribeAvailability = this.stateSource.subscribeAvailability(
      (ready) => {
        if (ready) return;
        for (const socket of this.sockets) socket.close(1012, "coordinator_unavailable");
      },
    );
    this.httpServer = createServer(
      {
        maxHeaderSize: 16_384,
        requestTimeout: 10_000,
        headersTimeout: 10_000,
        keepAliveTimeout: 5_000,
      },
      (request, response) => void this.handleHttpSafely(request, response),
    );
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: true,
      maxPayload: 1_024,
      perMessageDeflate: false,
      handleProtocols: (protocols) =>
        protocols.has(applicationWebSocketProtocol())
          ? applicationWebSocketProtocol()
          : false,
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      try {
        this.handleUpgrade(request, socket, head);
      } catch {
        this.options.logger.error("control_api_upgrade_failed", {
          code: "INTERNAL_ERROR",
        });
        this.rejectUpgrade(
          socket,
          500,
          randomUUID(),
          "INTERNAL_ERROR",
          "Stream connection failed.",
        );
      }
    });
    this.httpServer.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    this.webSocketServer.on("error", () => {
      this.options.logger.error("control_api_websocket_server_error");
    });
  }

  async start(): Promise<ControlApiAddress> {
    if (this.started || this.stopped) {
      throw new Error("Control API server cannot be started more than once.");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.httpServer.once("error", onError);
      this.httpServer.listen(
        { host: this.options.host, port: this.options.port, exclusive: true },
        () => {
          this.httpServer.off("error", onError);
          resolve();
        },
      );
    });
    this.started = true;
    if (this.stateSource.sweepStale) {
      this.staleSweepTimer = setInterval(
        () => {
          try {
            this.stateSource.sweepStale?.(this.now());
          } catch {
            this.options.logger.error("control_api_stale_sweep_failed", {
              code: "INTERNAL_ERROR",
            });
          }
        },
        this.staleSweepIntervalMs,
      );
    }
    this.pingTimer = setInterval(
      () => this.pingWebSockets(),
      this.webSocketPingIntervalMs,
    );

    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Control API did not receive a TCP address.");
    }
    return { host: this.options.host, port: (address as AddressInfo).port };
  }

  private async handleHttpSafely(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      await this.handleHttp(request, response);
    } catch {
      this.options.logger.error("control_api_request_failed", {
        code: "INTERNAL_ERROR",
      });
      if (response.headersSent) {
        response.destroy();
        return;
      }
      this.writeError(
        response,
        500,
        randomUUID(),
        "INTERNAL_ERROR",
        "The request could not be completed.",
      );
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.staleSweepTimer) clearInterval(this.staleSweepTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.staleSweepTimer = null;
    this.pingTimer = null;
    this.unsubscribeAvailability();
    this.hub.dispose();
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.socketAlive.clear();

    await Promise.all([
      new Promise<void>((resolve) => this.webSocketServer.close(() => resolve())),
      new Promise<void>((resolve) => {
        if (!this.started) return resolve();
        this.httpServer.close(() => resolve());
        this.httpServer.closeAllConnections();
      }),
    ]);
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestId = this.randomId();
    const now = validNow(this.now());
    const remoteKey = request.socket.remoteAddress ?? "unknown";
    if (!this.remoteRequestLimiter.allow(remoteKey, now.getTime())) {
      this.writeError(response, 429, requestId, "RATE_LIMITED", "Request rate limit exceeded.", {
        "Retry-After": "60",
      });
      return;
    }
    if (!this.hasSupportedHttpVersion(request)) {
      this.writeError(
        response,
        400,
        requestId,
        "UNSUPPORTED_SCHEMA_VERSION",
        "Only schema version 1.0 is supported.",
      );
      return;
    }

    const url = safeUrl(request.url);
    if (!url) {
      this.writeError(response, 400, requestId, "INVALID_REQUEST", "Request URL is invalid.");
      return;
    }
    if (url.searchParams.size !== 0 && url.pathname !== "/v1/tasks") {
      this.writeError(response, 400, requestId, "INVALID_REQUEST", "Unexpected request input.");
      return;
    }

    const principal = this.authenticator.authenticate(request);
    if (!principal) {
      this.writeError(response, 401, requestId, "AUTH_REQUIRED", "Authentication is required.", {
        "WWW-Authenticate": "Bearer",
      });
      return;
    }
    if (!this.principalRequestLimiter.allow(principal.subject, now.getTime())) {
      this.writeError(response, 429, requestId, "RATE_LIMITED", "Request rate limit exceeded.", {
        "Retry-After": "60",
      });
      return;
    }
    if (url.pathname === "/v1/tasks") {
      await this.handleTaskListRequest(
        request,
        response,
        requestId,
        now,
        principal,
        url,
      );
      return;
    }
    if (url.pathname === "/v1/bots") {
      if (request.method !== "GET") {
        this.writeError(
          response,
          405,
          requestId,
          "METHOD_NOT_ALLOWED",
          "This endpoint only accepts GET.",
          { Allow: "GET" },
        );
        return;
      }
      if (hasRequestBody(request)) {
        this.writeError(response, 400, requestId, "INVALID_REQUEST", "Unexpected request input.");
        return;
      }
      if (!principal.permissions.has("bot.read")) {
        this.writeError(response, 403, requestId, "PERMISSION_DENIED", "Bot read permission is required.");
        return;
      }
      if (!this.stateSource.isReady()) {
        this.writeControlUnavailable(response, requestId);
        return;
      }
      const body = botListResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId,
        data: {
          generatedAt: now.toISOString(),
          bots: this.stateSource.list(now).map(toPublicBotSummary),
        },
      });
      this.writeJson(response, 200, body);
      return;
    }

    if (url.pathname === "/v1/goals") {
      if (request.method !== "POST") {
        this.writeError(
          response,
          405,
          requestId,
          "METHOD_NOT_ALLOWED",
          "This endpoint only accepts POST.",
          { Allow: "POST" },
        );
        return;
      }
      if (!principal.permissions.has("goal.submit")) {
        this.writeError(
          response,
          403,
          requestId,
          "PERMISSION_DENIED",
          "Goal submit permission is required.",
        );
        return;
      }
      await this.handleGoalRequest(request, response, requestId, now, principal);
      return;
    }

    const stopMatch = /^\/v1\/bots\/([^/]+)\/stop$/u.exec(url.pathname);
    if (stopMatch) {
      const botId = decodePathSegment(stopMatch[1]);
      if (!botId || !BOT_ID_PATTERN.test(botId)) {
        this.writeError(response, 400, requestId, "INVALID_REQUEST", "Bot identifier is invalid.");
        return;
      }
      if (request.method !== "POST") {
        this.writeError(
          response,
          405,
          requestId,
          "METHOD_NOT_ALLOWED",
          "This endpoint only accepts POST.",
          { Allow: "POST" },
        );
        return;
      }
      if (!principal.permissions.has("bot.stop")) {
        this.writeError(response, 403, requestId, "PERMISSION_DENIED", "Bot stop permission is required.");
        return;
      }
      await this.handleStopRequest(request, response, requestId, now, principal, botId);
      return;
    }

    const taskDetailMatch = /^\/v1\/tasks\/([^/]+)$/u.exec(url.pathname);
    if (taskDetailMatch) {
      const taskId = decodePathSegment(taskDetailMatch[1]);
      if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
        this.writeError(response, 400, requestId, "INVALID_REQUEST", "Task identifier is invalid.");
        return;
      }
      await this.handleTaskDetailRequest(
        request,
        response,
        requestId,
        now,
        principal,
        taskId,
      );
      return;
    }

    const detailMatch = /^\/v1\/bots\/([^/]+)$/u.exec(url.pathname);
    if (!detailMatch) {
      this.writeError(response, 404, requestId, "ROUTE_NOT_FOUND", "API route was not found.");
      return;
    }
    if (request.method !== "GET") {
      this.writeError(
        response,
        405,
        requestId,
        "METHOD_NOT_ALLOWED",
        "This endpoint only accepts GET.",
        { Allow: "GET" },
      );
      return;
    }
    if (hasRequestBody(request)) {
      this.writeError(response, 400, requestId, "INVALID_REQUEST", "Unexpected request input.");
      return;
    }
    if (!principal.permissions.has("bot.read")) {
      this.writeError(response, 403, requestId, "PERMISSION_DENIED", "Bot read permission is required.");
      return;
    }
    const botId = decodePathSegment(detailMatch[1]);
    if (!botId || !BOT_ID_PATTERN.test(botId)) {
      this.writeError(response, 400, requestId, "INVALID_REQUEST", "Bot identifier is invalid.");
      return;
    }
    if (!this.stateSource.isReady()) {
      this.writeControlUnavailable(response, requestId);
      return;
    }
    const record = this.stateSource.get(botId, now);
    if (!record) {
      this.writeError(response, 404, requestId, "BOT_NOT_FOUND", "Bot was not found.");
      return;
    }
    const body = botDetailResponseV1Schema.parse({
      schemaVersion: "1.0",
      requestId,
      data: {
        generatedAt: now.toISOString(),
        bot: toPublicBotDetail(record, principal.permissions),
      },
    });
    this.writeJson(response, 200, body);
  }

  private async handleTaskListRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    now: Date,
    principal: ApiPrincipal,
    url: URL,
  ): Promise<void> {
    if (request.method !== "GET") {
      this.writeError(
        response,
        405,
        requestId,
        "METHOD_NOT_ALLOWED",
        "This endpoint only accepts GET.",
        { Allow: "GET" },
      );
      return;
    }
    if (hasRequestBody(request)) {
      this.writeError(response, 400, requestId, "INVALID_REQUEST", "Unexpected request input.");
      return;
    }
    if (!principal.permissions.has("task.read")) {
      this.writeError(response, 403, requestId, "PERMISSION_DENIED", "Task read permission is required.");
      return;
    }
    const query = parseTaskListQuery(url);
    if (!query) {
      this.writeError(response, 400, requestId, "INVALID_REQUEST", "Task list query is invalid.");
      return;
    }
    const source = this.options.taskHistorySource;
    if (!source?.isTaskHistoryReady()) {
      this.writeTaskHistoryUnavailable(response, requestId);
      return;
    }

    this.options.logger.info("control_api_task_list_requested", {
      traceId: requestId,
      taskId: null,
      botId: query.botId,
      skillId: null,
      modelName: null,
      actorId: principal.subject,
    });
    try {
      const data = await source.listTaskHistory({
        operationId: requestId,
        actorId: principal.subject,
        query,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 10_000),
      });
      const body = taskListResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId,
        data,
      });
      this.writeJson(response, 200, body);
    } catch (cause) {
      this.writeTaskReadError(response, requestId, null, cause);
    }
  }

  private async handleTaskDetailRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    now: Date,
    principal: ApiPrincipal,
    taskId: string,
  ): Promise<void> {
    if (request.method !== "GET") {
      this.writeError(
        response,
        405,
        requestId,
        "METHOD_NOT_ALLOWED",
        "This endpoint only accepts GET.",
        { Allow: "GET" },
      );
      return;
    }
    if (hasRequestBody(request)) {
      this.writeError(response, 400, requestId, "INVALID_REQUEST", "Unexpected request input.");
      return;
    }
    if (!principal.permissions.has("task.read")) {
      this.writeError(response, 403, requestId, "PERMISSION_DENIED", "Task read permission is required.");
      return;
    }
    const source = this.options.taskHistorySource;
    if (!source?.isTaskHistoryReady()) {
      this.writeTaskHistoryUnavailable(response, requestId);
      return;
    }

    this.options.logger.info("control_api_task_detail_requested", {
      traceId: requestId,
      taskId,
      botId: null,
      skillId: null,
      modelName: null,
      actorId: principal.subject,
    });
    try {
      const data = await source.getTaskDetail({
        operationId: requestId,
        actorId: principal.subject,
        taskId,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 10_000),
      });
      const body = taskDetailResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId,
        data,
      });
      this.writeJson(response, 200, body);
    } catch (cause) {
      this.writeTaskReadError(response, requestId, taskId, cause);
    }
  }

  private writeTaskReadError(
    response: ServerResponse,
    requestId: string,
    taskId: string | null,
    cause: unknown,
  ): void {
    const code = cause instanceof TaskHistorySourceError
      ? cause.code
      : "TASK_HISTORY_UNAVAILABLE";
    this.options.logger.warn("control_api_task_read_failed", {
      traceId: requestId,
      taskId,
      botId: null,
      skillId: null,
      modelName: null,
      code,
    });
    if (code === "TASK_NOT_FOUND") {
      this.writeError(response, 404, requestId, "TASK_NOT_FOUND", "Task was not found.");
      return;
    }
    if (code === "AUTHORIZATION_REJECTED") {
      this.writeError(response, 403, requestId, "PERMISSION_DENIED", "Task read authorization was rejected.");
      return;
    }
    if (code === "REQUEST_INVALID") {
      this.writeError(response, 400, requestId, "INVALID_REQUEST", "Task read request was rejected.");
      return;
    }
    this.writeTaskHistoryUnavailable(response, requestId);
  }

  private writeTaskHistoryUnavailable(
    response: ServerResponse,
    requestId: string,
  ): void {
    this.writeError(
      response,
      503,
      requestId,
      "TASK_HISTORY_UNAVAILABLE",
      "Task history is unavailable.",
    );
  }

  private async handleStopRequest(
    request: IncomingMessage,
    response: ServerResponse,
    responseRequestId: string,
    now: Date,
    principal: ApiPrincipal,
    botId: string,
  ): Promise<void> {
    if (!this.stateSource.isReady() || !this.options.stopController) {
      this.writeControlUnavailable(response, responseRequestId);
      return;
    }
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      this.writeError(
        response,
        400,
        responseRequestId,
        "INVALID_REQUEST",
        "A JSON request body is required.",
      );
      return;
    }

    let input: unknown;
    try {
      input = await readLimitedJson(request, 4_096);
    } catch {
      if (!this.stateSource.isReady()) {
        this.writeControlUnavailable(response, responseRequestId);
        return;
      }
      this.writeError(
        response,
        400,
        responseRequestId,
        "INVALID_REQUEST",
        "The stop request body is invalid.",
      );
      return;
    }
    if (!this.stateSource.isReady()) {
      this.writeControlUnavailable(response, responseRequestId);
      return;
    }
    const parsed = stopBotHttpRequestV1Schema.safeParse(input);
    if (!parsed.success) {
      this.writeError(
        response,
        400,
        responseRequestId,
        "INVALID_REQUEST",
        "The stop request body is invalid.",
      );
      return;
    }

    this.options.logger.info("control_api_stop_requested", {
      traceId: parsed.data.requestId,
      taskId: null,
      botId,
      skillId: null,
      modelName: null,
    });
    try {
      const result = await this.options.stopController.requestStop({
        commandId: parsed.data.requestId,
        traceId: parsed.data.requestId,
        botId,
        mode: "graceful",
        reason: "dashboard_operator_confirmed",
        gracePeriodMs: 5_000,
        timeoutMs: 15_000,
        authorization: {
          decisionId: parsed.data.requestId,
          actorId: principal.subject,
          permissions: new Set(["bot.stop"]),
          issuedAt: now,
          expiresAt: new Date(now.getTime() + 30_000),
        },
      });
      const body = stopBotHttpResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: responseRequestId,
        data: {
          botId,
          traceId: result.traceId,
          commandId: result.payload.commandId,
          outcome: result.payload.outcome,
          errorCode: result.payload.errorCode ?? null,
        },
      });
      this.options.logger.info("control_api_stop_result", {
        traceId: result.traceId,
        taskId: null,
        botId,
        skillId: null,
        modelName: null,
        commandId: result.payload.commandId,
        outcome: result.payload.outcome,
      });
      this.writeJson(response, 200, body);
    } catch (cause) {
      this.writeStopError(
        response,
        responseRequestId,
        parsed.data.requestId,
        cause,
        botId,
      );
    }
  }

  private async handleGoalRequest(
    request: IncomingMessage,
    response: ServerResponse,
    responseRequestId: string,
    now: Date,
    principal: ApiPrincipal,
  ): Promise<void> {
    if (!this.options.goalController) {
      this.writeControlUnavailable(response, responseRequestId);
      return;
    }
    const contentType = request.headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      this.writeError(
        response,
        400,
        responseRequestId,
        "INVALID_REQUEST",
        "A JSON request body is required.",
      );
      return;
    }

    let input: unknown;
    try {
      input = await readLimitedJson(request, 16_384);
    } catch {
      this.writeError(
        response,
        400,
        responseRequestId,
        "INVALID_REQUEST",
        "The goal request body is invalid.",
      );
      return;
    }
    const parsed = submitGoalHttpRequestV1Schema.safeParse(input);
    if (!parsed.success) {
      this.writeError(
        response,
        400,
        responseRequestId,
        "INVALID_REQUEST",
        "The goal request body is invalid.",
      );
      return;
    }

    const expiresAt = new Date(now.getTime() + parsed.data.timeoutMs + 5_000);
    this.options.logger.info("control_api_goal_requested", {
      traceId: parsed.data.requestId,
      taskId: parsed.data.requestId,
      botId: parsed.data.botId,
      skillId: null,
      modelName: null,
      actorId: principal.subject,
    });
    try {
      const result = await this.options.goalController.submitGoal({
        operationId: parsed.data.requestId,
        taskId: parsed.data.requestId,
        botId: parsed.data.botId,
        actorId: principal.subject,
        operatorGoal: parsed.data.operatorGoal,
        timeoutMs: parsed.data.timeoutMs,
        issuedAt: now,
        expiresAt,
      });
      const body = submitGoalHttpResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: responseRequestId,
        data: result,
      });
      this.options.logger.info("control_api_goal_result", {
        traceId: parsed.data.requestId,
        taskId: result.taskId,
        botId: result.botId,
        skillId: result.action === "skill_result" ? result.skillId : null,
        modelName: null,
        action: result.action,
      });
      this.writeJson(response, 200, body);
    } catch (cause) {
      this.writeGoalError(
        response,
        responseRequestId,
        parsed.data.requestId,
        parsed.data.botId,
        cause,
      );
    }
  }

  private writeGoalError(
    response: ServerResponse,
    requestId: string,
    traceId: string,
    botId: string,
    cause: unknown,
  ): void {
    const code =
      cause instanceof CoordinatorGoalError ||
      cause instanceof CoordinatorLinkClientError
        ? cause.code
        : "COORDINATOR_LINK_UNAVAILABLE";
    this.options.logger.warn("control_api_goal_failed", {
      traceId,
      taskId: traceId,
      botId,
      skillId: null,
      modelName: null,
      code,
    });
    if (cause instanceof CoordinatorLinkClientError) {
      this.writeControlUnavailable(response, requestId);
      return;
    }
    if (code === "AI_UNAVAILABLE") {
      this.writeError(response, 503, requestId, "AI_UNAVAILABLE", "Local AI Hub is unavailable.");
      return;
    }
    if (code === "AI_QUEUE_FULL" || code === "CONTROL_LINK_BACKPRESSURE") {
      this.writeError(response, 429, requestId, "AI_QUEUE_FULL", "Local AI request queue is full.");
      return;
    }
    if (code === "AI_TIMEOUT") {
      this.writeError(response, 504, requestId, "GOAL_TIMEOUT", "Goal execution timed out.");
      return;
    }
    this.writeError(response, 409, requestId, "GOAL_REJECTED", "Coordinator rejected the goal.");
  }

  private writeStopError(
    response: ServerResponse,
    requestId: string,
    traceId: string,
    cause: unknown,
    botId: string,
  ): void {
    const code =
      cause instanceof CoordinatorStopError ||
      cause instanceof CoordinatorLinkClientError
        ? cause.code
        : "STOP_TRANSPORT_FAILED";
    this.options.logger.warn("control_api_stop_failed", {
      traceId,
      taskId: null,
      botId,
      skillId: null,
      modelName: null,
      code,
    });
    if (cause instanceof CoordinatorLinkClientError) {
      this.writeControlUnavailable(response, requestId);
      return;
    }
    if (code === "BOT_NOT_FOUND") {
      this.writeError(response, 404, requestId, "BOT_NOT_FOUND", "Bot was not found.");
      return;
    }
    if (code === "BOT_NOT_STOPPABLE") {
      this.writeError(response, 409, requestId, "BOT_NOT_STOPPABLE", "Bot is offline or stale.");
      return;
    }
    if (code === "AUTHORIZATION_REJECTED") {
      this.writeError(response, 403, requestId, "PERMISSION_DENIED", "Stop authorization was rejected.");
      return;
    }
    if (code === "STOP_TIMEOUT") {
      this.writeError(response, 504, requestId, "STOP_TIMEOUT", "Bot did not confirm the stop in time.");
      return;
    }
    this.writeError(response, 502, requestId, "STOP_FAILED", "Bot stop could not be confirmed.");
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const requestId = this.randomId();
    const now = validNow(this.now());
    const remoteKey = request.socket.remoteAddress ?? "unknown";
    if (!this.handshakeLimiter.allow(remoteKey, now.getTime())) {
      this.rejectUpgrade(socket, 429, requestId, "RATE_LIMITED", "Connection rate limit exceeded.");
      return;
    }
    const url = safeUrl(request.url);
    if (!url || url.pathname !== "/v1/bots/stream" || url.searchParams.size !== 0) {
      this.rejectUpgrade(socket, 404, requestId, "ROUTE_NOT_FOUND", "Stream route was not found.");
      return;
    }
    if (!hasSupportedWebSocketProtocol(request.headers["sec-websocket-protocol"])) {
      this.rejectUpgrade(
        socket,
        426,
        requestId,
        "UNSUPPORTED_SCHEMA_VERSION",
        "WebSocket protocol minecraft-studio.v1 is required.",
      );
      return;
    }
    const principal = this.authenticator.authenticate(request);
    if (!principal) {
      this.rejectUpgrade(socket, 401, requestId, "AUTH_REQUIRED", "Authentication is required.");
      return;
    }
    if (!principal.permissions.has("bot.read")) {
      this.rejectUpgrade(socket, 403, requestId, "PERMISSION_DENIED", "Bot read permission is required.");
      return;
    }
    if (!this.stateSource.isReady()) {
      this.rejectUpgrade(
        socket,
        503,
        requestId,
        "CONTROL_UNAVAILABLE",
        "Coordinator state is unavailable.",
      );
      return;
    }
    if (!this.connectionLimiter.acquire(principal.subject)) {
      this.rejectUpgrade(socket, 429, requestId, "RATE_LIMITED", "Connection limit exceeded.");
      return;
    }

    try {
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.openWebSocket(webSocket, principal);
      });
    } catch {
      this.connectionLimiter.release(principal.subject);
      this.rejectUpgrade(socket, 500, requestId, "INTERNAL_ERROR", "Stream connection failed.");
    }
  }

  private openWebSocket(webSocket: WebSocket, principal: ApiPrincipal): void {
    let released = false;
    let snapshotSent = false;
    const pending: BotStateEvent[] = [];
    let subscription: BotStateSubscription | null = null;

    const release = () => {
      if (released) return;
      released = true;
      subscription?.unsubscribe();
      this.connectionLimiter.release(principal.subject);
      this.sockets.delete(webSocket);
      this.socketAlive.delete(webSocket);
    };
    webSocket.once("close", release);
    webSocket.once("error", () => {
      this.options.logger.warn("control_api_websocket_client_error", {
        subject: principal.subject,
      });
    });

    try {
      subscription = this.hub.subscribe((event) => {
        if (!snapshotSent) pending.push(event);
        else this.sendStreamEvent(webSocket, principal, event);
      }, validNow(this.now()));
      this.sockets.add(webSocket);
      this.socketAlive.set(webSocket, true);
      webSocket.on("pong", () => this.socketAlive.set(webSocket, true));
      webSocket.on("message", () => webSocket.close(1008, "read_only"));
      const snapshot = botStreamSnapshotV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        streamSequence: subscription.streamSequence,
        type: "bot.stream.snapshot.v1",
        payload: {
          bots: subscription.bots.map((bot) =>
            toPublicBotDetail(bot, principal.permissions),
          ),
        },
      });
      this.sendWebSocket(webSocket, snapshot);
      snapshotSent = true;
      for (const event of pending) {
        if (event.streamSequence > subscription.streamSequence) {
          this.sendStreamEvent(webSocket, principal, event);
        }
      }
      pending.length = 0;
    } catch {
      release();
      if (
        webSocket.readyState === WebSocket.OPEN ||
        webSocket.readyState === WebSocket.CONNECTING
      ) {
        webSocket.close(1011, "stream_initialization_failed");
      }
    }
  }

  private sendStreamEvent(
    webSocket: WebSocket,
    principal: ApiPrincipal,
    event: BotStateEvent,
  ): void {
    try {
      const message = botStreamEventV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        streamSequence: event.streamSequence,
        type: "bot.stream.event.v1",
        payload: {
          event: "upsert",
          bot: toPublicBotDetail(event.bot, principal.permissions),
        },
      });
      this.sendWebSocket(webSocket, message);
    } catch {
      webSocket.close(1011, "stream_event_failed");
    }
  }

  private sendWebSocket(webSocket: WebSocket, value: unknown): void {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    if (webSocket.bufferedAmount > this.maxWebSocketBufferedBytes) {
      webSocket.close(1013, "backpressure");
      return;
    }
    webSocket.send(JSON.stringify(value));
  }

  private pingWebSockets(): void {
    for (const webSocket of this.sockets) {
      if (webSocket.readyState !== WebSocket.OPEN) continue;
      if (!this.socketAlive.get(webSocket)) {
        webSocket.terminate();
        continue;
      }
      this.socketAlive.set(webSocket, false);
      webSocket.ping();
    }
  }

  private hasSupportedHttpVersion(request: IncomingMessage): boolean {
    const value = request.headers["x-studio-schema-version"];
    return value === undefined || value === "1.0";
  }

  private writeControlUnavailable(
    response: ServerResponse,
    requestId: string,
  ): void {
    this.writeError(
      response,
      503,
      requestId,
      "CONTROL_UNAVAILABLE",
      "Coordinator state and stop control are unavailable.",
    );
  }

  private writeError(
    response: ServerResponse,
    status: number,
    requestId: string,
    code: ControlApiErrorCode,
    message: string,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): void {
    const body = controlApiErrorV1Schema.parse({
      schemaVersion: "1.0",
      requestId,
      error: { code, message },
    });
    this.writeJson(response, status, body, extraHeaders);
  }

  private writeJson(
    response: ServerResponse,
    status: number,
    value: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): void {
    response.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
    response.end(JSON.stringify(value));
  }

  private rejectUpgrade(
    socket: Duplex,
    status: number,
    requestId: string,
    code: ControlApiErrorCode,
    message: string,
  ): void {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const body = JSON.stringify(
      controlApiErrorV1Schema.parse({
        schemaVersion: "1.0",
        requestId,
        error: { code, message },
      }),
    );
    const statusText = HTTP_STATUS_TEXT[status] ?? "Error";
    socket.end(
      `HTTP/1.1 ${status} ${statusText}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: application/json; charset=utf-8\r\n" +
        "Cache-Control: no-store\r\n" +
        "X-Content-Type-Options: nosniff\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }
}

const HTTP_STATUS_TEXT: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  426: "Upgrade Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

function parseTaskListQuery(url: URL): TaskHistoryListQueryV1 | null {
  const allowed = new Set(["limit", "cursor", "status", "botId"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  }
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/u.test(rawLimit)) return null;
  const parsed = taskHistoryListQueryV1Schema.safeParse({
    limit: rawLimit === null ? 25 : Number(rawLimit),
    cursor: url.searchParams.get("cursor"),
    status: url.searchParams.get("status"),
    botId: url.searchParams.get("botId"),
  });
  return parsed.success ? parsed.data : null;
}

function safeUrl(value: string | undefined): URL | null {
  if (!value || value.length > 2_048) return null;
  try {
    return new URL(value, "http://control-api.local");
  } catch {
    return null;
  }
}

function decodePathSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function hasRequestBody(request: IncomingMessage): boolean {
  const contentLength = request.headers["content-length"];
  return request.headers["transfer-encoding"] !== undefined ||
    (contentLength !== undefined && contentLength !== "0");
}

async function readLimitedJson(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumBytes) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("request_body_required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Control API clock is invalid.");
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside the allowed range.`);
  }
  return value;
}
