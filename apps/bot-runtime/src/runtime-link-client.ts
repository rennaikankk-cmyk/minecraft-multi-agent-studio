import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  RUNTIME_LINK_MAX_PAYLOAD_BYTES,
  RUNTIME_LINK_SUBPROTOCOL,
  parseBotTelemetryMessage,
  parseRuntimeLinkClientMessage,
  parseRuntimeLinkServerMessage,
  runtimeLinkAuthenticateV1Schema,
  runtimeLinkClientProofInput,
  runtimeLinkServerProofInput,
  type BotStopResultV1,
  type BotTelemetryMessageV1,
  type ControlAuthorizationContext,
  type RuntimeLinkAuthenticateV1,
  type RuntimeLinkChallengeV1,
  type StopBotCommandV1,
} from "@minecraft-studio/protocol";
import WebSocket, { type RawData } from "ws";

import type { RuntimeLinkClientConfig } from "./runtime-link-config.js";

const MAX_CLOCK_SKEW_MS = 30_000;

type TimerHandle = ReturnType<typeof setTimeout>;

type QueuedTelemetry = {
  message: BotTelemetryMessageV1;
  serialized: string;
  bytes: number;
  sent: boolean;
};

type HandshakeContext = {
  challenge: RuntimeLinkChallengeV1;
  authenticate: RuntimeLinkAuthenticateV1;
  clientNonce: string;
};

export type RuntimeLinkClientErrorCode =
  | "RUNTIME_LINK_ALREADY_STARTED"
  | "RUNTIME_LINK_CLOSED"
  | "RUNTIME_LINK_AUTH_FAILED"
  | "RUNTIME_LINK_PROTOCOL_INVALID"
  | "RUNTIME_LINK_IDENTITY_MISMATCH"
  | "RUNTIME_LINK_QUEUE_OVERFLOW"
  | "RUNTIME_LINK_RETRY_EXHAUSTED";

export class RuntimeLinkClientError extends Error {
  readonly code: RuntimeLinkClientErrorCode;

  constructor(code: RuntimeLinkClientErrorCode, message: string) {
    super(message);
    this.name = "RuntimeLinkClientError";
    this.code = code;
  }
}

export type RuntimeLinkClientOptions = Readonly<{
  config: RuntimeLinkClientConfig;
  botId: string;
  runtimeInstanceId: string;
  logger: AppLogger;
  handleStopCommand: (
    command: StopBotCommandV1,
    authorizationContext: ControlAuthorizationContext,
  ) => Promise<BotStopResultV1>;
  publishCurrentState: () => void;
  failClosed: (error: RuntimeLinkClientError) => Promise<void> | void;
  now?: () => Date;
  randomId?: () => string;
  randomNonce?: () => string;
  random?: () => number;
}>;

export class RuntimeLinkClient {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly randomNonce: () => string;
  private readonly random: () => number;
  private readonly hmacKey: Buffer;
  private readonly queue: QueuedTelemetry[] = [];
  private readonly drainWaiters = new Set<() => void>();
  private socket: WebSocket | null = null;
  private handshake: HandshakeContext | null = null;
  private coordinatorInstanceId: string | null = null;
  private handshakeTimer: TimerHandle | null = null;
  private telemetryAckTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private queuedBytes = 0;
  private reconnectAttempts = 0;
  private generation = 0;
  private started = false;
  private authenticated = false;
  private everAuthenticated = false;
  private closing = false;
  private failedClosed = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  constructor(private readonly options: RuntimeLinkClientOptions) {
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
      throw new RuntimeLinkClientError(
        "RUNTIME_LINK_ALREADY_STARTED",
        "Runtime Link has already been started.",
      );
    }
    if (this.closing) {
      throw new RuntimeLinkClientError(
        "RUNTIME_LINK_CLOSED",
        "Runtime Link has already been closed.",
      );
    }

    this.started = true;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.connect();
    return this.readyPromise;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  publishTelemetry(input: BotTelemetryMessageV1): void {
    if (this.closing || this.failedClosed) return;

    let message: BotTelemetryMessageV1;
    try {
      message = parseBotTelemetryMessage(input);
      if (
        message.botId !== this.options.botId ||
        message.payload.runtimeInstanceId !== this.options.runtimeInstanceId
      ) {
        throw new RuntimeLinkClientError(
          "RUNTIME_LINK_IDENTITY_MISMATCH",
          "Telemetry identity does not match the authenticated Runtime.",
        );
      }
      this.enqueueTelemetry(message);
      this.flushTelemetry();
    } catch (cause) {
      const error = cause instanceof RuntimeLinkClientError
        ? cause
        : new RuntimeLinkClientError(
            "RUNTIME_LINK_PROTOCOL_INVALID",
            "Runtime Link rejected invalid local telemetry.",
          );
      this.log("error", "runtime_link_telemetry_rejected", {
        code: error.code,
      });
      void this.triggerFailClosed(error);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.clearTimer("reconnect");

    if (this.queue.length > 0 && this.authenticated) {
      await this.waitForDrain(this.options.config.telemetryAckTimeoutMs);
    }

    this.clearTimer("handshake");
    this.clearTimer("telemetryAck");
    this.authenticated = false;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.resolveDrainWaiters();

    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await closeSocket(socket);
  }

  private connect(): void {
    if (this.closing || this.failedClosed) return;
    this.generation += 1;
    const generation = this.generation;
    this.authenticated = false;
    this.handshake = null;
    this.coordinatorInstanceId = null;

    let socket: WebSocket;
    try {
      socket = new WebSocket(
        this.options.config.url,
        RUNTIME_LINK_SUBPROTOCOL,
        {
          followRedirects: false,
          handshakeTimeout: this.options.config.handshakeTimeoutMs,
          maxPayload: RUNTIME_LINK_MAX_PAYLOAD_BYTES,
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
      if (socket.protocol !== RUNTIME_LINK_SUBPROTOCOL) {
        this.rejectSocket(socket, "subprotocol_invalid");
        return;
      }
      this.startHandshakeTimer(generation, socket);
      this.log("info", "runtime_link_socket_open", {});
    });
    socket.on("message", (data, isBinary) => {
      if (!this.isCurrent(generation, socket)) return;
      this.handleServerFrame(socket, data, isBinary);
    });
    socket.once("error", () => {
      if (!this.isCurrent(generation, socket)) return;
      this.log("warn", "runtime_link_socket_error", {
        code: "RUNTIME_LINK_TRANSPORT_ERROR",
      });
    });
    socket.once("close", () => {
      if (!this.isCurrent(generation, socket)) return;
      this.handleSocketClosed(socket);
    });
  }

  private handleServerFrame(
    socket: WebSocket,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (isBinary) {
      this.rejectSocket(socket, "binary_frame_rejected");
      return;
    }
    const buffer = rawDataBuffer(data);
    if (buffer.byteLength > RUNTIME_LINK_MAX_PAYLOAD_BYTES) {
      this.rejectSocket(socket, "payload_too_large");
      return;
    }

    let message: ReturnType<typeof parseRuntimeLinkServerMessage>;
    try {
      message = parseRuntimeLinkServerMessage(
        JSON.parse(buffer.toString("utf8")) as unknown,
      );
    } catch {
      this.rejectSocket(socket, "protocol_invalid");
      return;
    }

    try {
      if (message.type === "runtime.link.challenge.v1") {
        this.handleChallenge(socket, message);
        return;
      }
      if (message.type === "runtime.link.accepted.v1") {
        this.handleAccepted(socket, message);
        return;
      }
      if (!this.authenticated) {
        this.rejectSocket(socket, "authentication_required");
        return;
      }
      if (message.type === "runtime.link.telemetry-ack.v1") {
        this.handleTelemetryAck(socket, message);
        return;
      }
      void this.handleStopCommand(socket, message);
    } catch {
      this.rejectSocket(socket, "client_state_invalid");
    }
  }

  private handleChallenge(
    socket: WebSocket,
    challenge: RuntimeLinkChallengeV1,
  ): void {
    if (this.handshake || this.authenticated) {
      this.rejectSocket(socket, "challenge_replayed");
      return;
    }
    if (!timestampWithinSkew(challenge.timestamp, this.now(), MAX_CLOCK_SKEW_MS)) {
      this.rejectSocket(socket, "challenge_expired");
      return;
    }

    const clientNonce = this.randomNonce();
    const proofContext = {
      challengeMessageId: challenge.messageId,
      coordinatorInstanceId: challenge.payload.coordinatorInstanceId,
      challengeNonce: challenge.payload.challengeNonce,
      clientNonce,
      botId: this.options.botId,
      runtimeInstanceId: this.options.runtimeInstanceId,
      keyId: this.options.config.keyId,
    };
    const authenticate = runtimeLinkAuthenticateV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      timestamp: validNow(this.now()).toISOString(),
      type: "runtime.link.authenticate.v1",
      payload: {
        ...proofContext,
        clientProof: this.sign(runtimeLinkClientProofInput(proofContext)),
      },
    });
    this.handshake = { challenge, authenticate, clientNonce };
    this.coordinatorInstanceId = challenge.payload.coordinatorInstanceId;
    this.sendClientFrame(socket, authenticate);
  }

  private handleAccepted(
    socket: WebSocket,
    accepted: Extract<
      ReturnType<typeof parseRuntimeLinkServerMessage>,
      { type: "runtime.link.accepted.v1" }
    >,
  ): void {
    const handshake = this.handshake;
    if (!handshake || this.authenticated) {
      this.rejectSocket(socket, "acceptance_unexpected");
      return;
    }
    if (!timestampWithinSkew(accepted.timestamp, this.now(), MAX_CLOCK_SKEW_MS)) {
      this.rejectSocket(socket, "acceptance_expired");
      return;
    }

    const proofContext = {
      challengeMessageId: handshake.challenge.messageId,
      authenticateMessageId: handshake.authenticate.messageId,
      coordinatorInstanceId:
        handshake.challenge.payload.coordinatorInstanceId,
      challengeNonce: handshake.challenge.payload.challengeNonce,
      clientNonce: handshake.clientNonce,
      botId: this.options.botId,
      runtimeInstanceId: this.options.runtimeInstanceId,
      keyId: this.options.config.keyId,
    };
    const identityMatches =
      accepted.payload.challengeMessageId === proofContext.challengeMessageId &&
      accepted.payload.authenticateMessageId ===
        proofContext.authenticateMessageId &&
      accepted.payload.coordinatorInstanceId ===
        proofContext.coordinatorInstanceId &&
      accepted.payload.botId === proofContext.botId &&
      accepted.payload.runtimeInstanceId === proofContext.runtimeInstanceId &&
      accepted.payload.keyId === proofContext.keyId;
    const expectedProof = this.sign(
      runtimeLinkServerProofInput(proofContext),
    );
    if (
      !identityMatches ||
      !safeProofEqual(accepted.payload.serverProof, expectedProof)
    ) {
      this.rejectSocket(socket, "server_proof_invalid");
      return;
    }

    const reconnect = this.everAuthenticated;
    this.authenticated = true;
    this.everAuthenticated = true;
    this.clearTimer("handshake");
    this.log("info", "runtime_link_authenticated", {
      coordinatorInstanceId: proofContext.coordinatorInstanceId,
      reconnect,
    });
    if (this.readyResolve) {
      this.readyResolve();
      this.readyResolve = null;
      this.readyReject = null;
    }
    if (reconnect) {
      try {
        this.options.publishCurrentState();
      } catch {
        void this.triggerFailClosed(
          new RuntimeLinkClientError(
            "RUNTIME_LINK_PROTOCOL_INVALID",
            "Runtime could not publish a fresh state after reconnect.",
          ),
        );
        return;
      }
    }
    this.markFirstQueuedMessageUnsent();
    this.flushTelemetry();
  }

  private handleTelemetryAck(
    socket: WebSocket,
    acknowledgement: Extract<
      ReturnType<typeof parseRuntimeLinkServerMessage>,
      { type: "runtime.link.telemetry-ack.v1" }
    >,
  ): void {
    const current = this.queue[0];
    if (
      !current ||
      !current.sent ||
      current.message.messageId !== acknowledgement.payload.telemetryMessageId
    ) {
      this.rejectSocket(socket, "telemetry_ack_mismatch");
      return;
    }

    if (
      acknowledgement.payload.reason === "retired_runtime" ||
      acknowledgement.payload.reason === "older_runtime_start"
    ) {
      void this.triggerFailClosed(
        new RuntimeLinkClientError(
          "RUNTIME_LINK_IDENTITY_MISMATCH",
          "Coordinator rejected telemetry from a retired Runtime identity.",
        ),
      );
      return;
    }

    this.clearTimer("telemetryAck");
    this.queue.shift();
    this.queuedBytes -= current.bytes;
    this.reconnectAttempts = 0;
    if (this.queue.length === 0) this.resolveDrainWaiters();
    this.flushTelemetry();
  }

  private async handleStopCommand(
    socket: WebSocket,
    command: StopBotCommandV1,
  ): Promise<void> {
    if (
      command.source.service !== "coordinator" ||
      command.source.instanceId !== this.coordinatorInstanceId ||
      command.botId !== this.options.botId
    ) {
      this.rejectSocket(socket, "stop_identity_mismatch");
      return;
    }

    try {
      const permission = command.payload.mode === "emergency"
        ? "bot.emergency-stop" as const
        : "bot.stop" as const;
      const authorizationContext: ControlAuthorizationContext = {
        decisionId: command.payload.authorization.decisionId,
        actorId: command.payload.authorization.actorId,
        botId: command.botId,
        commandId: command.payload.commandId,
        permissions: new Set([permission]),
        now: validNow(this.now()),
      };
      const result = await this.options.handleStopCommand(
        command,
        authorizationContext,
      );
      if (
        result.botId !== this.options.botId ||
        result.traceId !== command.traceId ||
        result.payload.commandId !== command.payload.commandId ||
        result.payload.runtimeInstanceId !== this.options.runtimeInstanceId ||
        result.source.instanceId !== this.options.runtimeInstanceId
      ) {
        throw new RuntimeLinkClientError(
          "RUNTIME_LINK_IDENTITY_MISMATCH",
          "Runtime stop result does not match the authenticated command.",
        );
      }
      if (!this.isCurrent(this.generation, socket) || !this.authenticated) {
        return;
      }
      this.sendClientFrame(socket, result);
    } catch {
      this.log("warn", "runtime_link_stop_rejected", {
        traceId: command.traceId,
        botId: command.botId,
        commandId: command.payload.commandId,
        code: "RUNTIME_LINK_STOP_REJECTED",
      });
      this.rejectSocket(socket, "stop_rejected");
    }
  }

  private enqueueTelemetry(message: BotTelemetryMessageV1): void {
    const serialized = JSON.stringify(parseRuntimeLinkClientMessage(message));
    const bytes = Buffer.byteLength(serialized);
    if (bytes > RUNTIME_LINK_MAX_PAYLOAD_BYTES) {
      throw new RuntimeLinkClientError(
        "RUNTIME_LINK_PROTOCOL_INVALID",
        "Telemetry exceeds the Runtime Link payload boundary.",
      );
    }

    if (isCoalescible(message)) {
      const minimumIndex = this.queue[0]?.sent ? 1 : 0;
      for (let index = this.queue.length - 1; index >= minimumIndex; index -= 1) {
        const queued = this.queue[index];
        if (queued?.message.type === message.type) {
          this.queuedBytes -= queued.bytes;
          this.queue.splice(index, 1);
          break;
        }
      }
    }

    this.makeQueueSpace(bytes);
    if (
      this.queue.length >= this.options.config.queue.maxMessages ||
      this.queuedBytes + bytes > this.options.config.queue.maxBytes
    ) {
      throw new RuntimeLinkClientError(
        "RUNTIME_LINK_QUEUE_OVERFLOW",
        "Runtime Link telemetry queue reached its bounded capacity.",
      );
    }
    this.queue.push({ message, serialized, bytes, sent: false });
    this.queuedBytes += bytes;
  }

  private makeQueueSpace(incomingBytes: number): void {
    let index = this.queue[0]?.sent ? 1 : 0;
    while (
      (this.queue.length >= this.options.config.queue.maxMessages ||
        this.queuedBytes + incomingBytes > this.options.config.queue.maxBytes) &&
      index < this.queue.length
    ) {
      const queued = this.queue[index];
      if (queued && isCoalescible(queued.message)) {
        this.queuedBytes -= queued.bytes;
        this.queue.splice(index, 1);
      } else {
        index += 1;
      }
    }
  }

  private flushTelemetry(): void {
    if (
      !this.authenticated ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.telemetryAckTimer
    ) {
      return;
    }
    const current = this.queue[0];
    if (!current) {
      this.resolveDrainWaiters();
      return;
    }
    if (!this.sendSerialized(this.socket, current.serialized)) return;
    current.sent = true;
    const generation = this.generation;
    const socket = this.socket;
    this.telemetryAckTimer = setTimeout(() => {
      this.telemetryAckTimer = null;
      if (!this.isCurrent(generation, socket)) return;
      this.log("warn", "runtime_link_telemetry_ack_timeout", {
        messageType: current.message.type,
      });
      this.rejectSocket(socket, "telemetry_ack_timeout", 1013);
    }, this.options.config.telemetryAckTimeoutMs);
  }

  private sendClientFrame(
    socket: WebSocket,
    message: Parameters<typeof parseRuntimeLinkClientMessage>[0],
  ): void {
    let serialized: string;
    try {
      serialized = JSON.stringify(parseRuntimeLinkClientMessage(message));
    } catch {
      this.rejectSocket(socket, "client_frame_invalid");
      return;
    }
    this.sendSerialized(socket, serialized);
  }

  private sendSerialized(socket: WebSocket, serialized: string): boolean {
    if (
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > this.options.config.queue.maxSocketBufferedBytes
    ) {
      this.rejectSocket(socket, "backpressure", 1013);
      return false;
    }
    try {
      socket.send(serialized, { binary: false }, (error) => {
        if (error && socket.readyState === WebSocket.OPEN) {
          this.rejectSocket(socket, "send_failed", 1013);
        }
      });
      return true;
    } catch {
      this.rejectSocket(socket, "send_failed", 1013);
      return false;
    }
  }

  private handleSocketClosed(socket: WebSocket): void {
    if (this.socket === socket) this.socket = null;
    this.clearTimer("handshake");
    this.clearTimer("telemetryAck");
    this.authenticated = false;
    this.handshake = null;
    this.coordinatorInstanceId = null;
    this.markFirstQueuedMessageUnsent();
    this.log("warn", "runtime_link_disconnected", {
      code: "RUNTIME_LINK_DISCONNECTED",
    });
    if (!this.closing && !this.failedClosed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closing || this.failedClosed || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > this.options.config.reconnect.maxAttempts) {
      void this.triggerFailClosed(
        new RuntimeLinkClientError(
          "RUNTIME_LINK_RETRY_EXHAUSTED",
          "Runtime Link exhausted its bounded reconnect attempts.",
        ),
      );
      return;
    }
    const baseDelay = Math.min(
      this.options.config.reconnect.maxDelayMs,
      this.options.config.reconnect.baseDelayMs *
        2 ** (this.reconnectAttempts - 1),
    );
    const randomValue = this.random();
    const jitter = Number.isFinite(randomValue) && randomValue >= 0 && randomValue < 1
      ? 0.8 + randomValue * 0.4
      : 1;
    const delay = Math.max(
      1,
      Math.min(
        this.options.config.reconnect.maxDelayMs,
        Math.round(baseDelay * jitter),
      ),
    );
    this.log("info", "runtime_link_reconnect_scheduled", {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHandshakeTimer(generation: number, socket: WebSocket): void {
    this.clearTimer("handshake");
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (!this.isCurrent(generation, socket) || this.authenticated) return;
      this.rejectSocket(socket, "handshake_timeout");
    }, this.options.config.handshakeTimeoutMs);
  }

  private rejectSocket(
    socket: WebSocket,
    reason: string,
    code = 1008,
  ): void {
    this.log("warn", "runtime_link_protocol_rejected", { reason });
    try {
      socket.close(code, reason.slice(0, 80));
      const terminationTimer = setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }, 500);
      terminationTimer.unref?.();
    } catch {
      socket.terminate();
    }
  }

  private async triggerFailClosed(error: RuntimeLinkClientError): Promise<void> {
    if (this.failedClosed) return;
    this.failedClosed = true;
    this.authenticated = false;
    this.clearTimer("reconnect");
    this.clearTimer("handshake");
    this.clearTimer("telemetryAck");
    this.log("error", "runtime_link_fail_closed", { code: error.code });
    if (this.readyReject) {
      this.readyReject(error);
      this.readyResolve = null;
      this.readyReject = null;
    }
    try {
      await this.options.failClosed(error);
    } catch {
      this.log("error", "runtime_link_fail_closed_callback_failed", {
        code: "RUNTIME_LINK_FAIL_CLOSED_CALLBACK_FAILED",
      });
    }
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  private sign(input: string): string {
    return createHmac("sha256", this.hmacKey)
      .update(input, "utf8")
      .digest("base64url");
  }

  private isCurrent(generation: number, socket: WebSocket): boolean {
    return generation === this.generation && socket === this.socket;
  }

  private markFirstQueuedMessageUnsent(): void {
    const first = this.queue[0];
    if (first) first.sent = false;
  }

  private clearTimer(timer: "handshake" | "telemetryAck" | "reconnect"): void {
    const key = `${timer}Timer` as const;
    const handle = this[key];
    if (handle) {
      clearTimeout(handle);
      this[key] = null;
    }
  }

  private waitForDrain(timeoutMs: number): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.drainWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.drainWaiters.add(finish);
    });
  }

  private resolveDrainWaiters(): void {
    for (const resolve of [...this.drainWaiters]) resolve();
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.options.logger[level](event, {
        traceId: null,
        taskId: null,
        botId: this.options.botId,
        skillId: null,
        modelName: null,
        ...fields,
      });
    } catch {
      // Observability failure must not change the Runtime Link state machine.
    }
  }
}

function isCoalescible(message: BotTelemetryMessageV1): boolean {
  return message.type !== "bot.disconnected.v1";
}

function timestampWithinSkew(
  timestamp: string,
  now: Date,
  maximumSkewMs: number,
): boolean {
  const current = validNow(now).getTime();
  const received = Date.parse(timestamp);
  return Number.isFinite(received) && Math.abs(current - received) <= maximumSkewMs;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RuntimeLinkClientError(
      "RUNTIME_LINK_PROTOCOL_INVALID",
      "Runtime Link clock is invalid.",
    );
  }
  return value;
}

function safeProofEqual(actual: string, expected: string): boolean {
  try {
    const actualBytes = Buffer.from(actual, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    return actualBytes.length === expectedBytes.length &&
      timingSafeEqual(actualBytes, expectedBytes);
  } catch {
    return false;
  }
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function closeSocket(socket: WebSocket): Promise<void> {
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
    }, 1_000);
    socket.once("close", finish);
    try {
      socket.close(1000, "runtime_shutdown");
    } catch {
      socket.terminate();
      finish();
    }
  });
}
