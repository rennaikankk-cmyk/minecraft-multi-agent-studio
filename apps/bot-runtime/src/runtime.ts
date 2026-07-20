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
  type L0SafetyStatus,
  type StopBotCommandV1,
} from "@minecraft-studio/protocol";
import {
  InMemoryMetricRegistry,
  type MetricRecorder,
  type MetricSample,
} from "@minecraft-studio/observability";
import {
  L0SafetyController,
  type L0SafetyAction,
  type L0SafetyActionResult,
  type L0SafetyDecision,
} from "@minecraft-studio/safety";

import type {
  BotClient,
  BotClientFactory,
  BotClientSnapshot,
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
  metrics?: MetricRecorder;
  safetyController?: L0SafetyController;
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
  private readonly metrics: MetricRecorder;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly safetyController: L0SafetyController;
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
  private safetyActionQueue: Promise<void> = Promise.resolve();
  private safetyStatus: L0SafetyStatus = {
    mode: "monitoring",
    activeRisks: [],
    normalTasksPaused: false,
    lastDecisionId: null,
    lastAction: null,
  };
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
    this.metrics = dependencies.metrics ?? new InMemoryMetricRegistry();
    this.safetyController = dependencies.safetyController ?? new L0SafetyController();
  }

  getState(): BotConnectionState {
    return this.state;
  }

  getRuntimeInstanceId(): string {
    return this.runtimeInstanceId;
  }

  getMetricsSnapshot(): MetricSample[] {
    return this.metrics.snapshot();
  }

  getSafetyStatus(): L0SafetyStatus {
    return structuredClone(this.safetyStatus);
  }

  canAcceptNormalActions(): boolean {
    return this.state === "online" && !this.safetyStatus.normalTasksPaused;
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

  stop(
    reason = "operator_request",
    operationTraceId = this.traceId,
  ): Promise<RuntimeStopOutcome> {
    if (this.stopPromise) return this.stopPromise;

    const pending = this.performStop(reason, operationTraceId);
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

  private async performStop(
    reason: string,
    operationTraceId: string,
  ): Promise<RuntimeStopOutcome> {
    this.stopping = true;
    this.metrics.increment("bot_stop_requests_total", {
      bot_id: this.profile.botId,
      source: reason.startsWith("coordinator_") ? "coordinator" : "local",
    });
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
    this.dependencies.logger.info("bot_runtime_stop_requested", this.logFields({
      reason,
    }, operationTraceId));

    let closeFailed = false;
    try {
      await activeClient.close(this.profile.stopGracePeriodMs);
    } catch {
      closeFailed = true;
      this.dependencies.logger.error(
        "bot_runtime_close_failed",
        this.logFields({}, operationTraceId),
      );
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

    const outcome = await this.stop(
      `coordinator_${command.payload.mode}_stop`,
      command.traceId,
    );
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
    const result = botStopResultV1Schema.parse({
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
    this.metrics.increment("bot_stop_results_total", {
      bot_id: this.profile.botId,
      outcome,
    });
    const log = outcome === "completed"
      ? this.dependencies.logger.info.bind(this.dependencies.logger)
      : this.dependencies.logger.warn.bind(this.dependencies.logger);
    log("bot_runtime_stop_result", this.logFields({
      commandId: command.payload.commandId,
      outcome,
      ...(errorCode ? { errorCode } : {}),
    }, command.traceId));
    return result;
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
    this.safetyController.reset();
    this.safetyStatus = {
      mode: "monitoring",
      activeRisks: [],
      normalTasksPaused: false,
      lastDecisionId: null,
      lastAction: null,
    };
    this.traceId = `connection-${this.randomId()}`;
    this.minecraftVersionCompatibility = null;
    this.versionUnsupported = false;
    this.state = "connecting";
    this.metrics.increment("bot_connection_attempts_total", {
      bot_id: this.profile.botId,
    });
    this.startHeartbeatTimer();
    this.emitHeartbeat();
    this.dependencies.logger.info("bot_runtime_connecting", this.logFields({
      serverProfileId: this.profile.id,
      attempt: this.reconnectAttempts,
    }));

    try {
      const client = this.dependencies.createClient(this.profile);
      this.client = client;
      client.setHandlers({
        onSpawn: () => this.handleSpawn(activeGeneration),
        onStateChanged: () => this.requestStatus(activeGeneration),
        onDisconnected: (info) =>
          this.handleDisconnected(activeGeneration, info),
        onError: () => {
          this.dependencies.logger.warn(
            "bot_runtime_client_error",
            this.logFields(),
          );
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
      this.dependencies.logger.error(
        "bot_runtime_version_metadata_invalid",
        this.logFields(),
      );
      const incompatibleClient = this.client;
      void incompatibleClient
        .close(this.profile.stopGracePeriodMs)
        .catch(() => {
          this.dependencies.logger.error(
            "bot_runtime_incompatible_close_failed",
            this.logFields(),
          );
        });
      return;
    }
    this.state = "online";
    this.reconnectAttempts = 0;
    this.emitVersion();
    this.startStatusTimer(generation);
    this.emitStatus(generation);
    this.emitHeartbeat();
    this.dependencies.logger.info("bot_runtime_online", this.logFields({
      serverProfileId: this.profile.id,
    }));
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
    this.dependencies.logger.warn("bot_runtime_version_unsupported", this.logFields({
      supportedOldest:
        this.minecraftVersionCompatibility.supportedRange.oldest,
      supportedLatest:
        this.minecraftVersionCompatibility.supportedRange.latest,
    }));
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
    this.metrics.increment("bot_disconnects_total", {
      bot_id: this.profile.botId,
      reason: info.reason,
    });

    this.dependencies.logger.warn("bot_runtime_disconnected", this.logFields({
      reason: info.reason,
      expected: info.expected,
    }));

    if (!this.stopping && !this.versionUnsupported) {
      this.scheduleReconnect();
    } else if (this.versionUnsupported) {
      this.dependencies.logger.warn("bot_runtime_reconnect_suppressed", this.logFields({
        code: "MINECRAFT_VERSION_UNSUPPORTED",
      }));
    }
  }

  private scheduleReconnect(): void {
    const config = this.profile.reconnect;
    if (!config.enabled || this.reconnectAttempts >= config.maxAttempts) {
      this.dependencies.logger.warn("bot_runtime_reconnect_exhausted", this.logFields({
        attempts: this.reconnectAttempts,
      }));
      return;
    }

    const delay = Math.min(
      config.maxDelayMs,
      config.baseDelayMs * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.metrics.increment("bot_reconnects_scheduled_total", {
      bot_id: this.profile.botId,
    });
    this.dependencies.logger.info("bot_runtime_reconnect_scheduled", this.logFields({
      attempt: this.reconnectAttempts,
      delayMs: delay,
    }));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopping) this.connect();
    }, delay);
  }

  private requestStatus(generation: number): void {
    if (generation !== this.generation || this.state !== "online") return;
    try {
      if (this.client) this.evaluateSafetySnapshot(generation, this.client.snapshot());
    } catch {
      this.dependencies.logger.error(
        "l0_safety_snapshot_invalid",
        this.logFields({ code: "SAFETY_SNAPSHOT_INVALID" }),
      );
    }
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
      this.evaluateSafetySnapshot(generation, snapshot);
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
          safety: this.safetyStatus,
          ...(this.minecraftVersionCompatibility
            ? { minecraftVersion: this.minecraftVersionCompatibility }
            : {}),
        },
      });
      this.lastStatusSequence = sequence;
      this.lastStatusAt = this.now().getTime();
      this.emit(message);
    } catch {
      this.dependencies.logger.error(
        "bot_runtime_status_invalid",
        this.logFields(),
      );
    }
  }

  private evaluateSafetySnapshot(
    generation: number,
    snapshot: BotClientSnapshot,
  ): void {
    if (generation !== this.generation || this.state !== "online") return;
    const decision = this.safetyController.evaluate({
      observedAtMs: this.now().getTime(),
      health: snapshot.health.current,
      foodLevel: snapshot.food.level,
      oxygenLevel: snapshot.safety.oxygenLevel,
      inWater: snapshot.safety.inWater,
      inLava: snapshot.safety.inLava,
      onGround: snapshot.safety.onGround,
      velocityY: snapshot.safety.velocityY,
      position: {
        x: snapshot.position.x,
        y: snapshot.position.y,
        z: snapshot.position.z,
      },
      inventory: snapshot.safety.inventory,
      hasSafeFood: snapshot.safety.hasSafeFood,
      movementRequested: snapshot.safety.movementRequested,
    });
    const emergencyStopping = decision.actions.some(
      ({ kind }) => kind === "EMERGENCY_STOP",
    );
    this.safetyStatus = {
      mode: emergencyStopping
        ? "emergency_stopping"
        : decision.normalTasksPaused
          ? "paused"
          : decision.activeRisks.length > 0
            ? "intervening"
            : "monitoring",
      activeRisks: [...decision.activeRisks],
      normalTasksPaused: decision.normalTasksPaused,
      lastDecisionId: decision.decisionId ?? this.safetyStatus.lastDecisionId,
      lastAction: this.safetyStatus.lastAction,
    };

    if (decision.changed || decision.actions.length > 0) {
      this.metrics.increment("bot_safety_decisions_total", {
        bot_id: this.profile.botId,
        severity: decision.severity,
      });
      const log = decision.severity === "critical"
        ? this.dependencies.logger.warn.bind(this.dependencies.logger)
        : this.dependencies.logger.info.bind(this.dependencies.logger);
      log("l0_safety_decision", this.logFields({
        decisionId: decision.decisionId,
        severity: decision.severity,
        riskCodes: decision.activeRisks,
        normalTasksPaused: decision.normalTasksPaused,
        actionKinds: decision.actions.map(({ kind }) => kind),
      }));
    }
    if (decision.actions.length > 0 && decision.decisionId) {
      this.queueSafetyActions(generation, decision);
    }
  }

  private queueSafetyActions(
    generation: number,
    decision: L0SafetyDecision,
  ): void {
    const expectedClient = this.client;
    this.safetyActionQueue = this.safetyActionQueue
      .then(async () => {
        for (const action of decision.actions) {
          if (
            generation !== this.generation ||
            !expectedClient ||
            this.client !== expectedClient ||
            this.state !== "online"
          ) {
            return;
          }
          let result: L0SafetyActionResult;
          if (action.kind === "EMERGENCY_STOP") {
            const stopOutcome = await this.stop(
              "l0_emergency_stop",
              this.traceId,
            );
            result = stopOutcome.confirmed
              ? { outcome: "executed", errorCode: null }
              : { outcome: "failed", errorCode: stopOutcome.errorCode };
          } else {
            result = await expectedClient.executeSafetyAction(action);
          }
          this.recordSafetyAction(decision, action, result);
          if (action.kind === "EMERGENCY_STOP") return;
        }
        if (this.state === "online" && this.client === expectedClient) {
          this.emitStatus(generation);
        }
      })
      .catch(() => {
        this.dependencies.logger.error(
          "l0_safety_execution_failed",
          this.logFields({
            decisionId: decision.decisionId,
            code: "SAFETY_EXECUTION_FAILED",
          }),
        );
      });
  }

  private recordSafetyAction(
    decision: L0SafetyDecision,
    action: L0SafetyAction,
    result: L0SafetyActionResult,
  ): void {
    const completedAt = this.now().toISOString();
    this.safetyStatus = {
      ...this.safetyStatus,
      lastAction: {
        kind: action.kind,
        outcome: result.outcome,
        completedAt,
        errorCode: result.errorCode,
      },
    };
    this.metrics.increment("bot_safety_actions_total", {
      action: action.kind,
      bot_id: this.profile.botId,
      outcome: result.outcome,
    });
    if (result.outcome === "failed") {
      this.metrics.increment("bot_safety_failures_total", {
        action: action.kind,
        bot_id: this.profile.botId,
      });
    }
    const log = result.outcome === "executed"
      ? this.dependencies.logger.info.bind(this.dependencies.logger)
      : this.dependencies.logger.warn.bind(this.dependencies.logger);
    log("l0_safety_action_result", this.logFields({
      decisionId: decision.decisionId,
      riskCode: action.risk,
      actionKind: action.kind,
      outcome: result.outcome,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    }));
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
    this.metrics.increment("bot_heartbeats_total", {
      bot_id: this.profile.botId,
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
      this.dependencies.logger.error("bot_runtime_message_sink_failed", this.logFields({
        messageType: validated.type,
      }, validated.traceId));
    });
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private logFields(
    fields: Readonly<Record<string, unknown>> = {},
    traceId = this.traceId,
  ): Readonly<Record<string, unknown>> {
    return {
      traceId,
      taskId: null,
      botId: this.profile.botId,
      skillId: null,
      modelName: null,
      ...fields,
    };
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
