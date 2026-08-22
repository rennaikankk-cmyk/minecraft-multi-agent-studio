import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  CoordinatorStopError,
  type StopBotRequest,
} from "@minecraft-studio/coordinator";
import {
  CONTROL_LINK_MAX_PAYLOAD_BYTES,
  CONTROL_LINK_SUBPROTOCOL,
  controlLinkAuthenticateV1Schema,
  controlLinkClientProofInput,
  controlLinkGoalRequestV1Schema,
  controlLinkServerProofInput,
  controlLinkStopRequestV1Schema,
  controlLinkTaskDetailRequestV1Schema,
  controlLinkTaskListRequestV1Schema,
  parseControlLinkServerMessage,
  type BotStopResultV1,
  type ControlLinkAcceptedV1,
  type ControlLinkChallengeV1,
  type ControlLinkGoalErrorCode,
  type ControlLinkGoalRequestV1,
  type ControlLinkGoalResponseV1,
  type ControlLinkSnapshotBeginV1,
  type ControlLinkSnapshotEndV1,
  type ControlLinkSnapshotItemV1,
  type ControlLinkStateUpsertV1,
  type ControlLinkStopRequestV1,
  type ControlLinkStopResponseV1,
  type ControlLinkStopErrorCode,
  type ControlLinkTaskDetailRequestV1,
  type ControlLinkTaskDetailResponseV1,
  type ControlLinkTaskListRequestV1,
  type ControlLinkTaskListResponseV1,
  type ControlLinkTaskReadErrorCode,
  type GoalDispatchResultV1,
  type PublicBotDetailV1,
  type TaskHistoryListPageV1,
} from "@minecraft-studio/protocol";
import WebSocket, { type RawData } from "ws";

import type {
  BotStateAvailabilityListener,
  BotStateListener,
  BotStateSource,
  BotStopRequester,
} from "./bot-state-source.js";
import type { CoordinatorLinkClientConfig } from "./coordinator-link-config.js";
import {
  TaskHistorySourceError,
  type TaskHistoryDetailRequest,
  type TaskHistoryDetailResult,
  type TaskHistoryListRequest,
  type TaskHistorySource,
} from "./task-history-source.js";
import type {
  ControlApiLogger,
  GoalSubmitter,
  SubmitGoalRequest,
} from "./server.js";

const MAX_CLOCK_SKEW_MS = 30_000;
const RETIRED_STOP_TTL_MS = 5 * 60_000;
const MAX_RETIRED_STOPS = 512;
const TASK_READ_TIMEOUT_MS = 5_000;
const MAX_PENDING_TASK_READS = 128;

export type CoordinatorLinkClientErrorCode =
  | "COORDINATOR_LINK_ALREADY_STARTED"
  | "COORDINATOR_LINK_CLOSED"
  | "COORDINATOR_LINK_UNAVAILABLE"
  | "COORDINATOR_LINK_AUTH_FAILED"
  | "COORDINATOR_LINK_PROTOCOL_INVALID"
  | "COORDINATOR_LINK_IDENTITY_MISMATCH"
  | "COORDINATOR_LINK_IDENTITY_CHANGED"
  | "COORDINATOR_LINK_BACKPRESSURE"
  | "COORDINATOR_LINK_STOP_TIMEOUT";

export class CoordinatorLinkClientError extends Error {
  constructor(
    readonly code: CoordinatorLinkClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CoordinatorLinkClientError";
  }
}

export class CoordinatorGoalError extends Error {
  constructor(
    readonly code: ControlLinkGoalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CoordinatorGoalError";
  }
}

export type CoordinatorLinkClientOptions = Readonly<{
  config: CoordinatorLinkClientConfig;
  instanceId: string;
  logger: ControlApiLogger;
  now?: () => Date;
  randomId?: () => string;
  randomNonce?: () => string;
  random?: () => number;
}>;

type Handshake = {
  challenge: ControlLinkChallengeV1;
  authenticate: ReturnType<typeof controlLinkAuthenticateV1Schema.parse>;
  clientNonce: string;
};

type SnapshotAssembly = {
  snapshotId: string;
  baseSequence: number;
  botCount: number;
  botsByIndex: Map<number, PublicBotDetailV1>;
  botIds: Set<string>;
};

type PendingStop = {
  fingerprint: string;
  message: ControlLinkStopRequestV1;
  serialized: string;
  sent: boolean;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<BotStopResultV1>;
  resolve: (result: BotStopResultV1) => void;
  reject: (error: Error) => void;
};

type RetiredStop = Readonly<{
  operationId: string;
  requestMessageId: string;
  botId: string;
  expiresAtMs: number;
}>;

type PendingGoal = {
  fingerprint: string;
  message: ControlLinkGoalRequestV1;
  serialized: string;
  sent: boolean;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<GoalDispatchResultV1>;
  resolve: (result: GoalDispatchResultV1) => void;
  reject: (error: Error) => void;
};

type PendingTaskList = {
  fingerprint: string;
  message: ControlLinkTaskListRequestV1;
  serialized: string;
  sent: boolean;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<TaskHistoryListPageV1>;
  resolve: (result: TaskHistoryListPageV1) => void;
  reject: (error: Error) => void;
};

type PendingTaskDetail = {
  fingerprint: string;
  message: ControlLinkTaskDetailRequestV1;
  serialized: string;
  sent: boolean;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<TaskHistoryDetailResult>;
  resolve: (result: TaskHistoryDetailResult) => void;
  reject: (error: Error) => void;
};

export class CoordinatorLinkClient
  implements BotStateSource, BotStopRequester, GoalSubmitter, TaskHistorySource
{
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly randomNonce: () => string;
  private readonly random: () => number;
  private readonly hmacKey: Buffer;
  private readonly records = new Map<string, PublicBotDetailV1>();
  private readonly stateListeners = new Set<BotStateListener>();
  private readonly availabilityListeners =
    new Set<BotStateAvailabilityListener>();
  private readonly pendingStops = new Map<string, PendingStop>();
  private readonly pendingGoals = new Map<string, PendingGoal>();
  private readonly pendingTaskLists = new Map<string, PendingTaskList>();
  private readonly pendingTaskDetails = new Map<string, PendingTaskDetail>();
  private readonly retiredStops = new Map<string, RetiredStop>();
  private readonly failedSockets = new WeakSet<WebSocket>();
  private socket: WebSocket | null = null;
  private handshake: Handshake | null = null;
  private snapshot: SnapshotAssembly | null = null;
  private coordinatorInstanceId: string | null = null;
  private currentSequence = 0;
  private generation = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private authenticated = false;
  private ready = false;
  private closing = false;
  private permanentlyFailed = false;
  private firstReadyPromise: Promise<void> | null = null;
  private firstReadyResolve: (() => void) | null = null;
  private firstReadyReject: ((error: Error) => void) | null = null;

  constructor(private readonly options: CoordinatorLinkClientOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.randomNonce =
      options.randomNonce ?? (() => randomBytes(32).toString("base64url"));
    this.random = options.random ?? Math.random;
    this.hmacKey = createHash("sha256")
      .update(options.config.secret, "utf8")
      .digest();
  }

  start(): Promise<void> {
    if (this.started) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_ALREADY_STARTED",
        "Coordinator Link has already been started.",
      );
    }
    if (this.closing) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_CLOSED",
        "Coordinator Link has already been closed.",
      );
    }
    this.started = true;
    this.firstReadyPromise = new Promise<void>((resolve, reject) => {
      this.firstReadyResolve = resolve;
      this.firstReadyReject = reject;
    });
    this.connect();
    return this.firstReadyPromise;
  }

  isReady(): boolean {
    return this.ready;
  }

  isTaskHistoryReady(): boolean {
    return this.ready;
  }

  get(botId: string, _at: Date): PublicBotDetailV1 | null {
    this.assertReady();
    const bot = this.records.get(botId);
    return bot ? structuredClone(bot) : null;
  }

  list(_at: Date): PublicBotDetailV1[] {
    this.assertReady();
    return [...this.records.values()]
      .map((bot) => structuredClone(bot))
      .sort((left, right) => left.botId.localeCompare(right.botId));
  }

  subscribe(listener: BotStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  subscribeAvailability(listener: BotStateAvailabilityListener): () => void {
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  requestStop(request: StopBotRequest): Promise<BotStopResultV1> {
    validateStopRequest(request);
    const fingerprint = stopFingerprint(request);
    const existing = this.pendingStops.get(request.commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new CoordinatorStopError(
          "COMMAND_ID_CONFLICT",
          "The operation ID is already pending with different parameters.",
        );
      }
      return existing.promise;
    }
    if (!this.ready || !this.coordinatorInstanceId) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_UNAVAILABLE",
        "Coordinator Link has no complete authoritative snapshot.",
      );
    }
    if (this.pendingStops.size >= this.options.config.maxPendingStops) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_BACKPRESSURE",
        "Coordinator Link has reached its pending stop limit.",
      );
    }

    const now = validDate(this.now());
    const message = controlLinkStopRequestV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      timestamp: now.toISOString(),
      type: "control.link.stop-request.v1",
      payload: {
        coordinatorInstanceId: this.coordinatorInstanceId,
        clientId: this.options.config.clientId,
        controlApiInstanceId: this.options.instanceId,
        operationId: request.commandId,
        botId: request.botId,
        actorId: request.authorization.actorId,
        issuedAt: request.authorization.issuedAt.toISOString(),
        expiresAt: request.authorization.expiresAt.toISOString(),
      },
    });
    const serialized = JSON.stringify(message);
    let resolve!: (result: BotStopResultV1) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<BotStopResultV1>((resolveValue, rejectValue) => {
      resolve = resolveValue;
      reject = rejectValue;
    });
    const timer = setTimeout(() => {
      const pending = this.pendingStops.get(request.commandId);
      if (!pending || pending.message.messageId !== message.messageId) return;
      this.retireStop(pending);
      this.pendingStops.delete(request.commandId);
      pending.reject(
        new CoordinatorStopError(
          "STOP_TIMEOUT",
          "Coordinator Link did not return a stop result before the deadline.",
        ),
      );
    }, this.options.config.stopTimeoutMs);
    const pending: PendingStop = {
      fingerprint,
      message,
      serialized,
      sent: false,
      timer,
      promise,
      resolve,
      reject,
    };
    this.pendingStops.set(request.commandId, pending);
    this.sendPending(pending);
    return promise;
  }

  submitGoal(request: SubmitGoalRequest): Promise<GoalDispatchResultV1> {
    const fingerprint = goalFingerprint(request);
    const existing = this.pendingGoals.get(request.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new CoordinatorGoalError(
          "GOAL_ID_CONFLICT",
          "The goal operation ID is already pending with different parameters.",
        );
      }
      return existing.promise;
    }
    if (!this.ready || !this.coordinatorInstanceId) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_UNAVAILABLE",
        "Coordinator Link has no complete authoritative snapshot.",
      );
    }
    if (this.pendingGoals.size >= this.options.config.maxPendingStops) {
      throw new CoordinatorGoalError(
        "CONTROL_LINK_BACKPRESSURE",
        "Coordinator Link has reached its pending goal limit.",
      );
    }

    const now = validDate(this.now());
    const message = controlLinkGoalRequestV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      timestamp: now.toISOString(),
      type: "control.link.goal-request.v1",
      payload: {
        coordinatorInstanceId: this.coordinatorInstanceId,
        clientId: this.options.config.clientId,
        controlApiInstanceId: this.options.instanceId,
        operationId: request.operationId,
        taskId: request.taskId,
        botId: request.botId,
        actorId: request.actorId,
        operatorGoal: request.operatorGoal,
        timeoutMs: request.timeoutMs,
        issuedAt: request.issuedAt.toISOString(),
        expiresAt: request.expiresAt.toISOString(),
      },
    });
    let resolve!: (result: GoalDispatchResultV1) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<GoalDispatchResultV1>((resolveValue, rejectValue) => {
      resolve = resolveValue;
      reject = rejectValue;
    });
    const pending: PendingGoal = {
      fingerprint,
      message,
      serialized: JSON.stringify(message),
      sent: false,
      timer: setTimeout(() => {
        if (this.pendingGoals.get(request.operationId) !== pending) return;
        this.pendingGoals.delete(request.operationId);
        pending.reject(
          new CoordinatorGoalError(
            "AI_TIMEOUT",
            "Coordinator Link did not return a goal result before the deadline.",
          ),
        );
      }, request.timeoutMs + 5_000),
      promise,
      resolve,
      reject,
    };
    this.pendingGoals.set(request.operationId, pending);
    this.sendPendingGoal(pending);
    return promise;
  }

  listTaskHistory(
    request: TaskHistoryListRequest,
  ): Promise<TaskHistoryListPageV1> {
    const fingerprint = taskListFingerprint(request);
    const existing = this.pendingTaskLists.get(request.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new TaskHistorySourceError(
          "REQUEST_INVALID",
          "The task list operation ID is already pending with different parameters.",
        );
      }
      return existing.promise;
    }
    if (this.pendingTaskDetails.has(request.operationId)) {
      throw new TaskHistorySourceError(
        "REQUEST_INVALID",
        "The task read operation ID is already in use.",
      );
    }
    const coordinatorInstanceId = this.taskReadCoordinatorIdentity();
    this.assertTaskReadCapacity();
    const message = controlLinkTaskListRequestV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      timestamp: validDate(this.now()).toISOString(),
      type: "control.link.task-list-request.v1",
      payload: {
        coordinatorInstanceId,
        clientId: this.options.config.clientId,
        controlApiInstanceId: this.options.instanceId,
        operationId: request.operationId,
        actorId: request.actorId,
        query: request.query,
        issuedAt: validDate(request.issuedAt).toISOString(),
        expiresAt: validDate(request.expiresAt).toISOString(),
      },
    });
    let resolve!: (result: TaskHistoryListPageV1) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<TaskHistoryListPageV1>((resolveValue, rejectValue) => {
      resolve = resolveValue;
      reject = rejectValue;
    });
    const pending: PendingTaskList = {
      fingerprint,
      message,
      serialized: JSON.stringify(message),
      sent: false,
      timer: setTimeout(() => {
        if (this.pendingTaskLists.get(request.operationId) !== pending) return;
        this.pendingTaskLists.delete(request.operationId);
        pending.reject(taskHistoryUnavailable("Task list response timed out."));
      }, TASK_READ_TIMEOUT_MS),
      promise,
      resolve,
      reject,
    };
    this.pendingTaskLists.set(request.operationId, pending);
    this.sendPendingTaskRead(pending);
    return promise;
  }

  getTaskDetail(
    request: TaskHistoryDetailRequest,
  ): Promise<TaskHistoryDetailResult> {
    const fingerprint = taskDetailFingerprint(request);
    const existing = this.pendingTaskDetails.get(request.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new TaskHistorySourceError(
          "REQUEST_INVALID",
          "The task detail operation ID is already pending with different parameters.",
        );
      }
      return existing.promise;
    }
    if (this.pendingTaskLists.has(request.operationId)) {
      throw new TaskHistorySourceError(
        "REQUEST_INVALID",
        "The task read operation ID is already in use.",
      );
    }
    const coordinatorInstanceId = this.taskReadCoordinatorIdentity();
    this.assertTaskReadCapacity();
    const message = controlLinkTaskDetailRequestV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      timestamp: validDate(this.now()).toISOString(),
      type: "control.link.task-detail-request.v1",
      payload: {
        coordinatorInstanceId,
        clientId: this.options.config.clientId,
        controlApiInstanceId: this.options.instanceId,
        operationId: request.operationId,
        actorId: request.actorId,
        taskId: request.taskId,
        issuedAt: validDate(request.issuedAt).toISOString(),
        expiresAt: validDate(request.expiresAt).toISOString(),
      },
    });
    let resolve!: (result: TaskHistoryDetailResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<TaskHistoryDetailResult>((resolveValue, rejectValue) => {
      resolve = resolveValue;
      reject = rejectValue;
    });
    const pending: PendingTaskDetail = {
      fingerprint,
      message,
      serialized: JSON.stringify(message),
      sent: false,
      timer: setTimeout(() => {
        if (this.pendingTaskDetails.get(request.operationId) !== pending) return;
        this.pendingTaskDetails.delete(request.operationId);
        pending.reject(taskHistoryUnavailable("Task detail response timed out."));
      }, TASK_READ_TIMEOUT_MS),
      promise,
      resolve,
      reject,
    };
    this.pendingTaskDetails.set(request.operationId, pending);
    this.sendPendingTaskRead(pending);
    return promise;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.clearTimers();
    this.markUnavailable();
    const error = new CoordinatorLinkClientError(
      "COORDINATOR_LINK_CLOSED",
      "Coordinator Link closed before the operation completed.",
    );
    this.firstReadyReject?.(error);
    this.firstReadyResolve = null;
    this.firstReadyReject = null;
    this.rejectPendingStops(error);
    this.rejectPendingGoals(error);
    this.rejectPendingTaskReads(taskHistoryUnavailable("Coordinator Link closed."));
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await closeSocket(socket);
    }
  }

  private connect(): void {
    if (this.closing || this.permanentlyFailed) return;
    this.generation += 1;
    const generation = this.generation;
    this.authenticated = false;
    this.handshake = null;
    this.snapshot = null;
    this.coordinatorInstanceId = null;

    let socket: WebSocket;
    try {
      socket = new WebSocket(
        this.options.config.url,
        CONTROL_LINK_SUBPROTOCOL,
        {
          followRedirects: false,
          handshakeTimeout: this.options.config.handshakeTimeoutMs,
          maxPayload: CONTROL_LINK_MAX_PAYLOAD_BYTES,
          perMessageDeflate: false,
        },
      );
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.once("open", () => {
      if (!this.isCurrent(generation, socket)) return;
      if (socket.protocol !== CONTROL_LINK_SUBPROTOCOL) {
        this.failSocket(socket, "subprotocol_invalid", true);
        return;
      }
      this.startHandshakeTimer(socket);
      this.resetLivenessTimer(socket);
      this.log("info", "control_api_coordinator_link_socket_open", {});
    });
    socket.on("message", (data, isBinary) => {
      if (
        !this.isCurrent(generation, socket) ||
        this.failedSockets.has(socket)
      ) {
        return;
      }
      this.resetLivenessTimer(socket);
      this.handleFrame(socket, data, isBinary);
    });
    socket.on("ping", () => {
      if (
        !this.isCurrent(generation, socket) ||
        this.failedSockets.has(socket)
      ) {
        return;
      }
      this.resetLivenessTimer(socket);
    });
    socket.on("error", () => {
      if (
        !this.isCurrent(generation, socket) ||
        this.failedSockets.has(socket)
      ) {
        return;
      }
      this.log("warn", "control_api_coordinator_link_socket_error", {
        code: "COORDINATOR_LINK_TRANSPORT_ERROR",
      });
      this.failSocket(socket, "socket_error", false, true);
    });
    socket.once("close", (code) => {
      if (!this.isCurrent(generation, socket)) return;
      this.handleClosed(code);
    });
  }

  private handleFrame(
    socket: WebSocket,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (isBinary) {
      this.failSocket(socket, "binary_frame_rejected", true);
      return;
    }
    const buffer = rawDataBuffer(data);
    if (buffer.byteLength > CONTROL_LINK_MAX_PAYLOAD_BYTES) {
      this.failSocket(socket, "payload_too_large", true);
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(buffer.toString("utf8"));
    } catch {
      this.failSocket(socket, "json_invalid", true);
      return;
    }
    let message: ReturnType<typeof parseControlLinkServerMessage>;
    try {
      message = parseControlLinkServerMessage(input);
    } catch {
      this.failSocket(socket, "schema_invalid", true);
      return;
    }
    try {
      validateEnvelopeTime(message.timestamp, this.now());
    } catch {
      this.failSocket(socket, "timestamp_out_of_window", false);
      return;
    }

    try {
      switch (message.type) {
        case "control.link.challenge.v1":
          this.handleChallenge(socket, message);
          return;
        case "control.link.accepted.v1":
          this.handleAccepted(socket, message);
          return;
        case "control.link.snapshot-begin.v1":
          this.handleSnapshotBegin(message);
          return;
        case "control.link.snapshot-item.v1":
          this.handleSnapshotItem(message);
          return;
        case "control.link.snapshot-end.v1":
          this.handleSnapshotEnd(message);
          return;
        case "control.link.state-upsert.v1":
          this.handleUpsert(message);
          return;
        case "control.link.stop-response.v1":
          this.handleStopResponse(message);
          return;
        case "control.link.goal-response.v1":
          this.handleGoalResponse(message);
          return;
        case "control.link.task-list-response.v1":
          this.handleTaskListResponse(message);
          return;
        case "control.link.task-detail-response.v1":
          this.handleTaskDetailResponse(message);
          return;
      }
    } catch (cause) {
      const fatal =
        cause instanceof CoordinatorLinkClientError &&
        (cause.code === "COORDINATOR_LINK_AUTH_FAILED" ||
          cause.code === "COORDINATOR_LINK_IDENTITY_MISMATCH");
      this.failSocket(socket, "message_rejected", fatal);
    }
  }

  private handleChallenge(
    socket: WebSocket,
    challenge: ControlLinkChallengeV1,
  ): void {
    if (this.handshake || this.authenticated) {
      throw protocolError("Unexpected duplicate challenge.");
    }
    const clientNonce = this.randomNonce();
    const context = {
      challengeMessageId: challenge.messageId,
      coordinatorInstanceId: challenge.payload.coordinatorInstanceId,
      challengeNonce: challenge.payload.challengeNonce,
      clientNonce,
      clientId: this.options.config.clientId,
      controlApiInstanceId: this.options.instanceId,
      keyId: this.options.config.keyId,
    };
    const authenticate = controlLinkAuthenticateV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      timestamp: validDate(this.now()).toISOString(),
      type: "control.link.authenticate.v1",
      payload: {
        ...context,
        clientProof: this.sign(controlLinkClientProofInput(context)),
      },
    });
    this.handshake = { challenge, authenticate, clientNonce };
    this.sendSerialized(socket, JSON.stringify(authenticate));
  }

  private handleAccepted(
    socket: WebSocket,
    accepted: ControlLinkAcceptedV1,
  ): void {
    const handshake = this.handshake;
    if (!handshake || this.authenticated) {
      throw protocolError("Unexpected authentication acceptance.");
    }
    const context = {
      challengeMessageId: handshake.challenge.messageId,
      coordinatorInstanceId:
        handshake.challenge.payload.coordinatorInstanceId,
      challengeNonce: handshake.challenge.payload.challengeNonce,
      clientNonce: handshake.clientNonce,
      clientId: this.options.config.clientId,
      controlApiInstanceId: this.options.instanceId,
      keyId: this.options.config.keyId,
      authenticateMessageId: handshake.authenticate.messageId,
    };
    if (
      accepted.payload.challengeMessageId !== context.challengeMessageId ||
      accepted.payload.authenticateMessageId !== context.authenticateMessageId ||
      accepted.payload.coordinatorInstanceId !== context.coordinatorInstanceId ||
      accepted.payload.clientId !== context.clientId ||
      accepted.payload.controlApiInstanceId !== context.controlApiInstanceId ||
      accepted.payload.keyId !== context.keyId ||
      !this.verify(
        accepted.payload.serverProof,
        controlLinkServerProofInput(context),
      )
    ) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_AUTH_FAILED",
        "Coordinator Link mutual authentication failed.",
      );
    }
    this.rejectPendingForCoordinatorChange(context.coordinatorInstanceId);
    this.authenticated = true;
    this.coordinatorInstanceId = context.coordinatorInstanceId;
    this.handshake = null;
    this.startHandshakeTimer(socket);
    this.log("info", "control_api_coordinator_link_authenticated", {
      coordinatorInstanceId: context.coordinatorInstanceId,
      clientId: context.clientId,
    });
  }

  private handleSnapshotBegin(message: ControlLinkSnapshotBeginV1): void {
    this.assertAuthenticatedIdentity(message.payload.coordinatorInstanceId);
    if (this.snapshot || this.ready) {
      throw protocolError("Unexpected snapshot begin.");
    }
    this.snapshot = {
      snapshotId: message.payload.snapshotId,
      baseSequence: message.payload.baseSequence,
      botCount: message.payload.botCount,
      botsByIndex: new Map(),
      botIds: new Set(),
    };
  }

  private handleSnapshotItem(message: ControlLinkSnapshotItemV1): void {
    this.assertAuthenticatedIdentity(message.payload.coordinatorInstanceId);
    const snapshot = this.snapshot;
    if (
      !snapshot ||
      message.payload.snapshotId !== snapshot.snapshotId ||
      message.payload.baseSequence !== snapshot.baseSequence ||
      message.payload.index >= snapshot.botCount ||
      snapshot.botsByIndex.has(message.payload.index) ||
      snapshot.botIds.has(message.payload.bot.botId)
    ) {
      throw protocolError("Snapshot item identity or order is invalid.");
    }
    snapshot.botsByIndex.set(
      message.payload.index,
      structuredClone(message.payload.bot),
    );
    snapshot.botIds.add(message.payload.bot.botId);
  }

  private handleSnapshotEnd(message: ControlLinkSnapshotEndV1): void {
    this.assertAuthenticatedIdentity(message.payload.coordinatorInstanceId);
    const snapshot = this.snapshot;
    if (
      !snapshot ||
      message.payload.snapshotId !== snapshot.snapshotId ||
      message.payload.baseSequence !== snapshot.baseSequence ||
      message.payload.botCount !== snapshot.botCount ||
      snapshot.botsByIndex.size !== snapshot.botCount
    ) {
      throw protocolError("Snapshot did not complete atomically.");
    }
    const next = new Map<string, PublicBotDetailV1>();
    for (let index = 0; index < snapshot.botCount; index += 1) {
      const bot = snapshot.botsByIndex.get(index);
      if (!bot) throw protocolError("Snapshot item index is missing.");
      next.set(bot.botId, structuredClone(bot));
    }
    this.records.clear();
    for (const [botId, bot] of next) this.records.set(botId, bot);
    this.currentSequence = snapshot.baseSequence;
    this.snapshot = null;
    this.ready = true;
    this.reconnectAttempts = 0;
    this.clearHandshakeTimer();
    this.notifyAvailability(true);
    this.firstReadyResolve?.();
    this.firstReadyResolve = null;
    this.firstReadyReject = null;
    this.flushPending();
    this.log("info", "control_api_coordinator_link_ready", {
      coordinatorInstanceId: this.coordinatorInstanceId,
      botCount: this.records.size,
      streamSequence: this.currentSequence,
    });
  }

  private handleUpsert(message: ControlLinkStateUpsertV1): void {
    this.assertAuthenticatedIdentity(message.payload.coordinatorInstanceId);
    if (
      !this.ready ||
      this.snapshot ||
      message.payload.streamSequence !== this.currentSequence + 1
    ) {
      throw protocolError("Control Link state sequence is not contiguous.");
    }
    this.currentSequence = message.payload.streamSequence;
    const bot = structuredClone(message.payload.bot);
    this.records.set(bot.botId, bot);
    for (const listener of this.stateListeners) {
      try {
        listener(structuredClone(bot));
      } catch {
        // A local presentation listener cannot break the authenticated mirror.
      }
    }
  }

  private handleStopResponse(message: ControlLinkStopResponseV1): void {
    this.assertAuthenticatedIdentity(message.payload.coordinatorInstanceId);
    const pending = this.pendingStops.get(message.payload.operationId);
    if (!pending) return;
    if (
      message.payload.requestMessageId !== pending.message.messageId ||
      message.payload.botId !== pending.message.payload.botId
    ) {
      if (this.matchesRetiredStop(message)) return;
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_IDENTITY_MISMATCH",
        "Coordinator Link stop response identity does not match its request.",
      );
    }
    clearTimeout(pending.timer);
    this.pendingStops.delete(message.payload.operationId);
    if (message.ok) {
      pending.resolve(message.payload.result);
      return;
    }
    pending.reject(stopResponseError(message.payload.errorCode));
  }

  private handleGoalResponse(message: ControlLinkGoalResponseV1): void {
    this.assertAuthenticatedIdentity(message.payload.coordinatorInstanceId);
    const pending = this.pendingGoals.get(message.payload.operationId);
    if (!pending) return;
    if (
      message.payload.requestMessageId !== pending.message.messageId ||
      message.payload.botId !== pending.message.payload.botId ||
      message.payload.taskId !== pending.message.payload.taskId
    ) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_IDENTITY_MISMATCH",
        "Coordinator Link goal response identity does not match its request.",
      );
    }
    clearTimeout(pending.timer);
    this.pendingGoals.delete(message.payload.operationId);
    if (message.ok) {
      pending.resolve(message.payload.result);
      return;
    }
    pending.reject(
      new CoordinatorGoalError(
        message.payload.errorCode,
        "Coordinator rejected or could not execute the goal operation.",
      ),
    );
  }

  private handleTaskListResponse(message: ControlLinkTaskListResponseV1): void {
    this.assertAuthenticatedIdentity(message.payload.coordinatorInstanceId);
    const pending = this.pendingTaskLists.get(message.payload.operationId);
    if (!pending) return;
    if (message.payload.requestMessageId !== pending.message.messageId) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_IDENTITY_MISMATCH",
        "Coordinator Link task list response identity does not match its request.",
      );
    }
    clearTimeout(pending.timer);
    this.pendingTaskLists.delete(message.payload.operationId);
    if (message.ok) {
      pending.resolve(message.payload.result);
      return;
    }
    pending.reject(taskReadResponseError(message.payload.errorCode));
  }

  private handleTaskDetailResponse(message: ControlLinkTaskDetailResponseV1): void {
    this.assertAuthenticatedIdentity(message.payload.coordinatorInstanceId);
    const pending = this.pendingTaskDetails.get(message.payload.operationId);
    if (!pending) return;
    if (
      message.payload.requestMessageId !== pending.message.messageId ||
      (message.ok &&
        message.payload.result.task.taskId !== pending.message.payload.taskId)
    ) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_IDENTITY_MISMATCH",
        "Coordinator Link task detail response identity does not match its request.",
      );
    }
    clearTimeout(pending.timer);
    this.pendingTaskDetails.delete(message.payload.operationId);
    if (message.ok) {
      pending.resolve(message.payload.result);
      return;
    }
    pending.reject(taskReadResponseError(message.payload.errorCode));
  }

  private retireStop(pending: PendingStop): void {
    const nowMs = validDate(this.now()).getTime();
    this.pruneRetiredStops(nowMs);
    const requestMessageId = pending.message.messageId;
    this.retiredStops.delete(requestMessageId);
    this.retiredStops.set(requestMessageId, {
      operationId: pending.message.payload.operationId,
      requestMessageId,
      botId: pending.message.payload.botId,
      expiresAtMs: nowMs + RETIRED_STOP_TTL_MS,
    });
    while (this.retiredStops.size > MAX_RETIRED_STOPS) {
      const oldest = this.retiredStops.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.retiredStops.delete(oldest);
    }
  }

  private matchesRetiredStop(message: ControlLinkStopResponseV1): boolean {
    this.pruneRetiredStops(validDate(this.now()).getTime());
    const retired = this.retiredStops.get(message.payload.requestMessageId);
    return (
      retired?.operationId === message.payload.operationId &&
      retired.requestMessageId === message.payload.requestMessageId &&
      retired.botId === message.payload.botId
    );
  }

  private pruneRetiredStops(nowMs: number): void {
    for (const [requestMessageId, retired] of this.retiredStops) {
      if (retired.expiresAtMs <= nowMs) {
        this.retiredStops.delete(requestMessageId);
      }
    }
  }

  private handleClosed(code: number): void {
    this.socket = null;
    this.invalidateSession();
    if (this.closing || this.permanentlyFailed) return;
    if (code === 1008) {
      this.permanentFailure(
        new CoordinatorLinkClientError(
          "COORDINATOR_LINK_AUTH_FAILED",
          "Coordinator Link rejected authentication or protocol policy.",
        ),
      );
      return;
    }
    this.scheduleReconnect();
  }

  private sendPending(pending: PendingStop): void {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      this.sendSerialized(socket, pending.serialized);
      pending.sent = true;
    } catch {
      this.failedSockets.add(socket);
      this.invalidateSession();
      socket.close(1013, "backpressure");
    }
  }

  private sendPendingGoal(pending: PendingGoal): void {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      this.sendSerialized(socket, pending.serialized);
      pending.sent = true;
    } catch {
      this.failedSockets.add(socket);
      this.invalidateSession();
      socket.close(1013, "backpressure");
    }
  }

  private sendPendingTaskRead(
    pending: PendingTaskList | PendingTaskDetail,
  ): void {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      this.sendSerialized(socket, pending.serialized);
      pending.sent = true;
    } catch {
      this.failedSockets.add(socket);
      this.invalidateSession();
      socket.close(1013, "backpressure");
    }
  }

  private flushPending(): void {
    for (const pending of this.pendingStops.values()) {
      if (!pending.sent) this.sendPending(pending);
    }
    for (const pending of this.pendingGoals.values()) {
      if (!pending.sent) this.sendPendingGoal(pending);
    }
    for (const pending of this.pendingTaskLists.values()) {
      if (!pending.sent) this.sendPendingTaskRead(pending);
    }
    for (const pending of this.pendingTaskDetails.values()) {
      if (!pending.sent) this.sendPendingTaskRead(pending);
    }
  }

  private sendSerialized(socket: WebSocket, serialized: string): void {
    const bytes = Buffer.byteLength(serialized);
    if (
      bytes > CONTROL_LINK_MAX_PAYLOAD_BYTES ||
      socket.bufferedAmount + bytes >
        this.options.config.maxSocketBufferedBytes
    ) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_BACKPRESSURE",
        "Coordinator Link outbound buffer limit was reached.",
      );
    }
    socket.send(serialized);
  }

  private startHandshakeTimer(socket: WebSocket): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      if (
        this.socket === socket &&
        !this.ready &&
        !this.failedSockets.has(socket)
      ) {
        this.failSocket(socket, "handshake_timeout", false);
      }
    }, this.options.config.handshakeTimeoutMs);
  }

  private resetLivenessTimer(socket: WebSocket): void {
    this.clearLivenessTimer();
    this.livenessTimer = setTimeout(() => {
      if (this.socket !== socket || this.failedSockets.has(socket)) return;
      this.log("warn", "control_api_coordinator_link_liveness_timeout", {
        code: "COORDINATOR_LINK_UNAVAILABLE",
      });
      this.failedSockets.add(socket);
      this.invalidateSession();
      socket.terminate();
    }, this.options.config.livenessTimeoutMs);
  }

  private scheduleReconnect(): void {
    if (this.closing || this.permanentlyFailed || this.reconnectTimer) return;
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts += 1;
    const exponential = Math.min(
      this.options.config.reconnect.maxDelayMs,
      this.options.config.reconnect.baseDelayMs * 2 ** Math.min(attempt, 16),
    );
    const delay = Math.max(1, Math.round(exponential * (0.8 + this.random() * 0.4)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private failSocket(
    socket: WebSocket,
    reason: string,
    permanent: boolean,
    terminate = false,
  ): void {
    this.failedSockets.add(socket);
    this.invalidateSession();
    this.log("warn", "control_api_coordinator_link_frame_rejected", {
      code: permanent
        ? "COORDINATOR_LINK_PROTOCOL_FATAL"
        : "COORDINATOR_LINK_RESYNC_REQUIRED",
      reason,
    });
    if (permanent) {
      this.permanentFailure(
        new CoordinatorLinkClientError(
          "COORDINATOR_LINK_PROTOCOL_INVALID",
          "Coordinator Link rejected a fatal authentication or protocol frame.",
        ),
      );
    }
    if (terminate) {
      socket.terminate();
      return;
    }
    socket.close(permanent ? 1008 : 1012, reason.slice(0, 80));
  }

  private invalidateSession(): void {
    this.authenticated = false;
    this.handshake = null;
    this.snapshot = null;
    this.coordinatorInstanceId = null;
    this.clearHandshakeTimer();
    this.clearLivenessTimer();
    for (const pending of this.pendingStops.values()) pending.sent = false;
    for (const pending of this.pendingGoals.values()) pending.sent = false;
    for (const pending of this.pendingTaskLists.values()) pending.sent = false;
    for (const pending of this.pendingTaskDetails.values()) pending.sent = false;
    this.markUnavailable();
  }

  private rejectPendingForCoordinatorChange(
    coordinatorInstanceId: string,
  ): void {
    const error = new CoordinatorLinkClientError(
      "COORDINATOR_LINK_IDENTITY_CHANGED",
      "Coordinator identity changed before the pending stop completed.",
    );
    for (const [operationId, pending] of this.pendingStops) {
      if (
        pending.message.payload.coordinatorInstanceId === coordinatorInstanceId
      ) {
        continue;
      }
      clearTimeout(pending.timer);
      this.retireStop(pending);
      this.pendingStops.delete(operationId);
      pending.reject(error);
    }
    for (const [operationId, pending] of this.pendingGoals) {
      if (
        pending.message.payload.coordinatorInstanceId === coordinatorInstanceId
      ) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pendingGoals.delete(operationId);
      pending.reject(error);
    }
    for (const [operationId, pending] of this.pendingTaskLists) {
      if (pending.message.payload.coordinatorInstanceId === coordinatorInstanceId) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pendingTaskLists.delete(operationId);
      pending.reject(taskHistoryUnavailable("Coordinator identity changed."));
    }
    for (const [operationId, pending] of this.pendingTaskDetails) {
      if (pending.message.payload.coordinatorInstanceId === coordinatorInstanceId) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pendingTaskDetails.delete(operationId);
      pending.reject(taskHistoryUnavailable("Coordinator identity changed."));
    }
  }

  private permanentFailure(error: CoordinatorLinkClientError): void {
    if (this.permanentlyFailed && !this.firstReadyReject) return;
    this.permanentlyFailed = true;
    this.markUnavailable();
    this.firstReadyReject?.(error);
    this.firstReadyResolve = null;
    this.firstReadyReject = null;
    this.rejectPendingStops(error);
    this.rejectPendingGoals(error);
    this.rejectPendingTaskReads(taskHistoryUnavailable("Coordinator Link failed."));
  }

  private rejectPendingStops(error: Error): void {
    for (const pending of this.pendingStops.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingStops.clear();
  }

  private rejectPendingGoals(error: Error): void {
    for (const pending of this.pendingGoals.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingGoals.clear();
  }

  private rejectPendingTaskReads(error: Error): void {
    for (const pending of this.pendingTaskLists.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingTaskLists.clear();
    for (const pending of this.pendingTaskDetails.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingTaskDetails.clear();
  }

  private taskReadCoordinatorIdentity(): string {
    if (!this.ready || !this.coordinatorInstanceId) {
      throw taskHistoryUnavailable(
        "Coordinator Link has no complete authoritative snapshot.",
      );
    }
    return this.coordinatorInstanceId;
  }

  private assertTaskReadCapacity(): void {
    if (
      this.pendingTaskLists.size + this.pendingTaskDetails.size >=
      MAX_PENDING_TASK_READS
    ) {
      throw taskHistoryUnavailable(
        "Coordinator Link has reached its pending task read limit.",
      );
    }
  }

  private markUnavailable(): void {
    const changed = this.ready || this.records.size > 0;
    this.ready = false;
    this.records.clear();
    this.currentSequence = 0;
    if (changed) this.notifyAvailability(false);
  }

  private notifyAvailability(ready: boolean): void {
    for (const listener of this.availabilityListeners) {
      try {
        listener(ready);
      } catch {
        // Availability observers cannot change the transport state.
      }
    }
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_UNAVAILABLE",
        "Coordinator Link has no complete authoritative snapshot.",
      );
    }
  }

  private assertAuthenticatedIdentity(coordinatorInstanceId: string): void {
    if (
      !this.authenticated ||
      !this.coordinatorInstanceId ||
      coordinatorInstanceId !== this.coordinatorInstanceId
    ) {
      throw new CoordinatorLinkClientError(
        "COORDINATOR_LINK_IDENTITY_MISMATCH",
        "Coordinator Link message identity does not match the authenticated peer.",
      );
    }
  }

  private sign(input: string): string {
    return createHmac("sha256", this.hmacKey)
      .update(input, "utf8")
      .digest("base64url");
  }

  private verify(proof: string, input: string): boolean {
    const actual = Buffer.from(proof, "base64url");
    const expected = createHmac("sha256", this.hmacKey)
      .update(input, "utf8")
      .digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private isCurrent(generation: number, socket: WebSocket): boolean {
    return this.generation === generation && this.socket === socket;
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = null;
  }

  private clearTimers(): void {
    this.clearHandshakeTimer();
    this.clearLivenessTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.options.logger[level](event, fields);
    } catch {
      // Logging failure must not alter authenticated transport state.
    }
  }
}

function validateStopRequest(request: StopBotRequest): void {
  const issuedAt = validDate(request.authorization.issuedAt);
  const expiresAt = validDate(request.authorization.expiresAt);
  if (
    request.commandId !== request.traceId ||
    request.commandId !== request.authorization.decisionId ||
    request.mode !== "graceful" ||
    request.reason !== "dashboard_operator_confirmed" ||
    request.gracePeriodMs !== 5_000 ||
    request.timeoutMs !== 15_000 ||
    !request.authorization.permissions.has("bot.stop") ||
    request.authorization.permissions.size !== 1 ||
    expiresAt.getTime() <= issuedAt.getTime() ||
    expiresAt.getTime() - issuedAt.getTime() > 60_000
  ) {
    throw new CoordinatorStopError(
      "REQUEST_INVALID",
      "Coordinator Link only accepts the fixed confirmed graceful-stop contract.",
    );
  }
}

function stopFingerprint(request: StopBotRequest): string {
  return JSON.stringify({
    commandId: request.commandId,
    traceId: request.traceId,
    botId: request.botId,
    mode: request.mode,
    reason: request.reason,
    gracePeriodMs: request.gracePeriodMs,
    timeoutMs: request.timeoutMs,
    decisionId: request.authorization.decisionId,
    actorId: request.authorization.actorId,
    permissions: [...request.authorization.permissions].sort(),
  });
}

function goalFingerprint(request: SubmitGoalRequest): string {
  return JSON.stringify({
    operationId: request.operationId,
    taskId: request.taskId,
    botId: request.botId,
    actorId: request.actorId,
    operatorGoal: request.operatorGoal,
    timeoutMs: request.timeoutMs,
  });
}

function taskListFingerprint(request: TaskHistoryListRequest): string {
  return JSON.stringify({
    operationId: request.operationId,
    actorId: request.actorId,
    query: request.query,
    issuedAt: validDate(request.issuedAt).toISOString(),
    expiresAt: validDate(request.expiresAt).toISOString(),
  });
}

function taskDetailFingerprint(request: TaskHistoryDetailRequest): string {
  return JSON.stringify({
    operationId: request.operationId,
    actorId: request.actorId,
    taskId: request.taskId,
    issuedAt: validDate(request.issuedAt).toISOString(),
    expiresAt: validDate(request.expiresAt).toISOString(),
  });
}

function taskReadResponseError(
  code: ControlLinkTaskReadErrorCode,
): TaskHistorySourceError {
  if (code === "TASK_NOT_FOUND") {
    return new TaskHistorySourceError(code, "Task was not found.");
  }
  if (code === "AUTHORIZATION_REJECTED" || code === "REQUEST_INVALID") {
    return new TaskHistorySourceError(code, "Coordinator rejected the task read request.");
  }
  return taskHistoryUnavailable("Coordinator task history is unavailable.");
}

function taskHistoryUnavailable(message: string): TaskHistorySourceError {
  return new TaskHistorySourceError("TASK_HISTORY_UNAVAILABLE", message);
}

function stopResponseError(
  code: ControlLinkStopErrorCode,
): CoordinatorStopError {
  const coordinatorCodes = new Set([
    "REQUEST_INVALID",
    "COMMAND_ID_CONFLICT",
    "BOT_NOT_FOUND",
    "BOT_NOT_STOPPABLE",
    "AUTHORIZATION_REJECTED",
    "AUDIT_WRITE_FAILED",
    "STOP_TIMEOUT",
    "STOP_TRANSPORT_FAILED",
    "STOP_CONFIRMATION_INVALID",
  ]);
  const normalized = coordinatorCodes.has(code) ? code : "STOP_TRANSPORT_FAILED";
  return new CoordinatorStopError(
    normalized as ConstructorParameters<typeof CoordinatorStopError>[0],
    "Coordinator Link rejected or could not confirm the stop operation.",
  );
}

function protocolError(message: string): CoordinatorLinkClientError {
  return new CoordinatorLinkClientError(
    "COORDINATOR_LINK_PROTOCOL_INVALID",
    message,
  );
}

function validateEnvelopeTime(value: string, now: Date): void {
  const nowMs = validDate(now).getTime();
  const messageMs = Date.parse(value);
  if (
    !Number.isFinite(messageMs) ||
    Math.abs(messageMs - nowMs) > MAX_CLOCK_SKEW_MS
  ) {
    throw protocolError("Coordinator Link message time is outside clock skew.");
  }
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CoordinatorStopError(
      "REQUEST_INVALID",
      "Coordinator Link received an invalid clock value.",
    );
  }
  return value;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 500);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close(1001, "client_shutdown");
  });
}
