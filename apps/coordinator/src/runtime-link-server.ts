import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  RUNTIME_LINK_MAX_PAYLOAD_BYTES,
  RUNTIME_LINK_PATH,
  RUNTIME_LINK_SUBPROTOCOL,
  parseBotProtocolMessage,
  parseBotStopResult,
  parseRuntimeLinkClientMessage,
  parseSkillExecutionResult,
  parseSkillInvocation,
  runtimeLinkAcceptedV1Schema,
  runtimeLinkChallengeV1Schema,
  runtimeLinkClientProofInput,
  runtimeLinkServerProofInput,
  runtimeLinkStateRequestV1Schema,
  runtimeLinkTelemetryAckV1Schema,
  skillCancellationV1Schema,
  type BotSkillCatalogV1,
  type BotStopResultV1,
  type ControlAuthorizationContext,
  type RuntimeLinkAuthenticateV1,
  type RuntimeLinkClientMessageV1,
  type RuntimeLinkProofContext,
  type SkillExecutionResultV1,
  type SkillInvocationV1,
  type StopBotCommandV1,
} from "@minecraft-studio/protocol";
import { WebSocket, WebSocketServer } from "ws";

import {
  BotRegistry,
  CoordinatorTelemetryError,
  type BotRegistryRecord,
} from "./bot-registry.js";
import type { RuntimeLinkPeerConfig } from "./runtime-link-config.js";
import type { StopCommandTransport } from "./stop-controller.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_SOCKET_BUFFERED_BYTES = 256 * 1_024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type RuntimeLinkAddress = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
}>;

export type RuntimeLinkServerOptions = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
  instanceId: string;
  peers: readonly RuntimeLinkPeerConfig[];
  registry: BotRegistry;
  logger: AppLogger;
  now?: () => Date;
  randomId?: () => string;
  randomNonce?: () => string;
  maxSessions?: number;
  maxPendingStops?: number;
  maxPendingSkills?: number;
}>;

export type RuntimeLinkTransportErrorCode =
  | "RUNTIME_LINK_UNAVAILABLE"
  | "RUNTIME_LINK_COMMAND_CONFLICT"
  | "RUNTIME_LINK_ABORTED"
  | "RUNTIME_LINK_BACKPRESSURE"
  | "RUNTIME_LINK_STATUS_BASELINE_STALE"
  | "RUNTIME_LINK_SEND_FAILED"
  | "RUNTIME_LINK_STOPPED";

export class RuntimeLinkTransportError extends Error {
  readonly code: RuntimeLinkTransportErrorCode;

  constructor(code: RuntimeLinkTransportErrorCode, message: string) {
    super(message);
    this.name = "RuntimeLinkTransportError";
    this.code = code;
  }
}

type RuntimeSession = {
  socket: WebSocket;
  challengeMessageId: string;
  challengeNonce: string;
  handshakeTimer: ReturnType<typeof setTimeout>;
  keyId: string | null;
  botId: string | null;
  runtimeInstanceId: string | null;
  authenticated: boolean;
};

type PendingStop = {
  command: StopBotCommandV1;
  session: RuntimeSession;
  resolve: (result: BotStopResultV1) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
};

type PendingSkill = {
  invocation: SkillInvocationV1;
  expectedRuntimeInstanceId: string;
  session: RuntimeSession;
  resolve: (result: SkillExecutionResultV1) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
};

type PendingFreshStatus = {
  botId: string;
  expectedRuntimeInstanceId: string;
  afterStatusSequence: number;
  session: RuntimeSession;
  resolve: () => void;
  reject: (error: Error) => void;
  unsubscribe: () => void;
  removeAbortListener: () => void;
};

export class RuntimeLinkServer implements StopCommandTransport {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly randomNonce: () => string;
  private readonly peers = new Map<string, RuntimeLinkPeerConfig>();
  private readonly sessions = new Set<RuntimeSession>();
  private readonly activeSessions = new Map<string, RuntimeSession>();
  private readonly pendingStops = new Map<string, PendingStop>();
  private readonly pendingSkills = new Map<string, PendingSkill>();
  private readonly pendingFreshStatuses = new Set<PendingFreshStatus>();
  private readonly httpServer: HttpServer;
  private readonly webSocketServer: WebSocketServer;
  private readonly maxSessions: number;
  private readonly maxPendingStops: number;
  private readonly maxPendingSkills: number;
  private started = false;
  private stopped = false;

  constructor(private readonly options: RuntimeLinkServerOptions) {
    if (options.host !== "127.0.0.1" && options.host !== "::1") {
      throw new TypeError("Runtime Link must bind to an explicit loopback host.");
    }
    if (
      !Number.isSafeInteger(options.port) ||
      options.port < 0 ||
      options.port > 65_535
    ) {
      throw new TypeError("Runtime Link port is invalid.");
    }
    if (options.peers.length === 0 || options.peers.length > 1_000) {
      throw new TypeError("Runtime Link requires between 1 and 1000 peers.");
    }
    if (!IDENTIFIER_PATTERN.test(options.instanceId)) {
      throw new TypeError("Runtime Link Coordinator instance ID is invalid.");
    }
    const botIds = new Set<string>();
    const secretHashes = new Set<string>();
    for (const peer of options.peers) {
      if (
        !IDENTIFIER_PATTERN.test(peer.keyId) ||
        !IDENTIFIER_PATTERN.test(peer.botId) ||
        !SHA256_PATTERN.test(peer.secretSha256) ||
        this.peers.has(peer.keyId) ||
        botIds.has(peer.botId) ||
        secretHashes.has(peer.secretSha256)
      ) {
        throw new TypeError("Runtime Link peer configuration is invalid or duplicated.");
      }
      this.peers.set(peer.keyId, peer);
      botIds.add(peer.botId);
      secretHashes.add(peer.secretSha256);
    }

    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.randomNonce =
      options.randomNonce ?? (() => randomBytes(32).toString("base64url"));
    this.maxSessions = boundedInteger(
      options.maxSessions ?? 256,
      1,
      10_000,
      "maxSessions",
    );
    this.maxPendingStops = boundedInteger(
      options.maxPendingStops ?? 128,
      1,
      10_000,
      "maxPendingStops",
    );
    this.maxPendingSkills = boundedInteger(
      options.maxPendingSkills ?? 128,
      1,
      10_000,
      "maxPendingSkills",
    );
    this.httpServer = createServer(
      {
        maxHeaderSize: 16_384,
        headersTimeout: HANDSHAKE_TIMEOUT_MS,
        requestTimeout: HANDSHAKE_TIMEOUT_MS,
        keepAliveTimeout: HANDSHAKE_TIMEOUT_MS,
      },
      (_request, response) => {
        response.writeHead(404, {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
        response.end("Not Found");
      },
    );
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: RUNTIME_LINK_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
      handleProtocols: (protocols) =>
        protocols.has(RUNTIME_LINK_SUBPROTOCOL)
          ? RUNTIME_LINK_SUBPROTOCOL
          : false,
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    this.httpServer.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    this.webSocketServer.on("error", () => {
      safeLog(this.options.logger, "error", "coordinator_runtime_link_server_error", {
        code: "RUNTIME_LINK_SERVER_ERROR",
      });
    });
  }

  async start(): Promise<RuntimeLinkAddress> {
    if (this.started || this.stopped) {
      throw new Error("Runtime Link server cannot be started more than once.");
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
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Runtime Link did not receive a TCP address.");
    }
    return { host: this.options.host, port: (address as AddressInfo).port };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const error = new RuntimeLinkTransportError(
      "RUNTIME_LINK_STOPPED",
      "Runtime Link stopped before the command was confirmed.",
    );
    for (const pending of [...this.pendingStops.values()]) {
      this.rejectPending(pending, error);
    }
    for (const pending of [...this.pendingSkills.values()]) {
      this.sendSkillCancellation(pending, "coordinator_shutdown");
      this.rejectPendingSkill(pending, error);
    }
    for (const pending of [...this.pendingFreshStatuses]) {
      this.rejectPendingFreshStatus(pending, error);
    }
    const sessionClosures = [...this.sessions].map((session) => {
      clearTimeout(session.handshakeTimer);
      return closeWebSocket(session.socket);
    });
    await Promise.allSettled(sessionClosures);
    this.sessions.clear();
    this.activeSessions.clear();

    await Promise.all([
      new Promise<void>((resolve) => this.webSocketServer.close(() => resolve())),
      new Promise<void>((resolve) => {
        if (!this.started) return resolve();
        this.httpServer.close(() => resolve());
        this.httpServer.closeAllConnections();
      }),
    ]);
  }

  sendStopCommand(
    input: StopBotCommandV1,
    authorizationContext: ControlAuthorizationContext,
    signal: AbortSignal,
  ): Promise<unknown> {
    let command: StopBotCommandV1;
    try {
      const parsed = parseBotProtocolMessage(input, authorizationContext);
      if (parsed.type !== "bot.stop.command.v1") {
        throw new Error("Runtime Link only transports stop commands.");
      }
      command = parsed;
    } catch (cause) {
      return Promise.reject(cause);
    }

    const session = this.activeSessions.get(command.botId);
    if (
      !session ||
      !session.authenticated ||
      session.socket.readyState !== WebSocket.OPEN ||
      command.payload.expectedRuntimeInstanceId !== session.runtimeInstanceId
    ) {
      return Promise.reject(
        new RuntimeLinkTransportError(
          "RUNTIME_LINK_UNAVAILABLE",
          "The authenticated target Runtime Link session is unavailable.",
        ),
      );
    }
    if (this.pendingStops.has(command.payload.commandId)) {
      return Promise.reject(
        new RuntimeLinkTransportError(
          "RUNTIME_LINK_COMMAND_CONFLICT",
          "The Runtime Link command ID is already pending.",
        ),
      );
    }
    if (this.pendingStops.size >= this.maxPendingStops) {
      return Promise.reject(
        new RuntimeLinkTransportError(
          "RUNTIME_LINK_BACKPRESSURE",
          "The Runtime Link pending stop limit was reached.",
        ),
      );
    }
    if (signal.aborted) {
      return Promise.reject(abortedError());
    }

    return new Promise<BotStopResultV1>((resolve, reject) => {
      const abort = () => {
        const pending = this.pendingStops.get(command.payload.commandId);
        if (pending) this.rejectPending(pending, abortedError());
      };
      signal.addEventListener("abort", abort, { once: true });
      const pending: PendingStop = {
        command,
        session,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", abort),
      };
      this.pendingStops.set(command.payload.commandId, pending);
      this.sendFrame(session.socket, command, (error) => {
        if (!error) return;
        const current = this.pendingStops.get(command.payload.commandId);
        if (current === pending) {
          this.rejectPending(
            pending,
            new RuntimeLinkTransportError(
              "RUNTIME_LINK_SEND_FAILED",
              "The stop command could not be sent to Bot Runtime.",
            ),
          );
        }
      });
    });
  }

  sendSkillInvocation(
    input: SkillInvocationV1,
    expectedRuntimeInstanceId: string,
    signal: AbortSignal,
  ): Promise<SkillExecutionResultV1> {
    let invocation: SkillInvocationV1;
    try {
      invocation = parseSkillInvocation(input);
      if (invocation.source.instanceId !== this.options.instanceId) {
        throw new Error("Skill invocation source does not match this Coordinator.");
      }
      if (!IDENTIFIER_PATTERN.test(expectedRuntimeInstanceId)) {
        throw new Error("Expected Runtime identity is invalid.");
      }
    } catch (cause) {
      return Promise.reject(cause);
    }

    const session = this.activeSessions.get(invocation.botId);
    if (
      !session ||
      !session.authenticated ||
      session.socket.readyState !== WebSocket.OPEN ||
      session.runtimeInstanceId !== expectedRuntimeInstanceId
    ) {
      return Promise.reject(
        new RuntimeLinkTransportError(
          "RUNTIME_LINK_UNAVAILABLE",
          "The authenticated target Runtime Link session is unavailable.",
        ),
      );
    }
    if (this.pendingSkills.has(invocation.payload.invocationId)) {
      return Promise.reject(
        new RuntimeLinkTransportError(
          "RUNTIME_LINK_COMMAND_CONFLICT",
          "The Runtime Link invocation ID is already pending.",
        ),
      );
    }
    if (this.pendingSkills.size >= this.maxPendingSkills) {
      return Promise.reject(
        new RuntimeLinkTransportError(
          "RUNTIME_LINK_BACKPRESSURE",
          "The Runtime Link pending skill limit was reached.",
        ),
      );
    }
    if (signal.aborted) return Promise.reject(abortedError("skill result"));

    return new Promise<SkillExecutionResultV1>((resolve, reject) => {
      const abort = () => {
        const pending = this.pendingSkills.get(invocation.payload.invocationId);
        if (pending) {
          this.sendSkillCancellation(pending, "caller_cancelled");
          this.rejectPendingSkill(pending, abortedError("skill result"));
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      const pending: PendingSkill = {
        invocation,
        expectedRuntimeInstanceId,
        session,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", abort),
      };
      this.pendingSkills.set(invocation.payload.invocationId, pending);
      this.sendFrame(session.socket, invocation, (error) => {
        if (!error) return;
        const current = this.pendingSkills.get(invocation.payload.invocationId);
        if (current === pending) {
          this.rejectPendingSkill(
            pending,
            new RuntimeLinkTransportError(
              "RUNTIME_LINK_SEND_FAILED",
              "The skill invocation could not be sent to Bot Runtime.",
            ),
          );
        }
      });
    });
  }

  requestFreshStatus(
    botId: string,
    expectedRuntimeInstanceId: string,
    afterStatusSequence: number,
    traceId: string,
    taskId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let request: ReturnType<typeof runtimeLinkStateRequestV1Schema.parse>;
    try {
      const timestamp = validNow(this.now());
      request = runtimeLinkStateRequestV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        traceId,
        timestamp: timestamp.toISOString(),
        source: { service: "coordinator", instanceId: this.options.instanceId },
        botId,
        taskId,
        type: "runtime.link.state-request.v1",
        payload: {
          expectedRuntimeInstanceId,
          afterStatusSequence,
          expiresAt: new Date(timestamp.getTime() + 30_000).toISOString(),
        },
      });
    } catch (cause) {
      return Promise.reject(cause);
    }

    const session = this.activeSessions.get(botId);
    if (
      !session ||
      !session.authenticated ||
      session.socket.readyState !== WebSocket.OPEN ||
      session.runtimeInstanceId !== expectedRuntimeInstanceId
    ) {
      return Promise.reject(
        new RuntimeLinkTransportError(
          "RUNTIME_LINK_UNAVAILABLE",
          "The authenticated target Runtime Link session is unavailable.",
        ),
      );
    }
    if (signal.aborted) {
      return Promise.reject(abortedError("fresh status request"));
    }
    const current = this.options.registry.get(botId, validNow(this.now()));
    if (
      !current ||
      current.runtimeInstanceId !== expectedRuntimeInstanceId ||
      current.currentStatus === null ||
      current.currentStatus.sequence !== afterStatusSequence
    ) {
      return Promise.reject(
        new RuntimeLinkTransportError(
          "RUNTIME_LINK_STATUS_BASELINE_STALE",
          "The fresh status request baseline does not match current Runtime state.",
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.rejectPendingFreshStatus(
          pending,
          abortedError("fresh status request"),
        );
      };
      const pending: PendingFreshStatus = {
        botId,
        expectedRuntimeInstanceId,
        afterStatusSequence,
        session,
        resolve,
        reject,
        unsubscribe: () => undefined,
        removeAbortListener: () => signal.removeEventListener("abort", abort),
      };
      pending.unsubscribe = this.options.registry.subscribe((record) => {
        if (this.isFreshStatus(pending, record)) {
          this.resolvePendingFreshStatus(pending);
        }
      });
      signal.addEventListener("abort", abort, { once: true });
      this.pendingFreshStatuses.add(pending);

      this.sendFrame(session.socket, request, (error) => {
        if (!error || !this.pendingFreshStatuses.has(pending)) return;
        this.rejectPendingFreshStatus(
          pending,
          new RuntimeLinkTransportError(
            "RUNTIME_LINK_SEND_FAILED",
            "The fresh status request could not be sent to Bot Runtime.",
          ),
        );
      });

      const current = this.options.registry.get(botId, validNow(this.now()));
      if (current && this.isFreshStatus(pending, current)) {
        this.resolvePendingFreshStatus(pending);
      }
    });
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (request.headers.origin !== undefined) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (this.sessions.size >= this.maxSessions) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if (
      this.stopped ||
      !isLoopbackAddress(request.socket.remoteAddress) ||
      request.method !== "GET" ||
      request.url !== RUNTIME_LINK_PATH ||
      !hasRuntimeLinkProtocol(request.headers["sec-websocket-protocol"])
    ) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    try {
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.openSession(webSocket);
      });
    } catch {
      rejectUpgrade(socket, 404, "Not Found");
    }
  }

  private openSession(socket: WebSocket): void {
    let challenge: ReturnType<typeof runtimeLinkChallengeV1Schema.parse>;
    try {
      challenge = runtimeLinkChallengeV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "runtime.link.challenge.v1",
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          challengeNonce: this.randomNonce(),
        },
      });
    } catch {
      socket.close(1011, "challenge_failed");
      return;
    }

    const session = {
      socket,
      challengeMessageId: challenge.messageId,
      challengeNonce: challenge.payload.challengeNonce,
      handshakeTimer: setTimeout(() => {
        if (!session.authenticated) socket.close(1008, "handshake_timeout");
      }, HANDSHAKE_TIMEOUT_MS),
      keyId: null,
      botId: null,
      runtimeInstanceId: null,
      authenticated: false,
    } satisfies RuntimeSession;
    this.sessions.add(session);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "text_required");
        return;
      }
      try {
        this.handleFrame(session, data.toString());
      } catch {
        safeLog(
          this.options.logger,
          "error",
          "coordinator_runtime_link_message_failed",
          { botId: session.botId, code: "RUNTIME_LINK_MESSAGE_FAILED" },
        );
        socket.close(1011, "message_failed");
      }
    });
    socket.once("close", () => this.removeSession(session));
    socket.once("error", () => {
      safeLog(this.options.logger, "warn", "coordinator_runtime_link_socket_error", {
        botId: session.botId,
        code: "RUNTIME_LINK_SOCKET_ERROR",
      });
    });
    this.sendFrame(socket, challenge, (error) => {
      if (error) socket.close(1011, "challenge_send_failed");
    });
  }

  private handleFrame(session: RuntimeSession, raw: string): void {
    let message: RuntimeLinkClientMessageV1;
    try {
      message = parseRuntimeLinkClientMessage(JSON.parse(raw) as unknown);
    } catch {
      session.socket.close(1008, "message_invalid");
      return;
    }

    if (!session.authenticated) {
      if (message.type !== "runtime.link.authenticate.v1") {
        session.socket.close(1008, "authentication_required");
        return;
      }
      this.authenticate(session, message);
      return;
    }
    if (message.type === "runtime.link.authenticate.v1") {
      session.socket.close(1008, "already_authenticated");
      return;
    }
    if (!this.matchesSession(session, message)) {
      session.socket.close(1008, "session_identity_mismatch");
      return;
    }
    if (message.type === "bot.stop.result.v1") {
      this.handleStopResult(session, message);
      return;
    }
    if (message.type === "skill.result.v1") {
      this.handleSkillResult(session, message);
      return;
    }
    this.handleTelemetry(session, message);
  }

  private authenticate(
    session: RuntimeSession,
    message: RuntimeLinkAuthenticateV1,
  ): void {
    const peer = this.peers.get(message.payload.keyId);
    const context: RuntimeLinkProofContext = {
      challengeMessageId: message.payload.challengeMessageId,
      coordinatorInstanceId: message.payload.coordinatorInstanceId,
      challengeNonce: message.payload.challengeNonce,
      clientNonce: message.payload.clientNonce,
      botId: message.payload.botId,
      runtimeInstanceId: message.payload.runtimeInstanceId,
      keyId: message.payload.keyId,
    };
    if (
      !peer ||
      peer.botId !== message.payload.botId ||
      message.payload.challengeMessageId !== session.challengeMessageId ||
      message.payload.coordinatorInstanceId !== this.options.instanceId ||
      message.payload.challengeNonce !== session.challengeNonce ||
      !proofMatches(
        message.payload.clientProof,
        hmac(peer.secretSha256, runtimeLinkClientProofInput(context)),
      )
    ) {
      safeLog(this.options.logger, "warn", "coordinator_runtime_link_auth_rejected", {
        botId: message.payload.botId,
        code: "RUNTIME_LINK_AUTH_REJECTED",
      });
      session.socket.close(1008, "authentication_rejected");
      return;
    }

    let accepted: ReturnType<typeof runtimeLinkAcceptedV1Schema.parse>;
    try {
      const authenticateMessageId = message.messageId;
      accepted = runtimeLinkAcceptedV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "runtime.link.accepted.v1",
        payload: {
          challengeMessageId: session.challengeMessageId,
          authenticateMessageId,
          coordinatorInstanceId: this.options.instanceId,
          botId: peer.botId,
          runtimeInstanceId: message.payload.runtimeInstanceId,
          keyId: peer.keyId,
          serverProof: hmac(
            peer.secretSha256,
            runtimeLinkServerProofInput({
              ...context,
              authenticateMessageId,
            }),
          ),
        },
      });
    } catch {
      session.socket.close(1011, "authentication_response_failed");
      return;
    }

    clearTimeout(session.handshakeTimer);
    session.keyId = peer.keyId;
    session.botId = peer.botId;
    session.runtimeInstanceId = message.payload.runtimeInstanceId;
    session.authenticated = true;
    // 会话仲裁提前到认证时刻：同一 botId 的旧会话（进程重启后残留的死
    // socket，或被顶替的旧进程）在这里被立即关闭，而不是等新会话的第一
    // 条遥测。实测两活进程竞争时，迟到仲裁让双方在短时间内互相关闭对方
    // 的会话（telemetry_ack_mismatch 风暴），技能派发也可能打到即将被
    // 关闭的会话上。现在：最新认证者立即获胜，败者收到 runtime_replaced
    // 并按终态处理。
    this.activateSession(session);
    this.sendFrame(session.socket, accepted, (error) => {
      if (error) session.socket.close(1011, "authentication_response_failed");
    });
    safeLog(this.options.logger, "info", "coordinator_runtime_link_authenticated", {
      botId: peer.botId,
      runtimeInstanceId: message.payload.runtimeInstanceId,
    });
  }

  private handleTelemetry(
    session: RuntimeSession,
    message: Exclude<
      RuntimeLinkClientMessageV1,
      RuntimeLinkAuthenticateV1 | BotStopResultV1 | SkillExecutionResultV1
    >,
  ): void {
    try {
      const result = this.options.registry.ingest(message, validNow(this.now()));
      if (result.record.runtimeInstanceId === session.runtimeInstanceId) {
        this.activateSession(session);
      }
      if (message.type === "bot.skill-catalog.v1") {
        this.logSkillCatalog(message, result.accepted, result.reason);
      }
      const acknowledgement = runtimeLinkTelemetryAckV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "runtime.link.telemetry-ack.v1",
        payload: {
          telemetryMessageId: message.messageId,
          accepted: result.accepted,
          reason: result.reason,
        },
      });
      const retireSession =
        result.reason === "retired_runtime" ||
        result.reason === "older_runtime_start";
      this.sendFrame(session.socket, acknowledgement, (error) => {
        if (error) session.socket.close(1011, "telemetry_ack_failed");
        else if (retireSession) session.socket.close(1008, result.reason);
      });
    } catch (cause) {
      const code =
        cause instanceof CoordinatorTelemetryError
          ? cause.code
          : "RUNTIME_LINK_TELEMETRY_FAILED";
      safeLog(this.options.logger, "warn", "coordinator_runtime_link_telemetry_rejected", {
        traceId: message.traceId,
        botId: message.botId,
        code,
      });
      session.socket.close(1008, "telemetry_rejected");
    }
  }

  /**
   * 广告目录此前只进 registry，不进日志：一个技能到底有没有被提供给 planner，
   * 运维和排查都无从确认。这里把已接受的目录本身记下来——只记技能身份与可用性，
   * 不记 serverProfileId、坐标或任何世界内容。
   */
  private logSkillCatalog(
    message: BotSkillCatalogV1,
    accepted: boolean,
    reason: string,
  ): void {
    const available: string[] = [];
    const unavailable: string[] = [];
    for (const entry of message.payload.skills) {
      const identity = `${entry.skillId}@${entry.skillVersion}`;
      if (entry.availability === "available") available.push(identity);
      else unavailable.push(identity);
    }
    safeLog(this.options.logger, "info", "coordinator_runtime_link_skill_catalog", {
      traceId: message.traceId,
      botId: message.botId,
      runtimeInstanceId: message.payload.runtimeInstanceId,
      accepted,
      reason,
      skillCount: message.payload.skills.length,
      availableCount: available.length,
      availableSkills: available,
      unavailableSkills: unavailable,
    });
  }

  private handleStopResult(
    session: RuntimeSession,
    input: BotStopResultV1,
  ): void {
    let result: BotStopResultV1;
    try {
      result = parseBotStopResult(input);
    } catch {
      session.socket.close(1008, "stop_result_invalid");
      return;
    }
    const pending = this.pendingStops.get(result.payload.commandId);
    if (!pending) {
      safeLog(this.options.logger, "warn", "coordinator_runtime_link_late_stop_result", {
        traceId: result.traceId,
        botId: result.botId,
        commandId: result.payload.commandId,
        code: "RUNTIME_LINK_RESULT_NOT_PENDING",
      });
      return;
    }
    if (
      pending.session !== session ||
      result.botId !== pending.command.botId ||
      result.traceId !== pending.command.traceId ||
      result.source.instanceId !== session.runtimeInstanceId ||
      result.payload.runtimeInstanceId !== session.runtimeInstanceId
    ) {
      this.rejectPending(
        pending,
        new RuntimeLinkTransportError(
          "RUNTIME_LINK_SEND_FAILED",
          "The stop result did not match the pending Runtime Link command.",
        ),
      );
      session.socket.close(1008, "stop_result_identity_mismatch");
      return;
    }
    this.pendingStops.delete(result.payload.commandId);
    pending.removeAbortListener();
    pending.resolve(result);
  }

  private handleSkillResult(
    session: RuntimeSession,
    input: SkillExecutionResultV1,
  ): void {
    let result: SkillExecutionResultV1;
    try {
      result = parseSkillExecutionResult(input);
    } catch {
      session.socket.close(1008, "skill_result_invalid");
      return;
    }
    const pending = this.pendingSkills.get(result.payload.invocationId);
    if (!pending) {
      safeLog(this.options.logger, "warn", "coordinator_runtime_link_late_skill_result", {
        traceId: result.traceId,
        botId: result.botId,
        invocationId: result.payload.invocationId,
        code: "RUNTIME_LINK_RESULT_NOT_PENDING",
      });
      return;
    }
    if (
      pending.session !== session ||
      result.botId !== pending.invocation.botId ||
      result.traceId !== pending.invocation.traceId ||
      result.taskId !== pending.invocation.taskId ||
      result.source.instanceId !== pending.expectedRuntimeInstanceId ||
      result.payload.skillId !== pending.invocation.payload.skillId ||
      result.payload.skillVersion !== pending.invocation.payload.skillVersion
    ) {
      this.rejectPendingSkill(
        pending,
        new RuntimeLinkTransportError(
          "RUNTIME_LINK_SEND_FAILED",
          "The skill result did not match the pending Runtime Link invocation.",
        ),
      );
      session.socket.close(1008, "skill_result_identity_mismatch");
      return;
    }
    this.pendingSkills.delete(result.payload.invocationId);
    pending.removeAbortListener();
    pending.resolve(result);
  }

  private matchesSession(
    session: RuntimeSession,
    message: Exclude<RuntimeLinkClientMessageV1, RuntimeLinkAuthenticateV1>,
  ): boolean {
    return (
      message.botId === session.botId &&
      message.source.service === "bot-runtime" &&
      message.source.instanceId === session.runtimeInstanceId &&
      (message.type === "skill.result.v1" ||
        message.payload.runtimeInstanceId === session.runtimeInstanceId)
    );
  }

  private activateSession(session: RuntimeSession): void {
    const botId = session.botId;
    if (!botId) return;
    const previous = this.activeSessions.get(botId);
    if (previous === session) return;
    this.activeSessions.set(botId, session);
    if (previous) previous.socket.close(1012, "runtime_replaced");
  }

  private removeSession(session: RuntimeSession): void {
    clearTimeout(session.handshakeTimer);
    this.sessions.delete(session);
    if (session.botId && this.activeSessions.get(session.botId) === session) {
      this.activeSessions.delete(session.botId);
    }
    const error = new RuntimeLinkTransportError(
      "RUNTIME_LINK_UNAVAILABLE",
      "Bot Runtime disconnected before confirming the stop command.",
    );
    for (const pending of [...this.pendingStops.values()]) {
      if (pending.session === session) this.rejectPending(pending, error);
    }
    for (const pending of [...this.pendingSkills.values()]) {
      if (pending.session === session) this.rejectPendingSkill(pending, error);
    }
    for (const pending of [...this.pendingFreshStatuses]) {
      if (pending.session === session) {
        this.rejectPendingFreshStatus(pending, error);
      }
    }
  }

  private rejectPending(pending: PendingStop, error: Error): void {
    const commandId = pending.command.payload.commandId;
    if (this.pendingStops.get(commandId) !== pending) return;
    this.pendingStops.delete(commandId);
    pending.removeAbortListener();
    pending.reject(error);
  }

  private rejectPendingSkill(pending: PendingSkill, error: Error): void {
    const invocationId = pending.invocation.payload.invocationId;
    if (this.pendingSkills.get(invocationId) !== pending) return;
    this.pendingSkills.delete(invocationId);
    pending.removeAbortListener();
    pending.reject(error);
  }

  private isFreshStatus(
    pending: PendingFreshStatus,
    record: BotRegistryRecord,
  ): boolean {
    return (
      record.botId === pending.botId &&
      record.runtimeInstanceId === pending.expectedRuntimeInstanceId &&
      record.currentStatus !== null &&
      record.currentStatus.runtimeInstanceId ===
        pending.expectedRuntimeInstanceId &&
      record.currentStatus.sequence > pending.afterStatusSequence
    );
  }

  private resolvePendingFreshStatus(pending: PendingFreshStatus): void {
    if (!this.pendingFreshStatuses.delete(pending)) return;
    pending.unsubscribe();
    pending.removeAbortListener();
    pending.resolve();
  }

  private rejectPendingFreshStatus(
    pending: PendingFreshStatus,
    error: Error,
  ): void {
    if (!this.pendingFreshStatuses.delete(pending)) return;
    pending.unsubscribe();
    pending.removeAbortListener();
    pending.reject(error);
  }

  private sendSkillCancellation(
    pending: PendingSkill,
    reason: "caller_cancelled" | "coordinator_shutdown",
  ): void {
    const timestamp = validNow(this.now());
    const cancellation = skillCancellationV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      traceId: pending.invocation.traceId,
      timestamp: timestamp.toISOString(),
      source: { service: "coordinator", instanceId: this.options.instanceId },
      botId: pending.invocation.botId,
      taskId: pending.invocation.taskId,
      type: "skill.cancel.v1",
      payload: {
        invocationId: pending.invocation.payload.invocationId,
        reason,
        expiresAt: new Date(timestamp.getTime() + 30_000).toISOString(),
      },
    });
    this.sendFrame(pending.session.socket, cancellation, () => undefined);
  }

  private sendFrame(
    socket: WebSocket,
    value: unknown,
    callback: (error?: Error) => void,
  ): void {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      callback(new Error("Runtime Link frame is not serializable."));
      return;
    }
    if (
      Buffer.byteLength(serialized, "utf8") > RUNTIME_LINK_MAX_PAYLOAD_BYTES ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES
    ) {
      callback(new Error("Runtime Link outbound boundary was exceeded."));
      return;
    }
    socket.send(serialized, (error) => callback(error ?? undefined));
  }
}

function hmac(secretSha256: string, value: string): string {
  return createHmac("sha256", Buffer.from(secretSha256, "hex"))
    .update(value, "utf8")
    .digest("base64url");
}

function proofMatches(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Runtime Link clock is invalid.");
  }
  return value;
}

function hasRuntimeLinkProtocol(value: string | string[] | undefined): boolean {
  const joined = Array.isArray(value) ? value.join(",") : value;
  return (
    joined
      ?.split(",")
      .map((part) => part.trim())
      .includes(RUNTIME_LINK_SUBPROTOCOL) ?? false
  );
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  return (
    value === "::1" ||
    value.startsWith("127.") ||
    value.toLowerCase().startsWith("::ffff:127.")
  );
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`,
  );
}

function abortedError(subject = "stop confirmation"): RuntimeLinkTransportError {
  return new RuntimeLinkTransportError(
    "RUNTIME_LINK_ABORTED",
    `Runtime Link ${subject} was cancelled.`,
  );
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish();
    }, 500);
    timer.unref();
    socket.once("close", finish);
    socket.close(1001, "server_shutdown");
  });
}

function safeLog(
  logger: AppLogger,
  level: "info" | "warn" | "error",
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    logger[level](event, fields);
  } catch {
    // Observability failures cannot alter authenticated transport state.
  }
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
