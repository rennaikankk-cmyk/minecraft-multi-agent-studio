import {
  parseBotStopResult,
  parseBotTelemetryMessage,
  verifyChatIdentity,
  type ChatIdentityPolicy,
  type ChatIdentityEvidence,
  type BotDisconnectedV1,
  type BotSkillCatalogV1,
  type BotStatusV1,
  type BotStopResultV1,
  type BotTelemetryMessageV1,
  type BotWorldStateV1,
  type MinecraftVersionCompatibility,
} from "@minecraft-studio/protocol";
import { PersonalMemoryError, type PersonalMemoryStore } from "./personal-memory-store.js";

export type RegistryConnectionState =
  BotStatusV1["payload"]["connectionState"];

export type BotRegistryWorldState = Readonly<
  BotWorldStateV1["payload"] & {
    /** Registry alias used by execution freshness guards. */
    version: number;
  }
>;

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
  lastWorldStateAt: string | null;
  currentStatus: BotStatusV1["payload"] | null;
  worldState: BotRegistryWorldState | null;
  minecraftVersion: MinecraftVersionCompatibility | null;
  skillCatalog: BotSkillCatalogV1["payload"] | null;
  offlineReason: BotDisconnectedV1["payload"]["reason"] | null;
}>;

export type TelemetryIgnoreReason =
  | "duplicate_message"
  | "duplicate_sequence"
  | "out_of_order"
  | "retired_runtime"
  | "older_runtime_start"
  | "untrusted_chat";

export type TelemetryIngestResult = Readonly<{
  accepted: boolean;
  reason: "accepted" | TelemetryIgnoreReason;
  record: BotRegistryRecord;
}>;

export type BotRegistryChatEvent = Readonly<{
  kind: "chat";
  speaker: string;
  message: string;
  messageId: string;
  timestamp: string;
  identity: ChatIdentityEvidence;
}>;

export type BotRegistryListener = (
  record: BotRegistryRecord,
  event?: BotRegistryChatEvent,
) => void;

export type CoordinatorTelemetryErrorCode =
  | "MESSAGE_INVALID"
  | "SOURCE_NOT_ALLOWED"
  | "SOURCE_INSTANCE_MISMATCH"
  | "MESSAGE_FROM_FUTURE"
  | "SERVER_PROFILE_MISMATCH"
  | "WORLD_ID_MISMATCH"
  | "PERSONAL_MEMORY_READ_FAILED"
  | "PERSONAL_MEMORY_WRITE_FAILED"
  | "CLOCK_INVALID";

export class CoordinatorTelemetryError extends Error {
  readonly code: CoordinatorTelemetryErrorCode;

  constructor(code: CoordinatorTelemetryErrorCode, message: string) {
    super(message);
    this.name = "CoordinatorTelemetryError";
    this.code = code;
  }
}

function versionFactsConflict(
  left: MinecraftVersionCompatibility,
  right: MinecraftVersionCompatibility,
): boolean {
  return (
    left.resolvedVersion !== right.resolvedVersion ||
    (left.protocolVersion != null &&
      right.protocolVersion != null &&
      left.protocolVersion !== right.protocolVersion) ||
    (left.majorVersion != null &&
      right.majorVersion != null &&
      left.majorVersion !== right.majorVersion)
  );
}

function versionCatalogConflict(
  version: MinecraftVersionCompatibility,
  catalog: BotSkillCatalogV1["payload"],
): boolean {
  return (
    version.resolvedVersion !== catalog.minecraftVersion ||
    (version.protocolVersion != null &&
      version.protocolVersion !== catalog.protocolVersion)
  );
}

/** goal_execution_ready 判据（Round 6.6 单一定义；纯函数可单测）。 */
export function botGoalExecutionReady(
  record: Readonly<
    Pick<BotRegistryRecord, "connectionState" | "currentStatus" | "skillCatalog">
  >,
): boolean {
  return (
    record.connectionState === "online" &&
    record.currentStatus !== null &&
    record.skillCatalog !== null
  );
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
  lastWorldStateAt: string | null;
  currentStatus: BotStatusV1["payload"] | null;
  worldState: BotRegistryWorldState | null;
  minecraftVersion: MinecraftVersionCompatibility | null;
  skillCatalog: BotSkillCatalogV1["payload"] | null;
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
  personalMemory?: PersonalMemoryStore;
  chatTrustPolicies?: readonly ChatIdentityPolicy[];
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

  constructor(private readonly options: BotRegistryOptions) {
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

    // 聊天上行是事件不是状态：无 observedAt/sequence，走独立轻路径——
    // 只做时钟偏移校验与白名单分发，不触碰连接状态机与序列号。
    if (message.type === "bot.chat-received.v1") {
      const chatEnvelopeMs = Date.parse(message.timestamp);
      if (chatEnvelopeMs > receivedMs + this.maxClockSkewMs) {
        throw new CoordinatorTelemetryError(
          "MESSAGE_FROM_FUTURE",
          "Coordinator rejected chat outside the allowed clock skew.",
        );
      }
      const chatRecord = this.records.get(message.botId);
      if (!chatRecord) {
        // 未知 bot 的聊天：没有可归属的记录，按 ignored 处理而不是抛错。
        return {
          accepted: false,
          reason: "out_of_order",
          record: this.fallbackRecord(message.botId, message, receivedMs),
        };
      }
      if (this.seenMessageIds.has(message.messageId)) {
        return { accepted: false, reason: "duplicate_message", record: snapshot(chatRecord) };
      }
      if (chatRecord.runtimeInstanceId !== message.payload.runtimeInstanceId) {
        return { accepted: false, reason: "retired_runtime", record: snapshot(chatRecord) };
      }
      const identity = message.payload.identity;
      const policy = this.options.chatTrustPolicies?.find((p) =>
        p.serverProfileId === chatRecord.serverProfileId && p.worldId === (chatRecord.currentStatus?.personalContext?.worldId ?? null)) ?? null;
      if (message.payload.serverProfileId !== chatRecord.serverProfileId ||
          chatRecord.connectionState !== "online" || !identity ||
          identity.dimension !== chatRecord.currentStatus?.position.dimension ||
          identity.worldId !== (chatRecord.currentStatus?.personalContext?.worldId ?? null) ||
          receivedMs - chatEnvelopeMs > this.maxClockSkewMs ||
          !verifyChatIdentity({ serverProfileId: chatRecord.serverProfileId,
            speaker: message.payload.speaker, evidence: identity, policy })) {
        return { accepted: false, reason: "untrusted_chat", record: snapshot(chatRecord) };
      }
      this.rememberMessageId(message.messageId);
      this.notifyChat(chatRecord, { kind: "chat", speaker: message.payload.speaker,
        message: message.payload.message, messageId: message.messageId, timestamp: message.timestamp, identity });
      return { accepted: true, reason: "accepted", record: snapshot(chatRecord) };
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
    if (
      existing &&
      existing.runtimeInstanceId === message.payload.runtimeInstanceId &&
      message.payload.sequence > existing.lastSequence
    ) {
      this.assertVersionConsistency(existing, message);
    }
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
      record.lastWorldStateAt = null;
      record.currentStatus = null;
      record.worldState = null;
      record.minecraftVersion = null;
      record.skillCatalog = null;
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

    // Commit private observations before acknowledging telemetry. A disk failure
    // remains retryable, without caching the message ID as successfully ingested.
    if (message.type === "bot.status.v1") {
      try { this.options.personalMemory?.observeStatus(message); }
      catch (error) {
        if (error instanceof PersonalMemoryError) throw new CoordinatorTelemetryError(error.code, error.code);
        throw error;
      }
    }
    this.rememberMessageId(message.messageId);
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
    } else if (message.type === "bot.skill-catalog.v1") {
      record.skillCatalog = structuredClone(message.payload);
    } else if (message.type === "bot.world-state.v1") {
      record.lastWorldStateAt = record.lastMessageAt;
      record.worldState = {
        ...structuredClone(message.payload),
        version: message.payload.worldStateVersion,
      };
    } else if (message.type === "bot.disconnected.v1") {
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

  private assertVersionConsistency(
    record: InternalRecord,
    message: BotTelemetryMessageV1,
  ): void {
    if (message.type === "bot.status.v1" && record.currentStatus &&
      (record.currentStatus.personalContext?.worldId ?? null) !== (message.payload.personalContext?.worldId ?? null)) {
      throw new CoordinatorTelemetryError("WORLD_ID_MISMATCH", "One runtime instance cannot change its world generation identity.");
    }
    const incomingVersion = message.type === "bot.version.v1"
      ? message.payload.compatibility
      : message.type === "bot.status.v1"
        ? (message.payload.minecraftVersion ?? null)
        : null;
    if (
      incomingVersion &&
      ((record.minecraftVersion &&
        versionFactsConflict(record.minecraftVersion, incomingVersion)) ||
        (record.skillCatalog &&
          versionCatalogConflict(incomingVersion, record.skillCatalog)))
    ) {
      throw new CoordinatorTelemetryError(
        "MESSAGE_INVALID",
        "Version telemetry conflicts with the current runtime facts.",
      );
    }

    if (
      message.type === "bot.skill-catalog.v1" &&
      ((record.minecraftVersion &&
        versionCatalogConflict(record.minecraftVersion, message.payload)) ||
        (record.skillCatalog &&
          (record.skillCatalog.minecraftVersion !==
            message.payload.minecraftVersion ||
            record.skillCatalog.protocolVersion !==
              message.payload.protocolVersion)))
    ) {
      throw new CoordinatorTelemetryError(
        "MESSAGE_INVALID",
        "Skill catalog conflicts with the current runtime facts.",
      );
    }
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

  /**
   * Round 6.6 注册屏障：goal_execution_ready 的**单一定义**（与 planner 的
   * requireAvailableBot 同一判据——online + 有 currentStatus + 有 skill
   * catalog）。所有调用方（goal 准入、调度唤醒、对外投影）禁止各自再推断。
   */
  goalExecutionReady(botId: string, at = this.now()): boolean {
    const record = this.get(botId, at);
    return record !== null && botGoalExecutionReady(record);
  }

  /**
   * 就绪翻沿回调（幂等：只在 ready 布尔翻转时触发；首见即 ready 也触发，
   * 覆盖"goal 先 park、bot 后注册"的主场景）。订阅者异常不破坏 registry。
   */
  onReadinessChange(handler: (botId: string, ready: boolean) => void): () => void {
    const lastReady = new Map<string, boolean>();
    return this.subscribe((record) => {
      const ready = botGoalExecutionReady(record);
      const previous = lastReady.get(record.botId);
      if (previous === ready) return;
      lastReady.set(record.botId, ready);
      if (previous === undefined && !ready) return;
      try {
        handler(record.botId, ready);
      } catch {
        // 订阅者故障不得影响权威 registry。
      }
    });
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

  /** Read-only projection: staleness is computed without notifying execution subscribers. */
  inspect(at = this.now()): BotRegistryRecord[] {
    const atMs = validTime(at);
    return [...this.records.values()].map((record) => ({
      ...snapshot(record),
      connectionState: record.connectionState !== "offline" && atMs - record.lastLivenessMs > this.staleAfterMs
        ? "stale" as const : record.connectionState,
    })).sort((a, b) => a.botId.localeCompare(b.botId));
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
      lastWorldStateAt: null,
      currentStatus: null,
      worldState: null,
      minecraftVersion: null,
      skillCatalog: null,
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

  private fallbackRecord(
    botId: string,
    message: BotTelemetryMessageV1,
    receivedMs: number,
  ): BotRegistryRecord {
    // 聊天来自未注册 bot：构造最小只读记录供结果类型对齐，状态全部 unknown。
    void botId;
    void message;
    void receivedMs;
    throw new CoordinatorTelemetryError(
      "MESSAGE_INVALID",
      "Chat arrived for an unregistered bot.",
    );
  }

  private notifyChat(
    record: InternalRecord,
    event: BotRegistryChatEvent,
  ): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot(record), event);
      } catch {
        // A presentation subscriber cannot break the authoritative registry.
      }
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
    lastWorldStateAt: record.lastWorldStateAt,
    currentStatus: record.currentStatus
      ? structuredClone(record.currentStatus)
      : null,
    worldState: record.worldState
      ? structuredClone(record.worldState)
      : null,
    minecraftVersion: record.minecraftVersion
      ? structuredClone(record.minecraftVersion)
      : null,
    skillCatalog: record.skillCatalog
      ? structuredClone(record.skillCatalog)
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
