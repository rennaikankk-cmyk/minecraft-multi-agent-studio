import {
  parseBotStopResult,
  parseBotTelemetryMessage,
  type BotDisconnectedV1,
  type BotStatusV1,
  type BotStopResultV1,
  type BotTelemetryMessageV1,
  type MinecraftVersionCompatibility,
} from "@minecraft-studio/protocol";

export type RegistryConnectionState =
  BotStatusV1["payload"]["connectionState"];

export type BotRegistryRecord = Readonly<{
  botId: string;
  serverProfileId: string;
  runtimeInstanceId: string;
  connectionState: RegistryConnectionState;
  lastSequence: number;
  lastObservedAt: string;
  lastMessageAt: string;
  lastHeartbeatAt: string | null;
  lastStatusAt: string | null;
  currentStatus: BotStatusV1["payload"] | null;
  minecraftVersion: MinecraftVersionCompatibility | null;
  offlineReason: BotDisconnectedV1["payload"]["reason"] | null;
}>;

export type TelemetryIgnoreReason =
  | "duplicate_message"
  | "duplicate_sequence"
  | "out_of_order"
  | "retired_runtime"
  | "older_runtime_start";

export type TelemetryIngestResult = Readonly<{
  accepted: boolean;
  reason: "accepted" | TelemetryIgnoreReason;
  record: BotRegistryRecord;
}>;

export type BotRegistryListener = (record: BotRegistryRecord) => void;

export type CoordinatorTelemetryErrorCode =
  | "MESSAGE_INVALID"
  | "SOURCE_NOT_ALLOWED"
  | "SOURCE_INSTANCE_MISMATCH"
  | "MESSAGE_FROM_FUTURE"
  | "SERVER_PROFILE_MISMATCH"
  | "CLOCK_INVALID";

export class CoordinatorTelemetryError extends Error {
  readonly code: CoordinatorTelemetryErrorCode;

  constructor(code: CoordinatorTelemetryErrorCode, message: string) {
    super(message);
    this.name = "CoordinatorTelemetryError";
    this.code = code;
  }
}

type InternalRecord = {
  botId: string;
  serverProfileId: string;
  runtimeInstanceId: string;
  connectionState: RegistryConnectionState;
  lastSequence: number;
  lastObservedAt: string;
  lastObservedMs: number;
  lastMessageAt: string;
  lastLivenessMs: number;
  lastHeartbeatAt: string | null;
  lastStatusAt: string | null;
  currentStatus: BotStatusV1["payload"] | null;
  minecraftVersion: MinecraftVersionCompatibility | null;
  offlineReason: BotDisconnectedV1["payload"]["reason"] | null;
  retiredRuntimeIds: Set<string>;
  retiredRuntimeOrder: string[];
};

export type BotRegistryOptions = Readonly<{
  staleAfterMs: number;
  maxClockSkewMs?: number;
  maxSeenMessageIds?: number;
  maxRetiredRuntimeIds?: number;
  now?: () => Date;
}>;

export class BotRegistry {
  private readonly records = new Map<string, InternalRecord>();
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageOrder: string[] = [];
  private readonly listeners = new Set<BotRegistryListener>();
  private readonly now: () => Date;
  private readonly staleAfterMs: number;
  private readonly maxClockSkewMs: number;
  private readonly maxSeenMessageIds: number;
  private readonly maxRetiredRuntimeIds: number;

  constructor(options: BotRegistryOptions) {
    this.staleAfterMs = positiveInteger(options.staleAfterMs, "staleAfterMs");
    this.maxClockSkewMs = nonnegativeInteger(
      options.maxClockSkewMs ?? 30_000,
      "maxClockSkewMs",
    );
    this.maxSeenMessageIds = positiveInteger(
      options.maxSeenMessageIds ?? 10_000,
      "maxSeenMessageIds",
    );
    this.maxRetiredRuntimeIds = positiveInteger(
      options.maxRetiredRuntimeIds ?? 32,
      "maxRetiredRuntimeIds",
    );
    this.now = options.now ?? (() => new Date());
  }

  ingest(input: unknown, receivedAt = this.now()): TelemetryIngestResult {
    const receivedMs = validTime(receivedAt);
    let message: BotTelemetryMessageV1;
    try {
      message = parseBotTelemetryMessage(input);
    } catch (cause) {
      throw new CoordinatorTelemetryError(
        "MESSAGE_INVALID",
        "Coordinator rejected an invalid Bot telemetry message.",
      );
    }

    if (message.source.service !== "bot-runtime") {
      throw new CoordinatorTelemetryError(
        "SOURCE_NOT_ALLOWED",
        "Bot telemetry must originate from Bot Runtime.",
      );
    }
    if (message.source.instanceId !== message.payload.runtimeInstanceId) {
      throw new CoordinatorTelemetryError(
        "SOURCE_INSTANCE_MISMATCH",
        "Telemetry source and runtime instance do not match.",
      );
    }

    const observedMs = Date.parse(message.payload.observedAt);
    const envelopeMs = Date.parse(message.timestamp);
    if (
      observedMs > receivedMs + this.maxClockSkewMs ||
      envelopeMs > receivedMs + this.maxClockSkewMs
    ) {
      throw new CoordinatorTelemetryError(
        "MESSAGE_FROM_FUTURE",
        "Coordinator rejected telemetry outside the allowed clock skew.",
      );
    }

    const existing = this.records.get(message.botId);
    if (this.seenMessageIds.has(message.messageId)) {
      if (!existing) {
        throw new CoordinatorTelemetryError(
          "MESSAGE_INVALID",
          "A duplicate message ID has no corresponding registry record.",
        );
      }
      return this.ignored(existing, "duplicate_message", receivedMs);
    }
    this.rememberMessageId(message.messageId);

    const record = existing ?? this.createRecord(message, receivedMs, observedMs);
    if (!existing) this.records.set(message.botId, record);

    if (record.runtimeInstanceId !== message.payload.runtimeInstanceId) {
      if (record.retiredRuntimeIds.has(message.payload.runtimeInstanceId)) {
        return this.ignored(record, "retired_runtime", receivedMs);
      }
      if (observedMs <= record.lastObservedMs) {
        return this.ignored(record, "older_runtime_start", receivedMs);
      }
      this.retireRuntime(record, record.runtimeInstanceId);
      record.runtimeInstanceId = message.payload.runtimeInstanceId;
      record.serverProfileId = message.payload.serverProfileId;
      record.lastSequence = -1;
      record.lastHeartbeatAt = null;
      record.lastStatusAt = null;
      record.currentStatus = null;
      record.minecraftVersion = null;
      record.offlineReason = null;
    } else if (record.serverProfileId !== message.payload.serverProfileId) {
      throw new CoordinatorTelemetryError(
        "SERVER_PROFILE_MISMATCH",
        "One runtime instance cannot change its server profile identity.",
      );
    }

    if (message.payload.sequence < record.lastSequence) {
      return this.ignored(record, "out_of_order", receivedMs);
    }
    if (message.payload.sequence === record.lastSequence) {
      return this.ignored(record, "duplicate_sequence", receivedMs);
    }

    record.lastSequence = message.payload.sequence;
    record.lastObservedMs = Math.max(record.lastObservedMs, observedMs);
    record.lastObservedAt = new Date(record.lastObservedMs).toISOString();
    record.lastMessageAt = new Date(receivedMs).toISOString();
    record.lastLivenessMs = receivedMs;

    if (message.type === "bot.status.v1") {
      record.connectionState = message.payload.connectionState;
      record.lastStatusAt = record.lastMessageAt;
      record.currentStatus = structuredClone(message.payload);
      if (message.payload.minecraftVersion) {
        record.minecraftVersion = structuredClone(
          message.payload.minecraftVersion,
        );
      }
      record.offlineReason = null;
    } else if (message.type === "bot.heartbeat.v1") {
      record.connectionState = message.payload.connectionState;
      record.lastHeartbeatAt = record.lastMessageAt;
      if (message.payload.connectionState !== "offline") {
        record.offlineReason = null;
      }
    } else if (message.type === "bot.version.v1") {
      record.minecraftVersion = structuredClone(message.payload.compatibility);
    } else {
      record.connectionState = "offline";
      record.offlineReason = message.payload.reason;
    }

    this.notify(record);

    return {
      accepted: true,
      reason: "accepted",
      record: snapshot(record),
    };
  }

  confirmStop(input: unknown, receivedAt = this.now()): boolean {
    const receivedMs = validTime(receivedAt);
    let result: BotStopResultV1;
    try {
      result = parseBotStopResult(input);
    } catch {
      throw new CoordinatorTelemetryError(
        "MESSAGE_INVALID",
        "Coordinator rejected an invalid Bot stop result.",
      );
    }
    const record = this.records.get(result.botId);
    if (
      !record ||
      result.payload.outcome !== "completed" ||
      result.payload.runtimeInstanceId !== record.runtimeInstanceId
    ) {
      return false;
    }
    record.connectionState = "offline";
    record.offlineReason = "requested_stop";
    record.lastMessageAt = new Date(receivedMs).toISOString();
    record.lastLivenessMs = receivedMs;
    this.notify(record);
    return true;
  }

  subscribe(listener: BotRegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(botId: string, at = this.now()): BotRegistryRecord | null {
    const atMs = validTime(at);
    const record = this.records.get(botId);
    if (!record) return null;
    this.applyStaleness(record, atMs);
    return snapshot(record);
  }

  list(at = this.now()): BotRegistryRecord[] {
    const atMs = validTime(at);
    return [...this.records.values()]
      .map((record) => {
        this.applyStaleness(record, atMs);
        return snapshot(record);
      })
      .sort((left, right) => left.botId.localeCompare(right.botId));
  }

  sweepStale(at = this.now()): number {
    const atMs = validTime(at);
    let changed = 0;
    for (const record of this.records.values()) {
      if (this.applyStaleness(record, atMs)) changed += 1;
    }
    return changed;
  }

  private createRecord(
    message: BotTelemetryMessageV1,
    receivedMs: number,
    observedMs: number,
  ): InternalRecord {
    return {
      botId: message.botId,
      serverProfileId: message.payload.serverProfileId,
      runtimeInstanceId: message.payload.runtimeInstanceId,
      connectionState: "offline",
      lastSequence: -1,
      lastObservedAt: new Date(observedMs).toISOString(),
      lastObservedMs: observedMs,
      lastMessageAt: new Date(receivedMs).toISOString(),
      lastLivenessMs: receivedMs,
      lastHeartbeatAt: null,
      lastStatusAt: null,
      currentStatus: null,
      minecraftVersion: null,
      offlineReason: null,
      retiredRuntimeIds: new Set<string>(),
      retiredRuntimeOrder: [],
    };
  }

  private ignored(
    record: InternalRecord,
    reason: TelemetryIgnoreReason,
    atMs: number,
  ): TelemetryIngestResult {
    this.applyStaleness(record, atMs);
    return { accepted: false, reason, record: snapshot(record) };
  }

  private applyStaleness(record: InternalRecord, atMs: number): boolean {
    if (
      record.connectionState !== "offline" &&
      record.connectionState !== "stale" &&
      atMs - record.lastLivenessMs > this.staleAfterMs
    ) {
      record.connectionState = "stale";
      this.notify(record);
      return true;
    }
    return false;
  }

  private rememberMessageId(messageId: string): void {
    this.seenMessageIds.add(messageId);
    this.seenMessageOrder.push(messageId);
    while (this.seenMessageOrder.length > this.maxSeenMessageIds) {
      const oldest = this.seenMessageOrder.shift();
      if (oldest) this.seenMessageIds.delete(oldest);
    }
  }

  private retireRuntime(record: InternalRecord, runtimeInstanceId: string): void {
    record.retiredRuntimeIds.add(runtimeInstanceId);
    record.retiredRuntimeOrder.push(runtimeInstanceId);
    while (record.retiredRuntimeOrder.length > this.maxRetiredRuntimeIds) {
      const oldest = record.retiredRuntimeOrder.shift();
      if (oldest) record.retiredRuntimeIds.delete(oldest);
    }
  }

  private notify(record: InternalRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot(record));
      } catch {
        // A presentation subscriber cannot break the authoritative registry.
      }
    }
  }
}

function snapshot(record: InternalRecord): BotRegistryRecord {
  return {
    botId: record.botId,
    serverProfileId: record.serverProfileId,
    runtimeInstanceId: record.runtimeInstanceId,
    connectionState: record.connectionState,
    lastSequence: record.lastSequence,
    lastObservedAt: record.lastObservedAt,
    lastMessageAt: record.lastMessageAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
    lastStatusAt: record.lastStatusAt,
    currentStatus: record.currentStatus
      ? structuredClone(record.currentStatus)
      : null,
    minecraftVersion: record.minecraftVersion
      ? structuredClone(record.minecraftVersion)
      : null,
    offlineReason: record.offlineReason,
  };
}

function validTime(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new CoordinatorTelemetryError(
      "CLOCK_INVALID",
      "Coordinator received an invalid clock value.",
    );
  }
  return milliseconds;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer.`);
  }
  return value;
}
