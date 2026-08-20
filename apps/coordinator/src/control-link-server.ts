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
  CONTROL_LINK_MAX_BOTS,
  CONTROL_LINK_MAX_PAYLOAD_BYTES,
  CONTROL_LINK_PATH,
  CONTROL_LINK_SUBPROTOCOL,
  controlLinkAcceptedV1Schema,
  controlLinkChallengeV1Schema,
  controlLinkClientProofInput,
  controlLinkServerProofInput,
  controlLinkSnapshotBeginV1Schema,
  controlLinkSnapshotEndV1Schema,
  controlLinkSnapshotItemV1Schema,
  controlLinkStateUpsertV1Schema,
  controlLinkStopResponseV1Schema,
  controlLinkTeamTaskResponseV1Schema,
  controlLinkTaskResponseV1Schema,
  parseControlLinkClientMessage,
  type ControlLinkAuthenticateV1,
  type ControlLinkProofContext,
  type ControlLinkServerMessageV1,
  type ControlLinkStateUpsertV1,
  type ControlLinkStopErrorCode,
  type ControlLinkStopRequestV1,
  type ControlLinkTaskErrorCode,
  type ControlLinkTaskRequestV1,
  type ControlLinkTeamTaskErrorCode,
  type ControlLinkTeamTaskRequestV1,
  type BotAiPerformanceV1,
  type PublicBotDetailV1,
} from "@minecraft-studio/protocol";
import { WebSocket, WebSocketServer } from "ws";

import { BotRegistry, type BotRegistryRecord } from "./bot-registry.js";
import type { ControlLinkClientConfig } from "./control-link-config.js";
import {
  CoordinatorStopError,
  type StopController,
} from "./stop-controller.js";
import type {
  CoordinatorAIExecutionHandle,
  CoordinatorAIExecutionResult,
} from "./ai-service.js";
import {
  CoordinatorAIPlanningError,
  type CoordinatorPlanRequest,
} from "./ai-planner.js";
import {
  SkillInvocationControllerError,
  type SkillInvocationGrant,
} from "./skill-invocation-controller.js";
import {
  TeamCoordinatorError,
  type TeamCoordinator,
  type TeamTaskAssignment,
} from "./team-coordinator.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 15_000;
const STOP_GRACE_PERIOD_MS = 5_000;
const MAX_SOCKET_BUFFERED_BYTES = 256 * 1_024;
const MAX_RESPONDERS_PER_STOP = 4;
const MAX_RESPONDERS_PER_TASK = 4;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type ControlLinkAddress = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
}>;

export type ControlLinkServerOptions = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
  instanceId: string;
  clients: readonly ControlLinkClientConfig[];
  registry: BotRegistry;
  stopController: Pick<StopController, "requestStop">;
  taskExecutor?: Readonly<{
    requestAndExecute(
      input: CoordinatorPlanRequest,
      grant: SkillInvocationGrant,
    ): CoordinatorAIExecutionHandle;
  }>;
  teamCoordinator?: Pick<TeamCoordinator, "createObjective" | "assignTask" | "releaseTask">;
  aiPerformanceSource?: Readonly<{
    get(botId: string): BotAiPerformanceV1 | null;
    subscribe(listener: (observation: BotAiPerformanceV1) => void): () => void;
  }>;
  logger: AppLogger;
  now?: () => Date;
  randomId?: () => string;
  randomNonce?: () => string;
  maxSessions?: number;
  maxPendingStops?: number;
  maxPendingTasks?: number;
  maxBufferedSnapshotEvents?: number;
  pingIntervalMs?: number;
}>;

type ControlSession = {
  socket: WebSocket;
  challengeMessageId: string;
  challengeNonce: string;
  handshakeTimer: ReturnType<typeof setTimeout>;
  client: ControlLinkClientConfig | null;
  controlApiInstanceId: string | null;
  authenticated: boolean;
  closing: boolean;
  snapshotting: boolean;
  ready: boolean;
  alive: boolean;
  snapshotBaseSequence: number;
  pendingEvents: ControlLinkStateUpsertV1[];
};

type StopResponder = {
  session: ControlSession;
  requestMessageId: string;
};

type PendingStop = {
  fingerprint: string;
  request: ControlLinkStopRequestV1;
  responders: Map<string, StopResponder>;
};

type TaskResponder = {
  session: ControlSession;
  requestMessageId: string;
};

type PendingTask = {
  fingerprint: string;
  request: ControlLinkTaskRequestV1;
  responders: Map<string, TaskResponder>;
  handle: CoordinatorAIExecutionHandle | null;
};

type PendingTeamTask = {
  fingerprint: string;
  request: ControlLinkTeamTaskRequestV1;
  responders: Map<string, TaskResponder>;
  handle: CoordinatorAIExecutionHandle | null;
};

export class ControlLinkServer {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly randomNonce: () => string;
  private readonly clients = new Map<string, ControlLinkClientConfig>();
  private readonly sessions = new Set<ControlSession>();
  private readonly activeSessions = new Map<string, ControlSession>();
  private readonly pendingStops = new Map<string, PendingStop>();
  private readonly pendingTasks = new Map<string, PendingTask>();
  private readonly pendingTeamTasks = new Map<string, PendingTeamTask>();
  private readonly httpServer: HttpServer;
  private readonly webSocketServer: WebSocketServer;
  private readonly unsubscribeRegistry: () => void;
  private readonly unsubscribeAiPerformance: () => void;
  private readonly maxSessions: number;
  private readonly maxPendingStops: number;
  private readonly maxPendingTasks: number;
  private readonly maxBufferedSnapshotEvents: number;
  private readonly pingIntervalMs: number;
  private streamSequence = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;

  constructor(private readonly options: ControlLinkServerOptions) {
    if (options.host !== "127.0.0.1" && options.host !== "::1") {
      throw new TypeError("Control Link must bind to an explicit loopback host.");
    }
    if (
      !Number.isSafeInteger(options.port) ||
      options.port < 0 ||
      options.port > 65_535
    ) {
      throw new TypeError("Control Link port is invalid.");
    }
    if (!IDENTIFIER_PATTERN.test(options.instanceId)) {
      throw new TypeError("Control Link Coordinator instance ID is invalid.");
    }
    if (options.clients.length === 0 || options.clients.length > 64) {
      throw new TypeError("Control Link requires between 1 and 64 clients.");
    }
    const clientIds = new Set<string>();
    const hashes = new Set<string>();
    for (const client of options.clients) {
      const capabilities = new Set(client.capabilities);
      if (
        !IDENTIFIER_PATTERN.test(client.clientId) ||
        !IDENTIFIER_PATTERN.test(client.keyId) ||
        !SHA256_PATTERN.test(client.secretSha256) ||
        this.clients.has(client.keyId) ||
        clientIds.has(client.clientId) ||
        hashes.has(client.secretSha256) ||
        (capabilities.size !== 2 && capabilities.size !== 3) ||
        !capabilities.has("bot.read") ||
        !capabilities.has("bot.stop") ||
        [...capabilities].some(
          (capability) =>
            capability !== "bot.read" &&
            capability !== "bot.stop" &&
            capability !== "task.execute",
        )
      ) {
        throw new TypeError("Control Link client configuration is invalid.");
      }
      this.clients.set(client.keyId, client);
      clientIds.add(client.clientId);
      hashes.add(client.secretSha256);
    }

    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.randomNonce =
      options.randomNonce ?? (() => randomBytes(32).toString("base64url"));
    this.maxSessions = boundedInteger(
      options.maxSessions ?? 32,
      1,
      256,
      "maxSessions",
    );
    this.maxPendingStops = boundedInteger(
      options.maxPendingStops ?? 128,
      1,
      1_000,
      "maxPendingStops",
    );
    this.maxPendingTasks = boundedInteger(
      options.maxPendingTasks ?? 128,
      1,
      1_000,
      "maxPendingTasks",
    );
    this.maxBufferedSnapshotEvents = boundedInteger(
      options.maxBufferedSnapshotEvents ?? 256,
      1,
      10_000,
      "maxBufferedSnapshotEvents",
    );
    this.pingIntervalMs = boundedInteger(
      options.pingIntervalMs ?? 30_000,
      1_000,
      120_000,
      "pingIntervalMs",
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
      maxPayload: CONTROL_LINK_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
      handleProtocols: (protocols) =>
        protocols.has(CONTROL_LINK_SUBPROTOCOL)
          ? CONTROL_LINK_SUBPROTOCOL
          : false,
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    this.httpServer.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    this.webSocketServer.on("error", () => {
      safeLog(this.options.logger, "error", "coordinator_control_link_server_error", {
        code: "CONTROL_LINK_SERVER_ERROR",
      });
    });
    this.unsubscribeRegistry = options.registry.subscribe((record) => {
      this.publishRecord(record);
    });
    this.unsubscribeAiPerformance = options.aiPerformanceSource?.subscribe((observation) => {
      const record = options.registry.get(observation.botId, validNow(this.now()));
      if (record !== null) this.publishRecord(record);
    }) ?? (() => undefined);
  }

  async start(): Promise<ControlLinkAddress> {
    if (this.started || this.stopped) {
      throw new Error("Control Link server cannot be started more than once.");
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
    this.pingTimer = setInterval(() => this.pingSessions(), this.pingIntervalMs);
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Control Link did not receive a TCP address.");
    }
    return { host: this.options.host, port: (address as AddressInfo).port };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeRegistry();
    this.unsubscribeAiPerformance();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const pending of this.pendingStops.values()) {
      pending.responders.clear();
    }
    for (const pending of this.pendingTasks.values()) {
      pending.handle?.cancel("control_link_stopped");
    }
    for (const pending of this.pendingTeamTasks.values()) {
      pending.handle?.cancel("control_link_stopped");
    }
    this.pendingTasks.clear();
    this.pendingTeamTasks.clear();
    this.pendingStops.clear();
    const closures = [...this.sessions].map((session) => {
      this.revokeSession(session);
      return closeWebSocket(session.socket);
    });
    await Promise.allSettled(closures);
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
      request.url !== CONTROL_LINK_PATH ||
      !hasControlLinkProtocol(request.headers["sec-websocket-protocol"])
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
    let challenge: ReturnType<typeof controlLinkChallengeV1Schema.parse>;
    try {
      challenge = controlLinkChallengeV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.challenge.v1",
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          challengeNonce: this.randomNonce(),
        },
      });
    } catch {
      socket.close(1011, "challenge_failed");
      return;
    }

    const session: ControlSession = {
      socket,
      challengeMessageId: challenge.messageId,
      challengeNonce: challenge.payload.challengeNonce,
      handshakeTimer: setTimeout(() => {
        if (!session.authenticated) {
          this.closeSession(session, 1008, "handshake_timeout");
        }
      }, HANDSHAKE_TIMEOUT_MS),
      client: null,
      controlApiInstanceId: null,
      authenticated: false,
      closing: false,
      snapshotting: true,
      ready: false,
      alive: true,
      snapshotBaseSequence: 0,
      pendingEvents: [],
    };
    this.sessions.add(session);
    socket.on("message", (data, isBinary) => {
      if (session.closing) return;
      if (isBinary) {
        this.closeSession(session, 1003, "text_required");
        return;
      }
      try {
        this.handleFrame(session, data.toString());
      } catch {
        safeLog(
          this.options.logger,
          "error",
          "coordinator_control_link_message_failed",
          {
            clientId: session.client?.clientId ?? null,
            code: "CONTROL_LINK_MESSAGE_FAILED",
          },
        );
        this.closeSession(session, 1011, "message_failed");
      }
    });
    socket.on("pong", () => {
      if (!session.closing) session.alive = true;
    });
    socket.once("close", () => this.removeSession(session));
    socket.once("error", () => {
      this.terminateSession(session);
      safeLog(this.options.logger, "warn", "coordinator_control_link_socket_error", {
        clientId: session.client?.clientId ?? null,
        code: "CONTROL_LINK_SOCKET_ERROR",
      });
    });
    this.sendFrame(socket, challenge, (error) => {
      if (error) this.closeSession(session, 1011, "challenge_send_failed");
    });
  }

  private handleFrame(session: ControlSession, raw: string): void {
    if (session.closing) return;
    let message: ReturnType<typeof parseControlLinkClientMessage>;
    try {
      message = parseControlLinkClientMessage(JSON.parse(raw) as unknown);
    } catch {
      this.closeSession(session, 1008, "message_invalid");
      return;
    }
    if (!session.authenticated) {
      if (message.type !== "control.link.authenticate.v1") {
        this.closeSession(session, 1008, "authentication_required");
        return;
      }
      this.authenticate(session, message);
      return;
    }
    if (message.type === "control.link.authenticate.v1") {
      this.closeSession(session, 1008, "already_authenticated");
      return;
    }
    if (!session.ready || !this.matchesSession(session, message)) {
      this.closeSession(session, 1008, "session_identity_mismatch");
      return;
    }
    if (message.type === "control.link.stop-request.v1") {
      this.handleStopRequest(session, message);
      return;
    }
    if (message.type === "control.link.task-request.v1") {
      this.handleTaskRequest(session, message);
      return;
    }
    this.handleTeamTaskRequest(session, message);
  }

  private authenticate(
    session: ControlSession,
    message: ControlLinkAuthenticateV1,
  ): void {
    const client = this.clients.get(message.payload.keyId);
    const context: ControlLinkProofContext = {
      challengeMessageId: message.payload.challengeMessageId,
      coordinatorInstanceId: message.payload.coordinatorInstanceId,
      challengeNonce: message.payload.challengeNonce,
      clientNonce: message.payload.clientNonce,
      clientId: message.payload.clientId,
      controlApiInstanceId: message.payload.controlApiInstanceId,
      keyId: message.payload.keyId,
    };
    if (
      !client ||
      client.clientId !== message.payload.clientId ||
      message.payload.challengeMessageId !== session.challengeMessageId ||
      message.payload.coordinatorInstanceId !== this.options.instanceId ||
      message.payload.challengeNonce !== session.challengeNonce ||
      !proofMatches(
        message.payload.clientProof,
        hmac(client.secretSha256, controlLinkClientProofInput(context)),
      )
    ) {
      safeLog(this.options.logger, "warn", "coordinator_control_link_auth_rejected", {
        clientId: message.payload.clientId,
        code: "CONTROL_LINK_AUTH_REJECTED",
      });
      this.closeSession(session, 1008, "authentication_rejected");
      return;
    }

    const authenticateMessageId = message.messageId;
    let accepted: ReturnType<typeof controlLinkAcceptedV1Schema.parse>;
    try {
      accepted = controlLinkAcceptedV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.accepted.v1",
        payload: {
          challengeMessageId: session.challengeMessageId,
          authenticateMessageId,
          coordinatorInstanceId: this.options.instanceId,
          clientId: client.clientId,
          controlApiInstanceId: message.payload.controlApiInstanceId,
          keyId: client.keyId,
          serverProof: hmac(
            client.secretSha256,
            controlLinkServerProofInput({ ...context, authenticateMessageId }),
          ),
        },
      });
    } catch {
      this.closeSession(session, 1011, "authentication_response_failed");
      return;
    }

    clearTimeout(session.handshakeTimer);
    session.client = client;
    session.controlApiInstanceId = message.payload.controlApiInstanceId;
    session.authenticated = true;
    session.snapshotting = true;
    const previous = this.activeSessions.get(client.clientId);
    this.activeSessions.set(client.clientId, session);
    if (previous && previous !== session) {
      this.closeSession(previous, 1012, "control_api_replaced");
    }
    this.sendFrame(session.socket, accepted, (error) => {
      if (session.closing) return;
      if (error) {
        this.closeSession(session, 1011, "authentication_response_failed");
        return;
      }
      this.sendSnapshot(session);
    });
    safeLog(this.options.logger, "info", "coordinator_control_link_authenticated", {
      clientId: client.clientId,
      controlApiInstanceId: message.payload.controlApiInstanceId,
    });
  }

  private sendSnapshot(session: ControlSession): void {
    if (session.closing || !session.authenticated) return;
    let bots: PublicBotDetailV1[];
    try {
      bots = this.options.registry
        .list(validNow(this.now()))
        .map((record) => this.projectBotState(record));
    } catch {
      this.closeSession(session, 1011, "snapshot_failed");
      return;
    }
    if (bots.length > CONTROL_LINK_MAX_BOTS) {
      this.closeSession(session, 1013, "snapshot_limit");
      return;
    }
    const snapshotId = this.randomId();
    const baseSequence = this.streamSequence;
    session.snapshotBaseSequence = baseSequence;
    const now = validNow(this.now()).toISOString();
    let frames: ControlLinkServerMessageV1[];
    try {
      frames = [
        controlLinkSnapshotBeginV1Schema.parse({
          schemaVersion: "1.0",
          messageId: this.randomId(),
          timestamp: now,
          type: "control.link.snapshot-begin.v1",
          payload: {
            coordinatorInstanceId: this.options.instanceId,
            snapshotId,
            baseSequence,
            botCount: bots.length,
          },
        }),
        ...bots.map((bot, index) =>
          controlLinkSnapshotItemV1Schema.parse({
            schemaVersion: "1.0",
            messageId: this.randomId(),
            timestamp: now,
            type: "control.link.snapshot-item.v1",
            payload: {
              coordinatorInstanceId: this.options.instanceId,
              snapshotId,
              baseSequence,
              index,
              bot,
            },
          }),
        ),
        controlLinkSnapshotEndV1Schema.parse({
          schemaVersion: "1.0",
          messageId: this.randomId(),
          timestamp: now,
          type: "control.link.snapshot-end.v1",
          payload: {
            coordinatorInstanceId: this.options.instanceId,
            snapshotId,
            baseSequence,
            botCount: bots.length,
          },
        }),
      ];
    } catch {
      this.closeSession(session, 1011, "snapshot_failed");
      return;
    }
    this.sendFrames(session, frames, (error) => {
      if (session.closing) return;
      if (error) {
        this.closeSession(session, 1013, "snapshot_send_failed");
        return;
      }
      // Snapshot end is the client's atomic readiness boundary. Buffered
      // upserts remain ordered after it, but a stop sent immediately by the
      // newly-ready client must not be rejected as a pre-authentication frame.
      session.ready = true;
      this.flushSnapshotEvents(session);
    });
  }

  private flushSnapshotEvents(session: ControlSession): void {
    if (
      session.closing ||
      !session.authenticated ||
      session.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const events = session.pendingEvents.filter(
      (event) => event.payload.streamSequence > session.snapshotBaseSequence,
    );
    session.pendingEvents = [];
    if (events.length === 0) {
      session.snapshotting = false;
      return;
    }
    this.sendFrames(session, events, (error) => {
      if (session.closing) return;
      if (error) {
        this.closeSession(session, 1013, "snapshot_event_send_failed");
        return;
      }
      const last = events.at(-1);
      if (last) session.snapshotBaseSequence = last.payload.streamSequence;
      this.flushSnapshotEvents(session);
    });
  }

  private publishRecord(record: BotRegistryRecord): void {
    if (this.stopped) return;
    if (this.streamSequence >= Number.MAX_SAFE_INTEGER) {
      for (const session of this.sessions) {
        this.closeSession(session, 1011, "sequence_exhausted");
      }
      return;
    }
    this.streamSequence += 1;
    let event: ControlLinkStateUpsertV1;
    try {
      event = controlLinkStateUpsertV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.state-upsert.v1",
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          streamSequence: this.streamSequence,
          bot: this.projectBotState(record),
        },
      });
    } catch {
      safeLog(this.options.logger, "error", "coordinator_control_link_state_failed", {
        botId: record.botId,
        code: "CONTROL_LINK_STATE_INVALID",
      });
      return;
    }

    for (const session of this.activeSessions.values()) {
      if (session.closing || !session.authenticated) continue;
      if (session.snapshotting || !session.ready) {
        if (session.pendingEvents.length >= this.maxBufferedSnapshotEvents) {
          this.closeSession(session, 1013, "snapshot_backpressure");
          continue;
        }
        session.pendingEvents.push(event);
        continue;
      }
      this.sendFrame(session.socket, event, (error) => {
        if (error) this.closeSession(session, 1013, "state_backpressure");
      });
    }
  }

  private handleStopRequest(
    session: ControlSession,
    request: ControlLinkStopRequestV1,
  ): void {
    if (session.closing || !session.authenticated || !session.ready) return;
    const operationId = request.payload.operationId;
    const fingerprint = JSON.stringify(request.payload);
    const existing = this.pendingStops.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.sendStopFailure(session, request, "COMMAND_ID_CONFLICT");
        return;
      }
      if (existing.responders.size >= MAX_RESPONDERS_PER_STOP) {
        this.sendStopFailure(session, request, "CONTROL_LINK_BACKPRESSURE");
        return;
      }
      existing.responders.set(request.messageId, {
        session,
        requestMessageId: request.messageId,
      });
      return;
    }
    if (this.pendingStops.size >= this.maxPendingStops) {
      this.sendStopFailure(session, request, "CONTROL_LINK_BACKPRESSURE");
      return;
    }

    const now = validNow(this.now());
    const issuedAt = new Date(request.payload.issuedAt);
    const expiresAt = new Date(request.payload.expiresAt);
    if (
      issuedAt.getTime() > now.getTime() ||
      expiresAt.getTime() < now.getTime() + STOP_TIMEOUT_MS ||
      !session.client?.capabilities.includes("bot.stop")
    ) {
      this.sendStopFailure(session, request, "AUTHORIZATION_REJECTED");
      return;
    }

    const pending: PendingStop = {
      fingerprint,
      request,
      responders: new Map([
        [
          request.messageId,
          { session, requestMessageId: request.messageId },
        ],
      ]),
    };
    this.pendingStops.set(operationId, pending);
    void this.executeStop(pending, now);
  }

  private async executeStop(pending: PendingStop, requestedAt: Date): Promise<void> {
    const request = pending.request;
    try {
      const result = await this.options.stopController.requestStop({
        commandId: request.payload.operationId,
        traceId: request.payload.operationId,
        botId: request.payload.botId,
        mode: "graceful",
        reason: "dashboard_operator_confirmed",
        gracePeriodMs: STOP_GRACE_PERIOD_MS,
        timeoutMs: STOP_TIMEOUT_MS,
        authorization: {
          decisionId: request.payload.operationId,
          actorId: request.payload.actorId,
          permissions: new Set(["bot.stop"]),
          issuedAt: new Date(request.payload.issuedAt),
          expiresAt: new Date(request.payload.expiresAt),
        },
      });
      for (const responder of pending.responders.values()) {
        this.sendStopSuccess(responder, request, result);
      }
      safeLog(this.options.logger, "info", "coordinator_control_link_stop_result", {
        traceId: request.payload.operationId,
        botId: request.payload.botId,
        clientId: request.payload.clientId,
        outcome: result.payload.outcome,
        requestedAt: requestedAt.toISOString(),
      });
    } catch (cause) {
      const errorCode: ControlLinkStopErrorCode =
        cause instanceof CoordinatorStopError
          ? cause.code
          : "CONTROL_LINK_INTERNAL_ERROR";
      for (const responder of pending.responders.values()) {
        this.sendStopFailure(
          responder.session,
          request,
          errorCode,
          responder.requestMessageId,
        );
      }
      safeLog(this.options.logger, "warn", "coordinator_control_link_stop_failed", {
        traceId: request.payload.operationId,
        botId: request.payload.botId,
        clientId: request.payload.clientId,
        code: errorCode,
      });
    } finally {
      if (this.pendingStops.get(request.payload.operationId) === pending) {
        this.pendingStops.delete(request.payload.operationId);
      }
    }
  }

  private handleTaskRequest(
    session: ControlSession,
    request: ControlLinkTaskRequestV1,
  ): void {
    if (session.closing || !session.authenticated || !session.ready) return;
    if (
      !this.options.taskExecutor ||
      !session.client?.capabilities.includes("task.execute")
    ) {
      this.sendTaskFailure(session, request, "AI_UNAVAILABLE");
      return;
    }
    const operationId = request.payload.operationId;
    const fingerprint = JSON.stringify(request.payload);
    if (this.pendingTeamTasks.has(operationId)) {
      this.sendTaskFailure(session, request, "REQUEST_INVALID");
      return;
    }
    const existing = this.pendingTasks.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.sendTaskFailure(session, request, "REQUEST_INVALID");
        return;
      }
      if (existing.responders.size >= MAX_RESPONDERS_PER_TASK) {
        this.sendTaskFailure(session, request, "CONTROL_LINK_BACKPRESSURE");
        return;
      }
      existing.responders.set(request.messageId, {
        session,
        requestMessageId: request.messageId,
      });
      return;
    }
    if (this.pendingTasks.size >= this.maxPendingTasks) {
      this.sendTaskFailure(session, request, "CONTROL_LINK_BACKPRESSURE");
      return;
    }

    const now = validNow(this.now());
    const issuedAt = new Date(request.payload.issuedAt);
    const expiresAt = new Date(request.payload.expiresAt);
    if (
      issuedAt.getTime() > now.getTime() ||
      expiresAt.getTime() <= now.getTime()
    ) {
      this.sendTaskFailure(session, request, "AUTHORIZATION_REJECTED");
      return;
    }
    const pending: PendingTask = {
      fingerprint,
      request,
      responders: new Map([
        [
          request.messageId,
          { session, requestMessageId: request.messageId },
        ],
      ]),
      handle: null,
    };
    this.pendingTasks.set(operationId, pending);
    void this.executeTask(pending, now);
  }

  private async executeTask(
    pending: PendingTask,
    requestedAt: Date,
  ): Promise<void> {
    const request = pending.request;
    try {
      const executor = this.options.taskExecutor;
      if (!executor) throw new Error("AI task execution is unavailable.");
      const handle = executor.requestAndExecute(
        {
          botId: request.payload.botId,
          task: request.payload.task,
          taskId: request.payload.taskId,
          taskVersion: request.payload.taskVersion,
          traceId: request.payload.operationId,
          priority: request.payload.priority,
        },
        {
          decisionId: request.payload.operationId,
          actorId: request.payload.actorId,
          permissions: new Set(["skill.invoke"]),
          maxRisk: "R1",
          issuedAt: new Date(request.payload.issuedAt),
          expiresAt: new Date(request.payload.expiresAt),
        },
      );
      pending.handle = handle;
      const result = await handle.promise;
      for (const responder of pending.responders.values()) {
        this.sendTaskSuccess(
          responder,
          request,
          handle.requestId,
          result,
        );
      }
      safeLog(this.options.logger, "info", "coordinator_control_link_task_result", {
        traceId: request.payload.operationId,
        taskId: request.payload.taskId,
        botId: request.payload.botId,
        clientId: request.payload.clientId,
        plannerRequestId: handle.requestId,
        action: "type" in result ? "skill_result" : "wait",
        requestedAt: requestedAt.toISOString(),
      });
    } catch (cause) {
      const errorCode = taskErrorCode(cause, Boolean(this.options.taskExecutor));
      for (const responder of pending.responders.values()) {
        this.sendTaskFailure(
          responder.session,
          request,
          errorCode,
          responder.requestMessageId,
        );
      }
      safeLog(this.options.logger, "warn", "coordinator_control_link_task_failed", {
        traceId: request.payload.operationId,
        taskId: request.payload.taskId,
        botId: request.payload.botId,
        clientId: request.payload.clientId,
        code: errorCode,
      });
    } finally {
      if (this.pendingTasks.get(request.payload.operationId) === pending) {
        this.pendingTasks.delete(request.payload.operationId);
      }
    }
  }

  private sendTaskSuccess(
    responder: TaskResponder,
    request: ControlLinkTaskRequestV1,
    plannerRequestId: string,
    result: CoordinatorAIExecutionResult,
  ): void {
    if (responder.session.closing) return;
    let response: ReturnType<typeof controlLinkTaskResponseV1Schema.parse>;
    try {
      response = controlLinkTaskResponseV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.task-response.v1",
        ok: true,
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          requestMessageId: responder.requestMessageId,
          operationId: request.payload.operationId,
          botId: request.payload.botId,
          taskId: request.payload.taskId,
          plannerRequestId,
          execution: "type" in result
            ? { action: "skill_result", result }
            : {
                action: "wait",
                provider: result.provider,
                model: result.model,
                reason: result.reason,
                confidence: result.confidence,
              },
        },
      });
    } catch {
      this.closeSession(responder.session, 1011, "task_response_invalid");
      return;
    }
    this.sendFrame(responder.session.socket, response, (error) => {
      if (error) this.closeSession(responder.session, 1013, "task_response_failed");
    });
  }

  private sendTaskFailure(
    session: ControlSession,
    request: ControlLinkTaskRequestV1,
    errorCode: ControlLinkTaskErrorCode,
    requestMessageId = request.messageId,
  ): void {
    if (session.closing) return;
    let response: ReturnType<typeof controlLinkTaskResponseV1Schema.parse>;
    try {
      response = controlLinkTaskResponseV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.task-response.v1",
        ok: false,
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          requestMessageId,
          operationId: request.payload.operationId,
          botId: request.payload.botId,
          taskId: request.payload.taskId,
          errorCode,
        },
      });
    } catch {
      this.closeSession(session, 1011, "task_response_invalid");
      return;
    }
    this.sendFrame(session.socket, response, (error) => {
      if (error) this.closeSession(session, 1013, "task_response_failed");
    });
  }

  private handleTeamTaskRequest(
    session: ControlSession,
    request: ControlLinkTeamTaskRequestV1,
  ): void {
    if (session.closing || !session.authenticated || !session.ready) return;
    if (
      !this.options.taskExecutor ||
      !this.options.teamCoordinator ||
      !session.client?.capabilities.includes("task.execute")
    ) {
      this.sendTeamTaskFailure(session, request, "AI_UNAVAILABLE");
      return;
    }
    const operationId = request.payload.operationId;
    const fingerprint = JSON.stringify(request.payload);
    if (this.pendingTasks.has(operationId)) {
      this.sendTeamTaskFailure(session, request, "REQUEST_INVALID");
      return;
    }
    const existing = this.pendingTeamTasks.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.sendTeamTaskFailure(session, request, "REQUEST_INVALID");
        return;
      }
      if (existing.responders.size >= MAX_RESPONDERS_PER_TASK) {
        this.sendTeamTaskFailure(session, request, "CONTROL_LINK_BACKPRESSURE");
        return;
      }
      existing.responders.set(request.messageId, {
        session,
        requestMessageId: request.messageId,
      });
      return;
    }
    if (this.pendingTasks.size + this.pendingTeamTasks.size >= this.maxPendingTasks) {
      this.sendTeamTaskFailure(session, request, "CONTROL_LINK_BACKPRESSURE");
      return;
    }

    const now = validNow(this.now());
    const issuedAt = new Date(request.payload.issuedAt);
    const expiresAt = new Date(request.payload.expiresAt);
    if (
      issuedAt.getTime() > now.getTime() ||
      expiresAt.getTime() <= now.getTime()
    ) {
      this.sendTeamTaskFailure(session, request, "AUTHORIZATION_REJECTED");
      return;
    }
    const pending: PendingTeamTask = {
      fingerprint,
      request,
      responders: new Map([
        [request.messageId, { session, requestMessageId: request.messageId }],
      ]),
      handle: null,
    };
    this.pendingTeamTasks.set(operationId, pending);
    void this.executeTeamTask(pending, now);
  }

  private async executeTeamTask(
    pending: PendingTeamTask,
    requestedAt: Date,
  ): Promise<void> {
    const request = pending.request;
    let assignment: TeamTaskAssignment | null = null;
    try {
      const executor = this.options.taskExecutor;
      const coordinator = this.options.teamCoordinator;
      if (!executor || !coordinator) {
        throw new Error("AI team task execution is unavailable.");
      }
      coordinator.createObjective(request.payload.objective);
      assignment = coordinator.assignTask(request.payload.assignment);
      const handle = executor.requestAndExecute(
        {
          botId: assignment.botId,
          task: request.payload.task,
          taskId: request.payload.assignment.taskId,
          taskVersion: request.payload.taskVersion,
          traceId: request.payload.operationId,
          priority: request.payload.priority,
        },
        {
          decisionId: request.payload.operationId,
          actorId: request.payload.actorId,
          permissions: new Set(["skill.invoke"]),
          maxRisk: "R1",
          issuedAt: new Date(request.payload.issuedAt),
          expiresAt: new Date(request.payload.expiresAt),
        },
      );
      pending.handle = handle;
      const result = await handle.promise;
      for (const responder of pending.responders.values()) {
        this.sendTeamTaskSuccess(responder, request, assignment, handle.requestId, result);
      }
      safeLog(this.options.logger, "info", "coordinator_control_link_team_task_result", {
        traceId: request.payload.operationId,
        objectiveId: request.payload.objective.objectiveId,
        taskId: request.payload.assignment.taskId,
        botId: assignment.botId,
        role: assignment.role,
        clientId: request.payload.clientId,
        plannerRequestId: handle.requestId,
        action: "type" in result ? "skill_result" : "wait",
        requestedAt: requestedAt.toISOString(),
      });
    } catch (cause) {
      const errorCode = teamTaskErrorCode(
        cause,
        Boolean(this.options.taskExecutor && this.options.teamCoordinator),
      );
      for (const responder of pending.responders.values()) {
        this.sendTeamTaskFailure(
          responder.session,
          request,
          errorCode,
          responder.requestMessageId,
        );
      }
      safeLog(this.options.logger, "warn", "coordinator_control_link_team_task_failed", {
        traceId: request.payload.operationId,
        objectiveId: request.payload.objective.objectiveId,
        taskId: request.payload.assignment.taskId,
        botId: assignment?.botId ?? null,
        clientId: request.payload.clientId,
        code: errorCode,
      });
    } finally {
      if (assignment) this.options.teamCoordinator?.releaseTask(assignment.taskId);
      if (this.pendingTeamTasks.get(request.payload.operationId) === pending) {
        this.pendingTeamTasks.delete(request.payload.operationId);
      }
    }
  }

  private sendTeamTaskSuccess(
    responder: TaskResponder,
    request: ControlLinkTeamTaskRequestV1,
    assignment: TeamTaskAssignment,
    plannerRequestId: string,
    result: CoordinatorAIExecutionResult,
  ): void {
    if (responder.session.closing) return;
    let response: ReturnType<typeof controlLinkTeamTaskResponseV1Schema.parse>;
    try {
      response = controlLinkTeamTaskResponseV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.team-task-response.v1",
        ok: true,
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          requestMessageId: responder.requestMessageId,
          operationId: request.payload.operationId,
          objectiveId: request.payload.objective.objectiveId,
          taskId: request.payload.assignment.taskId,
          plannerRequestId,
          assignment,
          execution: "type" in result
            ? { action: "skill_result", result }
            : {
                action: "wait",
                provider: result.provider,
                model: result.model,
                reason: result.reason,
                confidence: result.confidence,
              },
        },
      });
    } catch {
      this.closeSession(responder.session, 1011, "team_task_response_invalid");
      return;
    }
    this.sendFrame(responder.session.socket, response, (error) => {
      if (error) this.closeSession(responder.session, 1013, "team_task_response_failed");
    });
  }

  private sendTeamTaskFailure(
    session: ControlSession,
    request: ControlLinkTeamTaskRequestV1,
    errorCode: ControlLinkTeamTaskErrorCode,
    requestMessageId = request.messageId,
  ): void {
    if (session.closing) return;
    let response: ReturnType<typeof controlLinkTeamTaskResponseV1Schema.parse>;
    try {
      response = controlLinkTeamTaskResponseV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.team-task-response.v1",
        ok: false,
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          requestMessageId,
          operationId: request.payload.operationId,
          objectiveId: request.payload.objective.objectiveId,
          taskId: request.payload.assignment.taskId,
          errorCode,
        },
      });
    } catch {
      this.closeSession(session, 1011, "team_task_response_invalid");
      return;
    }
    this.sendFrame(session.socket, response, (error) => {
      if (error) this.closeSession(session, 1013, "team_task_response_failed");
    });
  }

  private sendStopSuccess(
    responder: StopResponder,
    request: ControlLinkStopRequestV1,
    result: Awaited<ReturnType<StopController["requestStop"]>>,
  ): void {
    if (responder.session.closing) return;
    let response: ReturnType<typeof controlLinkStopResponseV1Schema.parse>;
    try {
      response = controlLinkStopResponseV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.stop-response.v1",
        ok: true,
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          requestMessageId: responder.requestMessageId,
          operationId: request.payload.operationId,
          botId: request.payload.botId,
          result,
        },
      });
    } catch {
      this.closeSession(responder.session, 1011, "stop_response_invalid");
      return;
    }
    this.sendFrame(responder.session.socket, response, (error) => {
      if (error) {
        this.closeSession(responder.session, 1013, "stop_response_failed");
      }
    });
  }

  private sendStopFailure(
    session: ControlSession,
    request: ControlLinkStopRequestV1,
    errorCode: ControlLinkStopErrorCode,
    requestMessageId = request.messageId,
  ): void {
    if (session.closing) return;
    let response: ReturnType<typeof controlLinkStopResponseV1Schema.parse>;
    try {
      response = controlLinkStopResponseV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.stop-response.v1",
        ok: false,
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          requestMessageId,
          operationId: request.payload.operationId,
          botId: request.payload.botId,
          errorCode,
        },
      });
    } catch {
      this.closeSession(session, 1011, "stop_response_invalid");
      return;
    }
    this.sendFrame(session.socket, response, (error) => {
      if (error) this.closeSession(session, 1013, "stop_response_failed");
    });
  }

  private matchesSession(
    session: ControlSession,
    request:
      | ControlLinkStopRequestV1
      | ControlLinkTaskRequestV1
      | ControlLinkTeamTaskRequestV1,
  ): boolean {
    return (
      request.payload.coordinatorInstanceId === this.options.instanceId &&
      request.payload.clientId === session.client?.clientId &&
      request.payload.controlApiInstanceId === session.controlApiInstanceId
    );
  }

  private sendFrames(
    session: ControlSession,
    frames: readonly ControlLinkServerMessageV1[],
    callback: (error?: Error) => void,
  ): void {
    let index = 0;
    const next = (error?: Error) => {
      if (session.closing) {
        callback(error ?? new Error("Control Link session is closing."));
        return;
      }
      if (error || index >= frames.length) {
        callback(error);
        return;
      }
      const frame = frames[index];
      index += 1;
      this.sendFrame(session.socket, frame, next);
    };
    next();
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
      callback(new Error("Control Link frame is not serializable."));
      return;
    }
    if (
      Buffer.byteLength(serialized, "utf8") > CONTROL_LINK_MAX_PAYLOAD_BYTES ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES
    ) {
      callback(new Error("Control Link outbound boundary was exceeded."));
      return;
    }
    socket.send(serialized, (error) => callback(error ?? undefined));
  }

  private removeSession(session: ControlSession): void {
    this.revokeSession(session);
    this.sessions.delete(session);
  }

  private closeSession(
    session: ControlSession,
    code: number,
    reason: string,
  ): void {
    if (session.closing) return;
    this.revokeSession(session);
    if (
      session.socket.readyState !== WebSocket.OPEN &&
      session.socket.readyState !== WebSocket.CONNECTING
    ) {
      return;
    }
    try {
      session.socket.close(code, reason);
    } catch {
      session.socket.terminate();
    }
  }

  private revokeSession(session: ControlSession): void {
    session.closing = true;
    clearTimeout(session.handshakeTimer);
    session.authenticated = false;
    session.ready = false;
    session.snapshotting = false;
    session.alive = false;
    session.pendingEvents = [];
    const clientId = session.client?.clientId;
    if (clientId && this.activeSessions.get(clientId) === session) {
      this.activeSessions.delete(clientId);
    }
    for (const pending of this.pendingStops.values()) {
      for (const [requestMessageId, responder] of pending.responders) {
        if (responder.session === session) {
          pending.responders.delete(requestMessageId);
        }
      }
    }
    for (const pending of this.pendingTasks.values()) {
      for (const [requestMessageId, responder] of pending.responders) {
        if (responder.session === session) {
          pending.responders.delete(requestMessageId);
        }
      }
    }
    for (const pending of this.pendingTeamTasks.values()) {
      for (const [requestMessageId, responder] of pending.responders) {
        if (responder.session === session) {
          pending.responders.delete(requestMessageId);
        }
      }
    }
  }

  private terminateSession(session: ControlSession): void {
    this.revokeSession(session);
    if (session.socket.readyState === WebSocket.CLOSED) return;
    try {
      session.socket.terminate();
    } catch {
      // Revocation is already synchronous; close cleanup remains idempotent.
    }
  }

  private pingSessions(): void {
    for (const session of this.sessions) {
      if (session.closing) continue;
      if (session.socket.readyState !== WebSocket.OPEN) continue;
      if (!session.alive) {
        this.terminateSession(session);
        continue;
      }
      session.alive = false;
      session.socket.ping();
    }
  }

  private projectBotState(record: BotRegistryRecord): PublicBotDetailV1 {
    return projectBotState(
      record,
      this.options.aiPerformanceSource?.get(record.botId) ?? null,
    );
  }
}

function projectBotState(
  record: BotRegistryRecord,
  aiPerformance: BotAiPerformanceV1 | null = null,
): PublicBotDetailV1 {
  const status = record.currentStatus;
  return {
    botId: record.botId,
    connectionState: record.connectionState,
    lastMessageAt: record.lastMessageAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
    lastStatusAt: record.lastStatusAt,
    health: status?.health ?? null,
    food: status?.food ?? null,
    armorPoints: status?.armorPoints ?? null,
    latencyMs: status?.latencyMs ?? null,
    currentTask: status?.currentTask ?? null,
    position: status?.position ?? null,
    positionRedacted: false,
    minecraftVersion: record.minecraftVersion,
    safety: status?.safety ?? null,
    aiPerformance,
  };
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
    throw new Error("Control Link clock is invalid.");
  }
  return value;
}

function hasControlLinkProtocol(value: string | string[] | undefined): boolean {
  const joined = Array.isArray(value) ? value.join(",") : value;
  return (
    joined
      ?.split(",")
      .map((part) => part.trim())
      .includes(CONTROL_LINK_SUBPROTOCOL) ?? false
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

function taskErrorCode(
  cause: unknown,
  executorAvailable: boolean,
): ControlLinkTaskErrorCode {
  if (!executorAvailable) return "AI_UNAVAILABLE";
  if (cause instanceof CoordinatorAIPlanningError) {
    if (
      cause.code === "BOT_NOT_FOUND" ||
      cause.code === "BOT_NOT_ONLINE" ||
      cause.code === "BOT_STATUS_UNAVAILABLE" ||
      cause.code === "SKILL_CATALOG_UNAVAILABLE"
    ) {
      return "BOT_NOT_EXECUTABLE";
    }
    if (cause.code === "SKILL_NOT_AVAILABLE") return "SKILL_NOT_AVAILABLE";
    if (cause.code === "TASK_VERSION_STALE") return "TASK_VERSION_STALE";
  }
  if (cause instanceof SkillInvocationControllerError) {
    if (cause.code === "AUTHORIZATION_REJECTED") {
      return "AUTHORIZATION_REJECTED";
    }
    return cause.code;
  }
  const code = cause instanceof Error && "code" in cause
    ? String(cause.code)
    : "";
  if (
    code === "AI_REQUEST_TIMEOUT" ||
    code === "AI_REQUEST_STALE" ||
    code === "RUNTIME_LINK_ABORTED"
  ) {
    return code === "AI_REQUEST_STALE" ? "PROPOSAL_STALE" : "TASK_TIMEOUT";
  }
  return "TASK_EXECUTION_FAILED";
}

function teamTaskErrorCode(
  cause: unknown,
  executorAvailable: boolean,
): ControlLinkTeamTaskErrorCode {
  if (!executorAvailable) return "AI_UNAVAILABLE";
  if (cause instanceof TeamCoordinatorError) return cause.code;
  return taskErrorCode(cause, true);
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
