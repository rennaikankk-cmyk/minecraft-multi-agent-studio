import { randomUUID } from "node:crypto";

import {
  botVersionV1Schema,
  botStopResultV1Schema,
  botDisconnectedV1Schema,
  botHeartbeatV1Schema,
  botStatusV1Schema,
  parseBotProtocolMessage,
  parseBotTelemetryMessage,
  type BotDisconnectedV1,
  type BotHeartbeatV1,
  type BotStopResultV1,
  type BotStatusV1,
  type BotVersionV1,
  type ControlAuthorizationContext,
  type MinecraftVersionCompatibility,
  type StopBotCommandV1,
} from "@minecraft-studio/protocol";

import type {
  BotClient,
  BotClientFactory,
  BotDisconnectInfo,
} from "./client.js";
import type { ServerProfile } from "./server-profile.js";
import type {
  BotConnectionState,
  BotMessageSink,
  RuntimeLogger,
} from "./runtime-types.js";
import { unsupportedVersionCompatibility } from "./version-compatibility.js";

type TimerHandle = ReturnType<typeof setTimeout>;

export type RuntimeDependencies = {
  createClient: BotClientFactory;
  messageSink: BotMessageSink;
  logger: RuntimeLogger;
  now?: () => Date;
  randomId?: () => string;
};

export type RuntimeStopOutcome =
  | { confirmed: true }
  | { confirmed: false; errorCode: "CLIENT_CLOSE_FAILED" };

export type RuntimeControlErrorCode =
  | "CONTROL_MESSAGE_REQUIRED"
  | "COMMAND_ID_CONFLICT";

export class RuntimeControlError extends Error {
  readonly code: RuntimeControlErrorCode;

  constructor(code: RuntimeControlErrorCode, message: string) {
    super(message);
    this.name = "RuntimeControlError";
    this.code = code;
  }
}

export class SingleBotRuntime {
  private readonly runtimeInstanceId: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private state: BotConnectionState = "offline";
  private client: BotClient | null = null;
  private generation = 0;
  private traceId = "not-connected";
  private sequence = 0;
  private lastStatusSequence: number | null = null;
  private reconnectAttempts = 0;
  private stopping = false;
  private heartbeatTimer: TimerHandle | null = null;
  private statusTimer: TimerHandle | null = null;
  private deferredStatusTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private lastStatusAt = 0;
  private minecraftVersionCompatibility: MinecraftVersionCompatibility | null =
    null;
  private versionUnsupported = false;
  private stopPromise: Promise<RuntimeStopOutcome> | null = null;
  private readonly stopExecutions = new Map<
    string,
    { fingerprint: string; result: Promise<BotStopResultV1> }
  >();

  constructor(
    private readonly profile: ServerProfile,
    private readonly dependencies: RuntimeDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.randomId = dependencies.randomId ?? randomUUID;
    this.runtimeInstanceId = `runtime-${this.randomId()}`;
  }

  getState(): BotConnectionState {
    return this.state;
  }

  getRuntimeInstanceId(): string {
    return this.runtimeInstanceId;
  }

  start(): void {
    if (this.state !== "offline" || this.client || this.reconnectTimer) {
      throw new Error("Bot Runtime has already been started.");
    }
    this.stopPromise = null;
    this.stopping = false;
    this.reconnectAttempts = 0;
    this.connect();
  }

  stop(reason = "operator_request"): Promise<RuntimeStopOutcome> {
    if (this.stopPromise) return this.stopPromise;

    const pending = this.performStop(reason);
    this.stopPromise = pending;
    void pending.then((outcome) => {
      if (!outcome.confirmed && this.stopPromise === pending) {
        this.stopPromise = null;
        this.stopping = false;
      }
    });
    return pending;
  }

  handleStopCommand(
    input: unknown,
    authorizationContext: ControlAuthorizationContext,
  ): Promise<BotStopResultV1> {
    const message = parseBotProtocolMessage(input, authorizationContext);
    if (message.type !== "bot.stop.command.v1") {
      throw new RuntimeControlError(
        "CONTROL_MESSAGE_REQUIRED",
        "Bot Runtime only accepts a validated stop command on this control path.",
      );
    }

    const fingerprint = JSON.stringify(message);
    const existing = this.stopExecutions.get(message.payload.commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new RuntimeControlError(
          "COMMAND_ID_CONFLICT",
          "The command ID was already used with different stop parameters.",
        );
      }
      return existing.result;
    }

    const result = this.executeStopCommand(message);
    this.stopExecutions.set(message.payload.commandId, { fingerprint, result });
    void result.then(
      () => this.trimStopExecutions(),
      () => this.trimStopExecutions(),
    );
    return result;
  }

  private async performStop(reason: string): Promise<RuntimeStopOutcome> {
    this.stopping = true;
    this.clearTimer("reconnect");
    this.clearTimer("status");
    this.clearTimer("deferredStatus");

    const activeClient = this.client;
    const activeGeneration = this.generation;
    if (!activeClient) {
      this.clearTimer("heartbeat");
      this.state = "offline";
      return { confirmed: true };
    }

    this.state = "stopping";
    this.emitHeartbeat();
    this.dependencies.logger.info("bot_runtime_stop_requested", {
      botId: this.profile.botId,
      reason,
    });

    let closeFailed = false;
    try {
      await activeClient.close(this.profile.stopGracePeriodMs);
    } catch {
      closeFailed = true;
      this.dependencies.logger.error("bot_runtime_close_failed", {
        botId: this.profile.botId,
      });
    }

    if (closeFailed && this.client === activeClient) {
      this.state = "error";
      this.emitHeartbeat();
      return { confirmed: false, errorCode: "CLIENT_CLOSE_FAILED" };
    }
    if (this.client === activeClient) {
      this.handleDisconnected(activeGeneration, {
        reason: "requested_stop",
        expected: true,
      });
    }
    return { confirmed: true };
  }

  private async executeStopCommand(
    command: StopBotCommandV1,
  ): Promise<BotStopResultV1> {
    const expectedRuntimeInstanceId =
      command.payload.expectedRuntimeInstanceId;
    if (
      expectedRuntimeInstanceId !== null &&
      expectedRuntimeInstanceId !== this.runtimeInstanceId
    ) {
      return this.createStopResult(
        command,
        "rejected",
        "RUNTIME_INSTANCE_MISMATCH",
      );
    }

    const outcome = await this.stop(`coordinator_${command.payload.mode}_stop`);
    return outcome.confirmed
      ? this.createStopResult(command, "completed")
      : this.createStopResult(command, "failed", outcome.errorCode);
  }

  private createStopResult(
    command: StopBotCommandV1,
    outcome: BotStopResultV1["payload"]["outcome"],
    errorCode?: string,
  ): BotStopResultV1 {
    const timestamp = this.now().toISOString();
    return botStopResultV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      traceId: command.traceId,
      timestamp,
      source: {
        service: "bot-runtime",
        instanceId: this.runtimeInstanceId,
      },
      botId: this.profile.botId,
      type: "bot.stop.result.v1",
      payload: {
        commandId: command.payload.commandId,
        runtimeInstanceId: this.runtimeInstanceId,
        outcome,
        completedAt: timestamp,
        ...(errorCode ? { errorCode } : {}),
      },
    });
  }

  private trimStopExecutions(): void {
    while (this.stopExecutions.size > 128) {
      const oldest = this.stopExecutions.keys().next().value as
        | string
        | undefined;
      if (!oldest) return;
      this.stopExecutions.delete(oldest);
    }
  }

  private connect(): void {
    this.generation += 1;
    const activeGeneration = this.generation;
    this.traceId = `connection-${this.randomId()}`;
    this.minecraftVersionCompatibility = null;
    this.versionUnsupported = false;
    this.state = "connecting";
    this.startHeartbeatTimer();
    this.emitHeartbeat();
    this.dependencies.logger.info("bot_runtime_connecting", {
      botId: this.profile.botId,
      serverProfileId: this.profile.id,
      attempt: this.reconnectAttempts,
    });

    try {
      const client = this.dependencies.createClient(this.profile);
      this.client = client;
      client.setHandlers({
        onSpawn: () => this.handleSpawn(activeGeneration),
        onStateChanged: () => this.requestStatus(activeGeneration),
        onDisconnected: (info) =>
          this.handleDisconnected(activeGeneration, info),
        onError: () => {
          this.dependencies.logger.warn("bot_runtime_client_error", {
            botId: this.profile.botId,
          });
        },
        onVersionUnsupported: () =>
          this.handleVersionUnsupported(activeGeneration),
      });
    } catch {
      this.handleDisconnected(activeGeneration, {
        reason: "runtime_error",
        expected: false,
        detail: "client_factory_failed",
      });
    }
  }

  private handleSpawn(generation: number): void {
    if (generation !== this.generation || this.stopping || !this.client) return;
    try {
      this.minecraftVersionCompatibility =
        this.client.versionCompatibility();
    } catch {
      this.handleVersionUnsupported(generation);
      this.dependencies.logger.error("bot_runtime_version_metadata_invalid", {
        botId: this.profile.botId,
      });
      const incompatibleClient = this.client;
      void incompatibleClient
        .close(this.profile.stopGracePeriodMs)
        .catch(() => {
          this.dependencies.logger.error("bot_runtime_incompatible_close_failed", {
            botId: this.profile.botId,
          });
        });
      return;
    }
    this.state = "online";
    this.reconnectAttempts = 0;
    this.emitVersion();
    this.startStatusTimer(generation);
    this.emitStatus(generation);
    this.emitHeartbeat();
    this.dependencies.logger.info("bot_runtime_online", {
      botId: this.profile.botId,
      serverProfileId: this.profile.id,
    });
  }

  private handleVersionUnsupported(generation: number): void {
    if (generation !== this.generation || this.stopping) return;
    if (this.minecraftVersionCompatibility?.supportLevel === "unsupported") {
      return;
    }
    this.minecraftVersionCompatibility = unsupportedVersionCompatibility(
      this.profile.minecraftVersion,
    );
    this.versionUnsupported = true;
    this.emitVersion();
    this.dependencies.logger.warn("bot_runtime_version_unsupported", {
      botId: this.profile.botId,
      supportedOldest:
        this.minecraftVersionCompatibility.supportedRange.oldest,
      supportedLatest:
        this.minecraftVersionCompatibility.supportedRange.latest,
    });
  }

  private handleDisconnected(
    generation: number,
    info: BotDisconnectInfo,
  ): void {
    if (generation !== this.generation) return;
    this.client = null;
    this.clearTimer("heartbeat");
    this.clearTimer("status");
    this.clearTimer("deferredStatus");
    this.state = "offline";
    this.emitDisconnected(info);

    this.dependencies.logger.warn("bot_runtime_disconnected", {
      botId: this.profile.botId,
      reason: info.reason,
      expected: info.expected,
    });

    if (!this.stopping && !this.versionUnsupported) {
      this.scheduleReconnect();
    } else if (this.versionUnsupported) {
      this.dependencies.logger.warn("bot_runtime_reconnect_suppressed", {
        botId: this.profile.botId,
        code: "MINECRAFT_VERSION_UNSUPPORTED",
      });
    }
  }

  private scheduleReconnect(): void {
    const config = this.profile.reconnect;
    if (!config.enabled || this.reconnectAttempts >= config.maxAttempts) {
      this.dependencies.logger.warn("bot_runtime_reconnect_exhausted", {
        botId: this.profile.botId,
        attempts: this.reconnectAttempts,
      });
      return;
    }

    const delay = Math.min(
      config.maxDelayMs,
      config.baseDelayMs * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopping) this.connect();
    }, delay);
  }

  private requestStatus(generation: number): void {
    if (generation !== this.generation || this.state !== "online") return;
    const elapsed = this.now().getTime() - this.lastStatusAt;
    if (elapsed >= this.profile.statusIntervalMs) {
      this.emitStatus(generation);
      return;
    }
    if (this.deferredStatusTimer) return;

    this.deferredStatusTimer = setTimeout(() => {
      this.deferredStatusTimer = null;
      this.emitStatus(generation);
    }, Math.max(0, this.profile.statusIntervalMs - elapsed));
  }

  private startHeartbeatTimer(): void {
    this.clearTimer("heartbeat");
    this.heartbeatTimer = setInterval(
      () => this.emitHeartbeat(),
      this.profile.heartbeatIntervalMs,
    );
  }

  private startStatusTimer(generation: number): void {
    this.clearTimer("status");
    this.statusTimer = setInterval(
      () => this.emitStatus(generation),
      this.profile.statusIntervalMs,
    );
  }

  private emitStatus(generation: number): void {
    if (generation !== this.generation || this.state !== "online" || !this.client) {
      return;
    }
    this.clearTimer("deferredStatus");

    try {
      const snapshot = this.client.snapshot();
      const sequence = this.nextSequence();
      const observedAt = this.now().toISOString();
      const message: BotStatusV1 = botStatusV1Schema.parse({
        ...this.envelope("bot.status.v1"),
        payload: {
          serverProfileId: this.profile.id,
          runtimeInstanceId: this.runtimeInstanceId,
          sequence,
          observedAt,
          connectionState: "online",
          health: snapshot.health,
          food: snapshot.food,
          armorPoints: snapshot.armorPoints,
          position: snapshot.position,
          latencyMs: snapshot.latencyMs,
          currentTask: null,
          ...(this.minecraftVersionCompatibility
            ? { minecraftVersion: this.minecraftVersionCompatibility }
            : {}),
        },
      });
      this.lastStatusSequence = sequence;
      this.lastStatusAt = this.now().getTime();
      this.emit(message);
    } catch {
      this.dependencies.logger.error("bot_runtime_status_invalid", {
        botId: this.profile.botId,
      });
    }
  }

  private emitVersion(): void {
    if (!this.minecraftVersionCompatibility) return;
    const message: BotVersionV1 = botVersionV1Schema.parse({
      ...this.envelope("bot.version.v1"),
      payload: {
        serverProfileId: this.profile.id,
        runtimeInstanceId: this.runtimeInstanceId,
        sequence: this.nextSequence(),
        observedAt: this.now().toISOString(),
        compatibility: this.minecraftVersionCompatibility,
      },
    });
    this.emit(message);
  }

  private emitHeartbeat(): void {
    const observedAt = this.now().toISOString();
    const message: BotHeartbeatV1 = botHeartbeatV1Schema.parse({
      ...this.envelope("bot.heartbeat.v1"),
      payload: {
        serverProfileId: this.profile.id,
        runtimeInstanceId: this.runtimeInstanceId,
        sequence: this.nextSequence(),
        observedAt,
        connectionState: this.state,
        uptimeMs: Math.max(0, Math.round(process.uptime() * 1000)),
        lastStatusSequence: this.lastStatusSequence,
        currentTaskId: null,
      },
    });
    this.emit(message);
  }

  private emitDisconnected(info: BotDisconnectInfo): void {
    const message: BotDisconnectedV1 = botDisconnectedV1Schema.parse({
      ...this.envelope("bot.disconnected.v1"),
      payload: {
        serverProfileId: this.profile.id,
        runtimeInstanceId: this.runtimeInstanceId,
        sequence: this.nextSequence(),
        observedAt: this.now().toISOString(),
        reason: info.reason,
        expected: info.expected,
        lastStatusSequence: this.lastStatusSequence,
        ...(info.detail ? { detail: info.detail.slice(0, 500) } : {}),
      },
    });
    this.emit(message);
  }

  private envelope(type: string) {
    return {
      schemaVersion: "1.0" as const,
      messageId: this.randomId(),
      traceId: this.traceId,
      timestamp: this.now().toISOString(),
      source: {
        service: "bot-runtime" as const,
        instanceId: this.runtimeInstanceId,
      },
      botId: this.profile.botId,
      type,
    };
  }

  private emit(message: Parameters<BotMessageSink>[0]): void {
    const validated = parseBotTelemetryMessage(message);
    void Promise.resolve(this.dependencies.messageSink(validated)).catch(() => {
      this.dependencies.logger.error("bot_runtime_message_sink_failed", {
        botId: this.profile.botId,
        messageType: validated.type,
      });
    });
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private clearTimer(
    timer: "heartbeat" | "status" | "deferredStatus" | "reconnect",
  ): void {
    const key = `${timer}Timer` as const;
    const handle = this[key];
    if (handle) {
      clearTimeout(handle);
      this[key] = null;
    }
  }
}
