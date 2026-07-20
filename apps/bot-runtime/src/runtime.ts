import { randomUUID } from "node:crypto";

import {
  botDisconnectedV1Schema,
  botHeartbeatV1Schema,
  botStatusV1Schema,
  parseBotTelemetryMessage,
  type BotDisconnectedV1,
  type BotHeartbeatV1,
  type BotStatusV1,
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

type TimerHandle = ReturnType<typeof setTimeout>;

export type RuntimeDependencies = {
  createClient: BotClientFactory;
  messageSink: BotMessageSink;
  logger: RuntimeLogger;
  now?: () => Date;
  randomId?: () => string;
};

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

  start(): void {
    if (this.state !== "offline" || this.client || this.reconnectTimer) {
      throw new Error("Bot Runtime has already been started.");
    }
    this.stopping = false;
    this.reconnectAttempts = 0;
    this.connect();
  }

  async stop(reason = "operator_request"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.clearTimer("reconnect");
    this.clearTimer("status");
    this.clearTimer("deferredStatus");

    const activeClient = this.client;
    const activeGeneration = this.generation;
    if (!activeClient) {
      this.clearTimer("heartbeat");
      this.state = "offline";
      return;
    }

    this.state = "stopping";
    this.emitHeartbeat();
    this.dependencies.logger.info("bot_runtime_stop_requested", {
      botId: this.profile.botId,
      reason,
    });

    try {
      await activeClient.close(this.profile.stopGracePeriodMs);
    } catch {
      this.dependencies.logger.error("bot_runtime_close_failed", {
        botId: this.profile.botId,
      });
    }

    if (this.client === activeClient) {
      this.handleDisconnected(activeGeneration, {
        reason: "requested_stop",
        expected: true,
      });
    }
  }

  private connect(): void {
    this.generation += 1;
    const activeGeneration = this.generation;
    this.traceId = `connection-${this.randomId()}`;
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
    this.state = "online";
    this.reconnectAttempts = 0;
    this.startStatusTimer(generation);
    this.emitStatus(generation);
    this.emitHeartbeat();
    this.dependencies.logger.info("bot_runtime_online", {
      botId: this.profile.botId,
      serverProfileId: this.profile.id,
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

    if (!this.stopping) this.scheduleReconnect();
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
