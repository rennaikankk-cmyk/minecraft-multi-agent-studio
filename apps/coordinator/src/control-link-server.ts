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
  controlLinkGoalResponseV1Schema,
  controlLinkServerProofInput,
  controlLinkSnapshotBeginV1Schema,
  controlLinkSnapshotEndV1Schema,
  controlLinkSnapshotItemV1Schema,
  controlLinkStateUpsertV1Schema,
  controlLinkStopResponseV1Schema,
  controlLinkTaskDetailResponseV1Schema,
  controlLinkTaskListResponseV1Schema,
  parseControlLinkClientMessage,
  type ControlLinkAuthenticateV1,
  type ControlLinkGoalErrorCode,
  type ControlLinkGoalRequestV1,
  type ControlLinkProofContext,
  type ControlLinkServerMessageV1,
  type ControlLinkStateUpsertV1,
  type ControlLinkStopErrorCode,
  type ControlLinkStopRequestV1,
  type ControlLinkTaskDetailRequestV1,
  type ControlLinkTaskListRequestV1,
  type ControlLinkTaskReadErrorCode,
  type PublicBotDetailV1,
  type GoalDispatchResultV1,
} from "@minecraft-studio/protocol";
import { WebSocket, WebSocketServer } from "ws";

import { BotRegistry, type BotRegistryRecord } from "./bot-registry.js";
import { DurableWaitingGoalQueue } from "./durable-waiting-queue.js";
import {
  BotAssignmentError,
  type BotAssignmentService,
} from "./bot-assignment.js";
import type { ControlLinkClientConfig } from "./control-link-config.js";
import {
  durableGoalFingerprint,
  GoalLifecycleStoreError,
  type GoalExecutionLease,
  type GoalLifecycleSnapshot,
  type GoalLifecycleStore,
  type QueuedGoalLifecycleStore,
} from "./goal-lifecycle-store.js";
import {
  LocalPlannerError,
  type CoordinatorLocalPlanner,
} from "./local-planner.js";
import {
  mapGoalExecutionError,
  projectGoalDispatchResult,
} from "./goal-execution-result.js";
import {
  CoordinatorStopError,
  type StopController,
} from "./stop-controller.js";
import {
  TaskHistoryReaderError,
  type TaskHistoryReader,
} from "./task-history-reader.js";
import type { AutonomousTaskSource } from "./autonomous-director.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;
const STOP_GRACE_PERIOD_MS = 5_000;
const MAX_SOCKET_BUFFERED_BYTES = 256 * 1_024;
const MAX_RESPONDERS_PER_STOP = 4;
const MAX_RESPONDERS_PER_GOAL = 4;
const COMPLETED_GOAL_TTL_MS = 5 * 60_000;
// Round 6.6 停车场上限（bounded；溢出 = BACKPRESSURE 诚实拒绝）。
const WAITING_GOALS_PER_BOT_MAX = 8;
const MAX_COMPLETED_GOALS = 512;
const MAX_TRACKED_GOALS = 1_000;
const GOAL_RECOVERY_INTERVAL_MS = 5_000;
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
  assignment?: Pick<BotAssignmentService, "acquire" | "release">;
  goalPlanner?: Pick<CoordinatorLocalPlanner, "planAndDispatch">;
  goalStore?: GoalLifecycleStore;
  queuedGoalStore?: QueuedGoalLifecycleStore;
  autonomousTaskSource?: AutonomousTaskSource;
  taskHistoryReader?: TaskHistoryReader;
  logger: AppLogger;
  now?: () => Date;
  randomId?: () => string;
  randomNonce?: () => string;
  maxSessions?: number;
  maxPendingStops?: number;
  maxPendingTaskReads?: number;
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

type GoalResponder = {
  session: ControlSession;
  requestMessageId: string;
};

type PendingGoal = {
  fingerprint: string;
  request: ControlLinkGoalRequestV1;
  responders: Map<string, GoalResponder>;
  controller: AbortController;
  execution: Promise<void> | null;
};

type WaitingGoalEntry = {
  pending: PendingGoal;
  lease: GoalExecutionLease;
  /** 停车死线（epoch ms）= park 时刻 + 剩余 timeout；到期诚实终态。 */
  deadlineMs: number;
  deadlineTimer: ReturnType<typeof setTimeout>;
};

type CompletedGoal = Readonly<{
  fingerprint: string;
  expiresAtMs: number;
}> &
  (
    | Readonly<{ result: GoalDispatchResultV1; errorCode?: never }>
    | Readonly<{ result: null; errorCode: ControlLinkGoalErrorCode }>
  );

type PublicCurrentTask = NonNullable<PublicBotDetailV1["currentTask"]>;

type TrackedGoalTask = PublicCurrentTask & {
  operationId: string;
  botId: string;
  order: number;
  expiresAtMs: number | null;
  baselineRuntimeTask: Readonly<{
    taskId: string;
    startedAt: string | null;
  }> | null;
};

export class ControlLinkServer {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly randomNonce: () => string;
  private readonly clients = new Map<string, ControlLinkClientConfig>();
  private readonly sessions = new Set<ControlSession>();
  private readonly activeSessions = new Map<string, ControlSession>();
  private readonly pendingStops = new Map<string, PendingStop>();
  private readonly pendingGoals = new Map<string, PendingGoal>();
  private readonly pendingTaskReads = new Set<symbol>();
  private readonly completedGoals = new Map<string, CompletedGoal>();
  private readonly trackedGoals = new Map<string, TrackedGoalTask>();
  /**
   * Round 6.6 注册屏障：bot 未 goal-ready 时 parked 的 goal（FIFO per bot）。
   * store lease 已持有（task 已持久化为 running + timeoutMs 死线）；就绪翻沿
   * 逐个唤醒执行，停车超时走 GOAL_EXPIRED_WAITING_FOR_BOT 诚实终态。
   * bounded：每 bot 上限 + 全局上限，溢出 = BACKPRESSURE 拒绝。
   */
  private readonly waitingGoals = new Map<string, WaitingGoalEntry[]>();
  private readonly parkedOperationIds = new Set<string>();
  private readonly durableWaitingQueue: DurableWaitingGoalQueue;
  private readonly httpServer: HttpServer;
  private readonly webSocketServer: WebSocketServer;
  private readonly unsubscribeRegistry: () => void;
  private readonly unsubscribeReadiness: () => void;
  private readonly maxSessions: number;
  private readonly maxPendingStops: number;
  private readonly maxPendingTaskReads: number;
  private readonly maxBufferedSnapshotEvents: number;
  private readonly pingIntervalMs: number;
  private readonly unsubscribeAutonomous: () => void;
  private streamSequence = 0;
  private trackedGoalOrder = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private goalRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  private goalRefreshInFlight: Promise<void> | null = null;
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
    if (options.goalPlanner !== undefined && options.goalStore === undefined) {
      throw new TypeError(
        "Control Link goal execution requires durable storage.",
      );
    }
    if (
      options.queuedGoalStore !== undefined &&
      (options.goalPlanner === undefined || options.goalStore === undefined)
    ) {
      throw new TypeError(
        "Queued goal execution requires the durable store and local planner.",
      );
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
        capabilities.size < 2 ||
        capabilities.size > 4 ||
        !capabilities.has("bot.read") ||
        !capabilities.has("bot.stop") ||
        [...capabilities].some(
          (capability) =>
            capability !== "bot.read" &&
            capability !== "bot.stop" &&
            capability !== "goal.submit" &&
            capability !== "task.read",
        )
      ) {
        throw new TypeError("Control Link client configuration is invalid.");
      }
      this.clients.set(client.keyId, client);
      clientIds.add(client.clientId);
      hashes.add(client.secretSha256);
    }

    this.now = options.now ?? (() => new Date());
    this.durableWaitingQueue = new DurableWaitingGoalQueue();
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
    this.maxPendingTaskReads = boundedInteger(
      options.maxPendingTaskReads ?? 128,
      1,
      1_000,
      "maxPendingTaskReads",
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
    // Round 6.6 注册屏障唤醒：就绪翻沿 → 逐个恢复该 bot 的停车 goal。
    this.unsubscribeReadiness = options.registry.onReadinessChange((botId, ready) => {
      if (ready) this.resumeWaitingGoals(botId);
    });
    this.unsubscribeAutonomous = options.autonomousTaskSource?.subscribe((botId) => {
      try {
        const record = this.options.registry.get(botId, validNow(this.now()));
        if (record) this.publishRecord(record);
      } catch {
        // A status presentation update must not break the task source.
      }
    }) ?? (() => undefined);
  }

  async start(): Promise<ControlLinkAddress> {
    if (this.started || this.stopped) {
      throw new Error("Control Link server cannot be started more than once.");
    }
    if (this.options.goalStore) {
      const snapshots = await this.options.goalStore.initialize(
        COMPLETED_GOAL_TTL_MS,
      );
      this.applyGoalSnapshots(snapshots, validNow(this.now()));
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
    if (this.options.goalStore) {
      this.goalRecoveryTimer = setInterval(
        () => void this.refreshPersistedGoals(),
        GOAL_RECOVERY_INTERVAL_MS,
      );
      this.goalRecoveryTimer.unref?.();
    }
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
    this.unsubscribeReadiness();
    this.unsubscribeAutonomous();
    // 停车 goal 的死线定时器全部清掉；store 的 task 恢复路径会诚实过期
    // 残留 lease（不丢、不悬挂）。
    for (const [botId, queue] of this.waitingGoals) {
      for (const entry of queue) {
        clearTimeout(entry.deadlineTimer);
      }
      this.waitingGoals.delete(botId);
    }
    this.parkedOperationIds.clear();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.goalRecoveryTimer) clearInterval(this.goalRecoveryTimer);
    this.goalRecoveryTimer = null;
    for (const pending of this.pendingStops.values()) {
      pending.responders.clear();
    }
    this.pendingStops.clear();
    const goalExecutions: Promise<void>[] = [];
    for (const pending of this.pendingGoals.values()) {
      pending.responders.clear();
      pending.controller.abort(new Error("coordinator_shutdown"));
      if (pending.execution) goalExecutions.push(pending.execution);
    }
    await Promise.allSettled(goalExecutions);
    await this.goalRefreshInFlight;
    this.pendingGoals.clear();
    this.pendingTaskReads.clear();
    this.completedGoals.clear();
    this.trackedGoals.clear();
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
    if (!withinClockSkew(message.timestamp, validNow(this.now()))) {
      this.closeSession(session, 1008, "message_time_invalid");
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
    if (message.type === "control.link.goal-request.v1") {
      this.handleGoalRequest(session, message);
      return;
    }
    if (message.type === "control.link.task-list-request.v1") {
      this.handleTaskListRequest(session, message);
      return;
    }
    this.handleTaskDetailRequest(session, message);
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
    const snapshotNow = validNow(this.now());
    this.pruneTrackedGoals(snapshotNow.getTime());
    let bots: PublicBotDetailV1[];
    try {
      bots = this.options.registry
        .list(snapshotNow)
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
    const now = snapshotNow.toISOString();
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
    const now = validNow(this.now());
    this.pruneTrackedGoals(now.getTime());
    this.streamSequence += 1;
    let event: ControlLinkStateUpsertV1;
    try {
      event = controlLinkStateUpsertV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: now.toISOString(),
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

  private handleTaskListRequest(
    session: ControlSession,
    request: ControlLinkTaskListRequestV1,
  ): void {
    if (!this.taskReadAuthorized(session, request)) {
      this.sendTaskListFailure(session, request, "AUTHORIZATION_REJECTED");
      return;
    }
    if (!this.options.taskHistoryReader) {
      this.sendTaskListFailure(session, request, "TASK_HISTORY_UNAVAILABLE");
      return;
    }
    if (this.pendingTaskReads.size >= this.maxPendingTaskReads) {
      this.sendTaskListFailure(session, request, "CONTROL_LINK_BACKPRESSURE");
      return;
    }
    const pendingToken = Symbol(request.messageId);
    this.pendingTaskReads.add(pendingToken);
    void this.options.taskHistoryReader
      .listTaskHistory(request.payload.query)
      .then((result) => {
        if (session.closing) return;
        const response = controlLinkTaskListResponseV1Schema.parse({
          schemaVersion: "1.0",
          messageId: this.randomId(),
          timestamp: validNow(this.now()).toISOString(),
          type: "control.link.task-list-response.v1",
          ok: true,
          payload: {
            coordinatorInstanceId: this.options.instanceId,
            requestMessageId: request.messageId,
            operationId: request.payload.operationId,
            result,
          },
        });
        this.sendFrame(session.socket, response, (error) => {
          if (error) this.closeSession(session, 1013, "task_list_response_failed");
        });
      })
      .catch((error: unknown) => {
        this.sendTaskListFailure(session, request, taskReadErrorCode(error));
      })
      .finally(() => {
        this.pendingTaskReads.delete(pendingToken);
      });
  }

  private handleTaskDetailRequest(
    session: ControlSession,
    request: ControlLinkTaskDetailRequestV1,
  ): void {
    if (!this.taskReadAuthorized(session, request)) {
      this.sendTaskDetailFailure(session, request, "AUTHORIZATION_REJECTED");
      return;
    }
    if (!this.options.taskHistoryReader) {
      this.sendTaskDetailFailure(session, request, "TASK_HISTORY_UNAVAILABLE");
      return;
    }
    if (this.pendingTaskReads.size >= this.maxPendingTaskReads) {
      this.sendTaskDetailFailure(session, request, "CONTROL_LINK_BACKPRESSURE");
      return;
    }
    const pendingToken = Symbol(request.messageId);
    this.pendingTaskReads.add(pendingToken);
    void this.options.taskHistoryReader
      .getTaskDetail(request.payload.taskId)
      .then((result) => {
        if (result === null) {
          this.sendTaskDetailFailure(session, request, "TASK_NOT_FOUND");
          return;
        }
        if (session.closing) return;
        const response = controlLinkTaskDetailResponseV1Schema.parse({
          schemaVersion: "1.0",
          messageId: this.randomId(),
          timestamp: validNow(this.now()).toISOString(),
          type: "control.link.task-detail-response.v1",
          ok: true,
          payload: {
            coordinatorInstanceId: this.options.instanceId,
            requestMessageId: request.messageId,
            operationId: request.payload.operationId,
            result,
          },
        });
        this.sendFrame(session.socket, response, (error) => {
          if (error) {
            this.closeSession(session, 1013, "task_detail_response_failed");
          }
        });
      })
      .catch((error: unknown) => {
        this.sendTaskDetailFailure(session, request, taskReadErrorCode(error));
      })
      .finally(() => {
        this.pendingTaskReads.delete(pendingToken);
      });
  }

  private taskReadAuthorized(
    session: ControlSession,
    request: ControlLinkTaskListRequestV1 | ControlLinkTaskDetailRequestV1,
  ): boolean {
    const now = validNow(this.now());
    return (
      withinClockSkew(request.payload.issuedAt, now) &&
      Date.parse(request.payload.expiresAt) > now.getTime() &&
      session.client?.capabilities.includes("task.read") === true
    );
  }

  private sendTaskListFailure(
    session: ControlSession,
    request: ControlLinkTaskListRequestV1,
    errorCode: ControlLinkTaskReadErrorCode,
  ): void {
    if (session.closing) return;
    const response = controlLinkTaskListResponseV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      timestamp: validNow(this.now()).toISOString(),
      type: "control.link.task-list-response.v1",
      ok: false,
      payload: {
        coordinatorInstanceId: this.options.instanceId,
        requestMessageId: request.messageId,
        operationId: request.payload.operationId,
        errorCode,
      },
    });
    this.sendFrame(session.socket, response, (error) => {
      if (error) this.closeSession(session, 1013, "task_list_response_failed");
    });
  }

  private sendTaskDetailFailure(
    session: ControlSession,
    request: ControlLinkTaskDetailRequestV1,
    errorCode: ControlLinkTaskReadErrorCode,
  ): void {
    if (session.closing) return;
    const response = controlLinkTaskDetailResponseV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      timestamp: validNow(this.now()).toISOString(),
      type: "control.link.task-detail-response.v1",
      ok: false,
      payload: {
        coordinatorInstanceId: this.options.instanceId,
        requestMessageId: request.messageId,
        operationId: request.payload.operationId,
        errorCode,
      },
    });
    this.sendFrame(session.socket, response, (error) => {
      if (error) this.closeSession(session, 1013, "task_detail_response_failed");
    });
  }

  private handleStopRequest(
    session: ControlSession,
    request: ControlLinkStopRequestV1,
  ): void {
    if (session.closing || !session.authenticated || !session.ready) return;
    const operationId = request.payload.operationId;
    // Authorization timestamps are intentionally excluded. The Control API
    // may renew the short authorization window when retrying the same
    // idempotent operation after a lost response; identity and command
    // parameters remain conflict-bound.
    const fingerprint = stopFingerprint(request);
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
      !withinClockSkew(request.payload.issuedAt, now) ||
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

  private handleGoalRequest(
    session: ControlSession,
    request: ControlLinkGoalRequestV1,
  ): void {
    if (session.closing || !session.authenticated || !session.ready) return;
    const operationId = request.payload.operationId;
    const fingerprint = goalFingerprint(request);
    const now = validNow(this.now());
    this.pruneCompletedGoals(now.getTime());
    const completed = this.completedGoals.get(operationId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        this.sendGoalFailure(session, request, "GOAL_ID_CONFLICT");
      } else if (completed.result) {
        this.sendGoalSuccess(
          { session, requestMessageId: request.messageId },
          request,
          completed.result,
        );
      } else {
        this.sendGoalFailure(
          session,
          request,
          completed.errorCode ?? "CONTROL_LINK_INTERNAL_ERROR",
        );
      }
      return;
    }
    const existing = this.pendingGoals.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.sendGoalFailure(session, request, "GOAL_ID_CONFLICT");
        return;
      }
      if (existing.responders.size >= MAX_RESPONDERS_PER_GOAL) {
        this.sendGoalFailure(session, request, "CONTROL_LINK_BACKPRESSURE");
        return;
      }
      existing.responders.set(request.messageId, {
        session,
        requestMessageId: request.messageId,
      });
      return;
    }
    if (this.pendingGoals.size >= this.maxPendingStops) {
      this.sendGoalFailure(session, request, "CONTROL_LINK_BACKPRESSURE");
      return;
    }

    const issuedAt = new Date(request.payload.issuedAt);
    const expiresAt = new Date(request.payload.expiresAt);
    if (
      !withinClockSkew(request.payload.issuedAt, now) ||
      expiresAt.getTime() < now.getTime() + request.payload.timeoutMs ||
      !session.client?.capabilities.includes("goal.submit")
    ) {
      this.sendGoalFailure(session, request, "AUTHORIZATION_REJECTED");
      return;
    }
    if (!this.options.goalPlanner || !this.options.goalStore) {
      this.sendGoalFailure(session, request, "AI_UNAVAILABLE");
      return;
    }

    const pending: PendingGoal = {
      fingerprint,
      request,
      responders: new Map([
        [
          request.messageId,
          { session, requestMessageId: request.messageId },
        ],
      ]),
      controller: new AbortController(),
      execution: null,
    };
    this.pendingGoals.set(operationId, pending);
    const execution = this.executeGoal(pending);
    pending.execution = execution;
    void execution;
  }

  private async executeGoal(pending: PendingGoal): Promise<void> {
    if (this.options.queuedGoalStore) {
      await this.executeQueuedGoal(pending);
      return;
    }
    const request = pending.request;
    const controller = pending.controller;

    // Phase 1b：durable waiting——bot 未 ready 时，goal 先进入磁盘持久化队列，
    // 不调 goalStore.begin()（不产生 running task/lease）。ready 后从队列取出
    // 走正常 begin→execute 流程。协调器重启后 initialize() 恢复未过期条目。
    if (!this.options.registry.goalExecutionReady(request.payload.botId)) {
      const enqueueResult = this.durableWaitingQueue.enqueue({
        operationId: request.payload.operationId,
        botId: request.payload.botId,
        taskId: request.payload.taskId,
        clientId: request.payload.clientId,
        controlApiInstanceId: request.payload.controlApiInstanceId,
        actorId: request.payload.actorId,
        operatorGoal: request.payload.operatorGoal,
        timeoutMs: request.payload.timeoutMs,
        issuedAtMs: validNow(this.now()).getTime(),
        expiresAtMs: validNow(this.now()).getTime() + request.payload.timeoutMs,
      });
      if (!enqueueResult.accepted) {
        for (const responder of pending.responders.values()) {
          this.sendGoalFailure(responder.session, request, "CONTROL_LINK_BACKPRESSURE", responder.requestMessageId);
        }
        if (this.pendingGoals.get(request.payload.operationId) === pending) {
          this.pendingGoals.delete(request.payload.operationId);
        }
        return;
      }
      for (const responder of pending.responders.values()) {
        this.sendGoalWaiting(
          responder,
          request,
          validNow(this.now()).getTime() + request.payload.timeoutMs,
        );
      }
      safeLog(this.options.logger, "info", "coordinator_goal_durable_waiting", {
        traceId: request.payload.operationId,
        botId: request.payload.botId,
        queueSize: this.durableWaitingQueue.size,
        diskDegraded: this.durableWaitingQueue.diskDegraded,
      });
      return; // pendingGoals 条目保留（幂等多路复用），唤醒时从队列取出重建
    }

    let lease: GoalExecutionLease | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("goal_timeout"));
    }, request.payload.timeoutMs);
    let parked = false;
    try {
      const begin = await this.options.goalStore!.begin(request);
      this.applyGoalSnapshots([begin.snapshot], validNow(this.now()));
      if (begin.kind === "busy") {
        for (const responder of pending.responders.values()) {
          this.sendGoalFailure(
            responder.session,
            request,
            "CONTROL_LINK_BACKPRESSURE",
            responder.requestMessageId,
          );
        }
        return;
      }
      if (begin.kind === "result") {
        this.rememberCompletedGoal(request.payload.operationId, {
          fingerprint: begin.snapshot.fingerprint,
          result: begin.result,
          expiresAtMs: validNow(this.now()).getTime() + COMPLETED_GOAL_TTL_MS,
        });
        for (const responder of pending.responders.values()) {
          this.sendGoalSuccess(responder, request, begin.result);
        }
        return;
      }
      if (begin.kind === "error") {
        this.rememberCompletedGoal(request.payload.operationId, {
          fingerprint: begin.snapshot.fingerprint,
          result: null,
          errorCode: begin.errorCode,
          expiresAtMs: validNow(this.now()).getTime() + COMPLETED_GOAL_TTL_MS,
        });
        for (const responder of pending.responders.values()) {
          this.sendGoalFailure(
            responder.session,
            request,
            begin.errorCode,
            responder.requestMessageId,
          );
        }
        return;
      }
      lease = begin.lease;
      // Round 6.6 注册屏障：bot 未 goal-ready 时**停车等待**而非永久拒绝。
      // store lease 已持久化（task=running，timeoutMs 死线）；就绪翻沿唤醒。
      if (!this.options.registry.goalExecutionReady(request.payload.botId)) {
        clearTimeout(timer);
        this.parkWaitingGoal(pending, lease);
        parked = true;
        return;
      }
      if (timedOut || controller.signal.aborted) {
        throw new Error(timedOut ? "goal_timeout" : "goal_aborted");
      }
      await this.executeAcquiredGoal(pending, lease, timer);
    } finally {
      // parked goal 的 pendingGoals 条目是幂等多路复用与唤醒的锚点，不能清。
      if (!parked && this.pendingGoals.get(request.payload.operationId) === pending) {
        this.pendingGoals.delete(request.payload.operationId);
      }
    }
  }

  /**
   * 已取得 store lease 的执行段（assignment → planner → 结果/失败/清理）。
   * 停车唤醒路径以剩余时间重建 timer 后复用同一段，保证语义完全一致。
   */
  private async executeAcquiredGoal(
    pending: PendingGoal,
    lease: GoalExecutionLease,
    timer: ReturnType<typeof setTimeout>,
  ): Promise<void> {
    const request = pending.request;
    const controller = pending.controller;
    let assignmentLeaseId: string | null = null;
    let timedOut = false;
    try {
      assignmentLeaseId = await this.acquireExecutionAssignment(request);
      if (timedOut || controller.signal.aborted) {
        throw new Error(timedOut ? "goal_timeout" : "goal_aborted");
      }
      const planResult = await this.options.goalPlanner!.planAndDispatch({
        requestId: request.payload.operationId,
        traceId: request.payload.operationId,
        taskId: request.payload.taskId,
        botId: request.payload.botId,
        operatorGoal: request.payload.operatorGoal,
        timeoutMs: request.payload.timeoutMs,
        assignmentLeaseOwner: lease.leaseOwner,
        signal: controller.signal,
      });
      if (timedOut || controller.signal.aborted) {
        throw new Error("goal_timeout");
      }
      const result = projectGoalDispatchResult(request.payload, planResult);
      const terminal = await this.options.goalStore!.recordResult(lease, result);
      this.applyGoalSnapshots([terminal], validNow(this.now()));
      this.rememberCompletedGoal(request.payload.operationId, {
        fingerprint: terminal.fingerprint,
        result,
        expiresAtMs: validNow(this.now()).getTime() + COMPLETED_GOAL_TTL_MS,
      });
      if (!this.stopped) {
        for (const responder of pending.responders.values()) {
          this.sendGoalSuccess(responder, request, result);
        }
      }
      safeLog(this.options.logger, "info", "coordinator_control_link_goal_result", {
        traceId: request.payload.operationId,
        taskId: request.payload.taskId,
        botId: request.payload.botId,
        clientId: request.payload.clientId,
        action: result.action,
      });
    } catch (cause) {
      let errorCode = mapGoalExecutionError(
        cause,
        timedOut,
        controller.signal.aborted,
      );
      let terminalPersisted = false;
      const status = errorCode === "AI_TIMEOUT"
        ? "expired"
        : controller.signal.aborted
          ? "cancelled"
          : "failed";
      try {
        const terminal = await this.options.goalStore!.recordError(
          lease,
          errorCode,
          status,
        );
        this.applyGoalSnapshots([terminal], validNow(this.now()));
        terminalPersisted = true;
      } catch (persistenceCause) {
        errorCode = "CONTROL_LINK_INTERNAL_ERROR";
        safeLog(
          this.options.logger,
          "error",
          "coordinator_control_link_goal_persistence_failed",
          {
            traceId: request.payload.operationId,
            taskId: request.payload.taskId,
            botId: request.payload.botId,
            code:
              persistenceCause instanceof GoalLifecycleStoreError
                ? persistenceCause.code
                : "CONTROL_LINK_INTERNAL_ERROR",
          },
        );
      }
      if (terminalPersisted) {
        this.rememberCompletedGoal(request.payload.operationId, {
          fingerprint: pending.fingerprint,
          result: null,
          errorCode,
          expiresAtMs: validNow(this.now()).getTime() + COMPLETED_GOAL_TTL_MS,
        });
      }
      if (!this.stopped) {
        for (const responder of pending.responders.values()) {
          this.sendGoalFailure(
            responder.session,
            request,
            errorCode,
            responder.requestMessageId,
          );
        }
      }
      safeLog(this.options.logger, "warn", "coordinator_control_link_goal_failed", {
        traceId: request.payload.operationId,
        taskId: request.payload.taskId,
        botId: request.payload.botId,
        clientId: request.payload.clientId,
        code: errorCode,
        // `code` is the coarse code the client is entitled to see; several
        // distinct planner outcomes collapse into PLANNER_REJECTED. The
        // originating code stays log-only so triage does not start by
        // guessing which one it was.
        ...plannerDiagnostics(cause),
      });
    } finally {
      this.releaseExecutionAssignment(assignmentLeaseId);
      clearTimeout(timer);
      this.unparkOperation(request.payload.operationId);
      if (this.pendingGoals.get(request.payload.operationId) === pending) {
        this.pendingGoals.delete(request.payload.operationId);
      }
    }
  }

  /**
   * Round 6.6 停车场：goal 持 store lease 等待 bot 就绪。提交方立即收到
   * waiting_for_bot（含死线）；就绪翻沿逐个唤醒（FIFO，同一 bot 串行）。
   */
  private parkWaitingGoal(pending: PendingGoal, lease: GoalExecutionLease): void {
    const botId = pending.request.payload.botId;
    const queue = this.waitingGoals.get(botId) ?? [];
    if (queue.length >= WAITING_GOALS_PER_BOT_MAX) {
      safeLog(this.options.logger, "warn", "coordinator_goal_waiting_backpressure", {
        botId,
        queued: queue.length,
      });
      void this.expireParkedGoal(botId, pending.request.payload.operationId, {
        cause: "backpressure",
        lease,
      });
      return;
    }
    const deadlineMs = validNow(this.now()).getTime() + pending.request.payload.timeoutMs;
    const entry: WaitingGoalEntry = {
      pending,
      lease,
      deadlineMs,
      deadlineTimer: setTimeout(() => {
        void this.expireParkedGoal(botId, pending.request.payload.operationId, {
          cause: "deadline",
        });
      }, pending.request.payload.timeoutMs),
    };
    queue.push(entry);
    this.waitingGoals.set(botId, queue);
    this.parkedOperationIds.add(pending.request.payload.operationId);
    for (const responder of pending.responders.values()) {
      this.sendGoalWaiting(responder, pending.request, deadlineMs);
    }
    safeLog(this.options.logger, "info", "coordinator_goal_waiting_for_bot", {
      traceId: pending.request.payload.operationId,
      taskId: pending.request.payload.taskId,
      botId,
      position: queue.length,
      expiresAtMs: deadlineMs,
    });
  }

  /** 就绪翻沿驱动的唤醒（FIFO；唤醒后由 per-bot assignment 保证串行）。 */
  private resumeWaitingGoals(botId: string): void {
    if (this.stopped) return;
    const queue = this.waitingGoals.get(botId);
    if (queue === undefined || queue.length === 0) return;
    const entry = queue.shift()!;
    if (queue.length === 0) this.waitingGoals.delete(botId);
    clearTimeout(entry.deadlineTimer);
    const remainingMs = Math.max(
      1_000,
      Math.min(entry.deadlineMs - validNow(this.now()).getTime(), entry.pending.request.payload.timeoutMs),
    );
    const controller = entry.pending.controller;
    const timer = setTimeout(() => {
      controller.abort(new Error("goal_timeout"));
    }, remainingMs);
    safeLog(this.options.logger, "info", "coordinator_goal_waiting_resumed", {
      traceId: entry.pending.request.payload.operationId,
      botId,
      remainingMs,
    });
    entry.pending.execution = this.executeAcquiredGoal(entry.pending, entry.lease, timer);
    void entry.pending.execution.finally(() => {
      // 链式恢复：当前 goal 终态后若 bot 仍就绪，唤醒该 bot 下一个停车 goal。
      if (!this.stopped && this.options.registry.goalExecutionReady(botId)) {
        this.resumeWaitingGoals(botId);
      }
    }).catch(() => undefined);
  }

  /** 停车 goal 的诚实终态：死线到期或队列溢出。 */
  private async expireParkedGoal(
    botId: string,
    operationId: string,
    detail: { cause: "deadline" | "backpressure"; lease?: GoalExecutionLease },
  ): Promise<void> {
    const queue = this.waitingGoals.get(botId);
    let entry: WaitingGoalEntry | undefined;
    if (queue !== undefined) {
      const index = queue.findIndex((candidate) => candidate.pending.request.payload.operationId === operationId);
      if (index >= 0) {
        entry = queue.splice(index, 1)[0];
        if (queue.length === 0) this.waitingGoals.delete(botId);
      }
    }
    const pending = entry?.pending ?? this.pendingGoals.get(operationId);
    const lease = entry?.lease ?? detail.lease ?? null;
    if (entry !== undefined) clearTimeout(entry.deadlineTimer);
    const errorCode: ControlLinkGoalErrorCode =
      detail.cause === "backpressure" ? "CONTROL_LINK_BACKPRESSURE" : "GOAL_EXPIRED_WAITING_FOR_BOT";
    if (lease !== null) {
      try {
        const terminal = await this.options.goalStore!.recordError(lease, errorCode, "failed");
        this.applyGoalSnapshots([terminal], validNow(this.now()));
      } catch {
        // 持久化失败也要把终态回给提交方；store 恢复路径会过期残留 task。
      }
    }
    if (pending !== undefined) {
      this.rememberCompletedGoal(operationId, {
        fingerprint: pending.fingerprint,
        result: null,
        errorCode,
        expiresAtMs: validNow(this.now()).getTime() + COMPLETED_GOAL_TTL_MS,
      });
      if (!this.stopped) {
        for (const responder of pending.responders.values()) {
          this.sendGoalFailure(
            responder.session,
            pending.request,
            errorCode,
            responder.requestMessageId,
          );
        }
      }
    }
    this.unparkOperation(operationId);
    if (this.pendingGoals.get(operationId) === pending) {
      this.pendingGoals.delete(operationId);
    }
    safeLog(this.options.logger, "warn", "coordinator_goal_waiting_expired", {
      traceId: operationId,
      botId,
      cause: detail.cause,
      code: errorCode,
    });
  }

  private unparkOperation(operationId: string): void {
    this.parkedOperationIds.delete(operationId);
  }

  /** 提交方收到的 waiting 回执（HTTP 层映射 202，不是 409 拒绝）。 */
  private sendGoalWaiting(
    responder: GoalResponder,
    request: ControlLinkGoalRequestV1,
    expiresAtMs: number,
  ): void {
    if (responder.session.closing) return;
    let response: ReturnType<typeof controlLinkGoalResponseV1Schema.parse>;
    try {
      response = controlLinkGoalResponseV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.goal-response.v1",
        ok: true,
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          requestMessageId: responder.requestMessageId,
          operationId: request.payload.operationId,
          taskId: request.payload.taskId,
          botId: request.payload.botId,
          result: {
            action: "waiting_for_bot",
            botId: request.payload.botId,
            taskId: request.payload.taskId,
            reasonCode: "GOAL_WAITING_FOR_BOT",
            expiresAtMs,
          },
        },
      });
    } catch {
      this.closeSession(responder.session, 1011, "goal_response_invalid");
      return;
    }
    this.sendFrame(responder.session.socket, response, (error) => {
      if (error) this.closeSession(responder.session, 1013, "goal_response_failed");
    });
  }

  private async executeQueuedGoal(pending: PendingGoal): Promise<void> {
    const request = pending.request;
    const controller = pending.controller;
    let submitted = false;
    let assignmentLeaseId: string | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("goal_timeout"));
    }, request.payload.timeoutMs);
    try {
      assignmentLeaseId = await this.acquireExecutionAssignment(request);
      const queued = await this.options.queuedGoalStore!.submitQueued(request);
      submitted = true;
      this.applyGoalSnapshots([queued], validNow(this.now()));
      const terminal = await this.options.queuedGoalStore!.waitForQueuedTerminal(
        request.payload.taskId,
        controller.signal,
      );
      this.applyGoalSnapshots([terminal], validNow(this.now()));
      if (terminal.result !== null) {
        this.rememberCompletedGoal(request.payload.operationId, {
          fingerprint: terminal.fingerprint,
          result: terminal.result,
          expiresAtMs: validNow(this.now()).getTime() + COMPLETED_GOAL_TTL_MS,
        });
        if (!this.stopped) {
          for (const responder of pending.responders.values()) {
            this.sendGoalSuccess(responder, request, terminal.result);
          }
        }
        return;
      }

      const errorCode =
        terminal.errorCode ?? "CONTROL_LINK_INTERNAL_ERROR";
      this.rememberCompletedGoal(request.payload.operationId, {
        fingerprint: terminal.fingerprint,
        result: null,
        errorCode,
        expiresAtMs: validNow(this.now()).getTime() + COMPLETED_GOAL_TTL_MS,
      });
      if (!this.stopped) {
        for (const responder of pending.responders.values()) {
          this.sendGoalFailure(
            responder.session,
            request,
            errorCode,
            responder.requestMessageId,
          );
        }
      }
    } catch (cause) {
      const errorCode = mapGoalExecutionError(
        cause,
        timedOut,
        controller.signal.aborted,
      );
      if (submitted) {
        await this.options.queuedGoalStore!
          .requestQueuedCancellation(
            request.payload.taskId,
            timedOut ? "AI_TIMEOUT" : "CONTROL_LINK_STOPPED",
          )
          .catch((cancellationCause: unknown) => {
            safeLog(
              this.options.logger,
              "error",
              "coordinator_queued_goal_cancellation_failed",
              {
                traceId: request.payload.operationId,
                taskId: request.payload.taskId,
                code:
                  cancellationCause instanceof GoalLifecycleStoreError
                    ? cancellationCause.code
                    : "CONTROL_LINK_INTERNAL_ERROR",
              },
            );
          });
      }
      if (!this.stopped) {
        for (const responder of pending.responders.values()) {
          this.sendGoalFailure(
            responder.session,
            request,
            errorCode,
            responder.requestMessageId,
          );
        }
      }
      safeLog(this.options.logger, "warn", "coordinator_queued_goal_failed", {
        traceId: request.payload.operationId,
        taskId: request.payload.taskId,
        botId: request.payload.botId,
        code: errorCode,
      });
    } finally {
      this.releaseExecutionAssignment(assignmentLeaseId);
      clearTimeout(timer);
      if (this.pendingGoals.get(request.payload.operationId) === pending) {
        this.pendingGoals.delete(request.payload.operationId);
      }
    }
  }

  private async acquireExecutionAssignment(
    request: ControlLinkGoalRequestV1,
  ): Promise<string | null> {
    const assignment = this.options.assignment;
    if (!assignment) return null;
    await this.options.autonomousTaskSource?.requestManualControl?.(
      request.payload.botId,
    );
    const record = this.options.registry.get(
      request.payload.botId,
      validNow(this.now()),
    );
    if (
      !record ||
      record.connectionState !== "online" ||
      record.currentStatus === null
    ) {
      throw new LocalPlannerError(
        "PLANNER_BOT_UNAVAILABLE",
        "Target Bot is not currently available for a normal task.",
      );
    }
    try {
      return assignment.acquire({
        taskId: request.payload.taskId,
        serverProfileId: record.serverProfileId,
        dimension: record.currentStatus.position.dimension,
        requiredSkills: [],
        preferredBotId: request.payload.botId,
        leaseTtlMs: request.payload.timeoutMs,
      }).leaseId;
    } catch (cause) {
      if (cause instanceof BotAssignmentError) {
        throw new LocalPlannerError(
          cause.code === "ASSIGNMENT_PREFERRED_BOT_BUSY"
            ? "PLANNER_BOT_BUSY"
            : "PLANNER_BOT_UNAVAILABLE",
          "Target Bot could not obtain an exclusive task assignment.",
          { cause },
        );
      }
      throw cause;
    }
  }

  private releaseExecutionAssignment(leaseId: string | null): void {
    if (!leaseId || !this.options.assignment) return;
    try {
      this.options.assignment.release(leaseId);
    } catch {
      safeLog(
        this.options.logger,
        "warn",
        "coordinator_assignment_release_failed",
        { leaseId, code: "ASSIGNMENT_RELEASE_FAILED" },
      );
    }
  }

  private rememberCompletedGoal(operationId: string, completed: CompletedGoal): void {
    this.completedGoals.delete(operationId);
    this.completedGoals.set(operationId, completed);
    while (this.completedGoals.size > MAX_COMPLETED_GOALS) {
      const oldest = this.completedGoals.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completedGoals.delete(oldest);
    }
  }

  private pruneCompletedGoals(nowMs: number): void {
    for (const [operationId, completed] of this.completedGoals) {
      if (completed.expiresAtMs <= nowMs) this.completedGoals.delete(operationId);
    }
  }

  private applyGoalSnapshots(
    snapshots: readonly GoalLifecycleSnapshot[],
    now: Date,
  ): void {
    const nowMs = now.getTime();
    for (const state of snapshots) {
      const active = goalTaskActive(state.status);
      const expiresAtMs = active
        ? null
        : Date.parse(state.updatedAt) + COMPLETED_GOAL_TTL_MS;
      if (expiresAtMs !== null && expiresAtMs <= nowMs) {
        this.trackedGoals.delete(state.operationId);
        continue;
      }
      const existing = this.trackedGoals.get(state.operationId);
      const runtimeTask = this.options.registry.get(state.botId, now)
        ?.currentStatus?.currentTask ?? null;
      if (!existing) this.trackedGoalOrder += 1;
      const tracked: TrackedGoalTask = {
        operationId: state.operationId,
        taskId: state.taskId,
        botId: state.botId,
        title: state.title,
        status: state.status,
        startedAt: state.startedAt,
        order: existing?.order ?? this.trackedGoalOrder,
        expiresAtMs,
        baselineRuntimeTask:
          existing?.baselineRuntimeTask ??
          (runtimeTask
            ? { taskId: runtimeTask.taskId, startedAt: runtimeTask.startedAt }
            : null),
      };
      this.trackedGoals.set(state.operationId, tracked);
      if (!active && (state.result !== null || state.errorCode !== null)) {
        this.rememberCompletedGoal(state.operationId, {
          fingerprint: state.fingerprint,
          ...(state.result !== null
            ? { result: state.result }
            : {
                result: null,
                errorCode: state.errorCode ?? "CONTROL_LINK_INTERNAL_ERROR",
              }),
          expiresAtMs: expiresAtMs ?? nowMs + COMPLETED_GOAL_TTL_MS,
        });
      }
      if (
        !existing ||
        existing.status !== tracked.status ||
        existing.startedAt !== tracked.startedAt ||
        existing.title !== tracked.title
      ) {
        this.publishBotTaskState(state.botId, now);
      }
    }
    this.trimTrackedGoals();
  }

  private refreshPersistedGoals(): Promise<void> {
    if (!this.options.goalStore) return Promise.resolve();
    if (this.goalRefreshInFlight) return this.goalRefreshInFlight;
    const refresh = this.options.goalStore
      .refresh(COMPLETED_GOAL_TTL_MS)
      .then((snapshots) => {
        this.applyGoalSnapshots(snapshots, validNow(this.now()));
        this.removeMissingGoalSnapshots(snapshots, validNow(this.now()));
      })
      .catch((error: unknown) => {
        safeLog(
          this.options.logger,
          "error",
          "coordinator_control_link_goal_recovery_failed",
          {
            code:
              error instanceof GoalLifecycleStoreError
                ? error.code
                : "CONTROL_LINK_INTERNAL_ERROR",
          },
        );
      })
      .finally(() => {
        if (this.goalRefreshInFlight === refresh) {
          this.goalRefreshInFlight = null;
        }
      });
    this.goalRefreshInFlight = refresh;
    return refresh;
  }

  private removeMissingGoalSnapshots(
    snapshots: readonly GoalLifecycleSnapshot[],
    now: Date,
  ): void {
    const persisted = new Set(snapshots.map(({ operationId }) => operationId));
    for (const [operationId, tracked] of this.trackedGoals) {
      if (persisted.has(operationId) || this.pendingGoals.has(operationId)) {
        continue;
      }
      this.trackedGoals.delete(operationId);
      this.publishBotTaskState(tracked.botId, now);
    }
  }

  private publishBotTaskState(botId: string, now: Date): void {
    const record = this.options.registry.get(botId, now);
    if (record) this.publishRecord(record);
  }

  private projectBotState(record: BotRegistryRecord): PublicBotDetailV1 {
    const tracked = this.currentTrackedGoal(record.botId);
    const runtimeTask = record.currentStatus?.currentTask ?? null;
    const runtimeTaskReplacedBaseline =
      tracked !== null &&
      runtimeTask !== null &&
      runtimeTask.taskId !== tracked.taskId &&
      (tracked.baselineRuntimeTask?.taskId !== runtimeTask.taskId ||
        tracked.baselineRuntimeTask?.startedAt !== runtimeTask.startedAt);
    const trackedTask = tracked &&
      !(!goalTaskActive(tracked.status) && runtimeTaskReplacedBaseline)
      ? {
          taskId: tracked.taskId,
          title:
            runtimeTask?.taskId === tracked.taskId
              ? runtimeTask.title
              : tracked.title,
          status: tracked.status,
          startedAt: tracked.startedAt,
        }
      : null;
    let autonomousTask: PublicCurrentTask | null = null;
    try {
      autonomousTask =
        this.options.autonomousTaskSource?.getCurrentTask(
          record.botId,
          validNow(this.now()),
        ) ?? null;
    } catch {
      autonomousTask = null;
    }
    const currentTask = selectCurrentTask(
      trackedTask,
      autonomousTask,
      runtimeTask,
    );
    return projectBotState(record, currentTask);
  }

  private currentTrackedGoal(botId: string): TrackedGoalTask | null {
    let selected: TrackedGoalTask | null = null;
    for (const tracked of this.trackedGoals.values()) {
      if (tracked.botId !== botId) continue;
      if (!selected) {
        selected = tracked;
        continue;
      }
      const trackedActive = goalTaskActive(tracked.status);
      const selectedActive = goalTaskActive(selected.status);
      if (
        (trackedActive && !selectedActive) ||
        (trackedActive === selectedActive && tracked.order > selected.order)
      ) {
        selected = tracked;
      }
    }
    return selected;
  }

  private pruneTrackedGoals(nowMs: number): void {
    for (const [operationId, tracked] of this.trackedGoals) {
      if (tracked.expiresAtMs !== null && tracked.expiresAtMs <= nowMs) {
        this.trackedGoals.delete(operationId);
      }
    }
  }

  private trimTrackedGoals(): void {
    while (this.trackedGoals.size > MAX_TRACKED_GOALS) {
      const oldestTerminal = [...this.trackedGoals.entries()].find(
        ([, tracked]) => !goalTaskActive(tracked.status),
      )?.[0];
      if (!oldestTerminal) break;
      this.trackedGoals.delete(oldestTerminal);
    }
  }

  private sendGoalSuccess(
    responder: GoalResponder,
    request: ControlLinkGoalRequestV1,
    result: GoalDispatchResultV1,
  ): void {
    if (responder.session.closing) return;
    let response: ReturnType<typeof controlLinkGoalResponseV1Schema.parse>;
    try {
      response = controlLinkGoalResponseV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.goal-response.v1",
        ok: true,
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          requestMessageId: responder.requestMessageId,
          operationId: request.payload.operationId,
          taskId: request.payload.taskId,
          botId: request.payload.botId,
          result,
        },
      });
    } catch {
      this.closeSession(responder.session, 1011, "goal_response_invalid");
      return;
    }
    this.sendFrame(responder.session.socket, response, (error) => {
      if (error) this.closeSession(responder.session, 1013, "goal_response_failed");
    });
  }

  private sendGoalFailure(
    session: ControlSession,
    request: ControlLinkGoalRequestV1,
    errorCode: ControlLinkGoalErrorCode,
    requestMessageId = request.messageId,
  ): void {
    if (session.closing) return;
    let response: ReturnType<typeof controlLinkGoalResponseV1Schema.parse>;
    try {
      response = controlLinkGoalResponseV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now()).toISOString(),
        type: "control.link.goal-response.v1",
        ok: false,
        payload: {
          coordinatorInstanceId: this.options.instanceId,
          requestMessageId,
          operationId: request.payload.operationId,
          taskId: request.payload.taskId,
          botId: request.payload.botId,
          errorCode,
        },
      });
    } catch {
      this.closeSession(session, 1011, "goal_response_invalid");
      return;
    }
    this.sendFrame(session.socket, response, (error) => {
      if (error) this.closeSession(session, 1013, "goal_response_failed");
    });
  }

  private matchesSession(
    session: ControlSession,
    request:
      | ControlLinkStopRequestV1
      | ControlLinkGoalRequestV1
      | ControlLinkTaskListRequestV1
      | ControlLinkTaskDetailRequestV1,
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
    for (const pending of this.pendingGoals.values()) {
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
}

function taskReadErrorCode(error: unknown): ControlLinkTaskReadErrorCode {
  return error instanceof TaskHistoryReaderError
    ? error.code
    : "CONTROL_LINK_INTERNAL_ERROR";
}

function projectBotState(
  record: BotRegistryRecord,
  currentTask: PublicCurrentTask | null = record.currentStatus?.currentTask ?? null,
): PublicBotDetailV1 {
  const status = record.currentStatus;
  // Combat telemetry is connection-scoped. The registry intentionally keeps
  // the last status for diagnostics, but Dashboard must not present that old
  // stance/target after the runtime is stale, offline, or replaced.
  const liveCombat =
    record.connectionState === "online" &&
    status !== null &&
    status.connectionState === "online" &&
    status.runtimeInstanceId === record.runtimeInstanceId
      ? status.combat ?? null
      : null;
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
    currentTask,
    position: status?.position ?? null,
    positionRedacted: false,
    minecraftVersion: record.minecraftVersion,
    safety: status?.safety ?? null,
    combat: liveCombat,
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

function withinClockSkew(value: string, now: Date): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    Math.abs(timestamp - now.getTime()) <= MAX_CLOCK_SKEW_MS
  );
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

/**
 * Log-only detail about why a goal failed.  The planner's own code and the
 * failing step index never reach the client, because the coarse code is the
 * contract; they exist so triage starts from the real cause instead of from
 * a mapped one.
 */
function plannerDiagnostics(
  cause: unknown,
): Readonly<Record<string, unknown>> {
  if (cause instanceof LocalPlannerError) {
    return {
      plannerCode: cause.code,
      ...(cause.stepIndex === undefined
        ? {}
        : { plannerStepIndex: cause.stepIndex }),
      ...(cause.stepSkillId === undefined
        ? {}
        : { plannerStepSkillId: cause.stepSkillId }),
    };
  }
  return { plannerCode: null };
}

function goalTaskStatus(
  result: GoalDispatchResultV1,
): PublicCurrentTask["status"] {
  if (result.action === "noop") return "failed";
  if (result.outcome === "completed") return "completed";
  if (result.outcome === "cancelled") return "cancelled";
  if (result.outcome === "timed_out") return "expired";
  return "failed";
}

function goalFingerprint(request: ControlLinkGoalRequestV1): string {
  return durableGoalFingerprint(request);
}

function goalTaskActive(status: PublicCurrentTask["status"]): boolean {
  return (
    status === "queued" ||
    status === "assigned" ||
    status === "running" ||
    status === "blocked" ||
    status === "waiting" ||
    status === "paused"
  );
}

function selectCurrentTask(
  ...candidates: readonly (PublicCurrentTask | null)[]
): PublicCurrentTask | null {
  return (
    candidates.find(
      (candidate) => candidate !== null && goalTaskActive(candidate.status),
    ) ??
    candidates.find((candidate) => candidate !== null) ??
    null
  );
}

function stopFingerprint(request: ControlLinkStopRequestV1): string {
  return JSON.stringify({
    coordinatorInstanceId: request.payload.coordinatorInstanceId,
    clientId: request.payload.clientId,
    controlApiInstanceId: request.payload.controlApiInstanceId,
    operationId: request.payload.operationId,
    botId: request.payload.botId,
    actorId: request.payload.actorId,
  });
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
