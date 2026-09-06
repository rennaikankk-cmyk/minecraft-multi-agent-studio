import type { BotConnectionState, BotPosition } from "./runtime-types.js";
import type { ServerProfile } from "./server-profile.js";
import type { MinecraftVersionCompatibility } from "@minecraft-studio/protocol";
import type {
  L0SafetyAction,
  L0SafetyActionResult,
} from "@minecraft-studio/safety";
import type {
  SkillCapabilityRequest,
  SkillCompatibilityEnvironment,
} from "@minecraft-studio/skills";
import type {
  BehaviorSignalEvent,
  FamilyWindowStats,
} from "@minecraft-studio/skills";
import type { WorldStateSnapshot, WorldStateStore } from "./world-state.js";
import type {
  CombatActionAcknowledgement,
  CombatDriverObservation,
  CombatPrimitiveAction,
} from "./combat-driver.js";

export type BotClientSnapshot = {
  health: { current: number; maximum: number | null };
  food: { level: number; saturation: number };
  armorPoints: number | null;
  armorSlots: { head: string | null; chest: string | null; legs: string | null; feet: string | null };
  inventory: readonly Readonly<{
    itemName: string;
    count: number;
    /** 工具类物品的耐久读数；非耐久物品省略。 */
    durability?: number;
    maxDurability?: number;
  }>[];
  position: BotPosition;
  latencyMs: number | null;
  safety: {
    oxygenLevel: number | null;
    inWater: boolean;
    inLava: boolean;
    onGround: boolean;
    velocityY: number | null;
    inventory: { usedSlots: number; totalSlots: number };
    hasSafeFood: boolean;
    movementRequested: boolean;
  };
};

/** 兼容层（Round 7）信号快照：bounded 事件列表 + 每 ActionFamily 窗口统计。 */
export type CompatSignalsSnapshot = Readonly<{
  stats: Readonly<{ buffered: number; dropped: number }>;
  events: readonly BehaviorSignalEvent[];
  familyStats: Readonly<Record<string, FamilyWindowStats>>;
}>;

export type BotDisconnectInfo = {
  reason:
    | "requested_stop"
    | "server_shutdown"
    | "kicked"
    | "network_error"
    | "authentication_error"
    | "runtime_error"
    | "unknown";
  expected: boolean;
  detail?: string;
  /** kick 发生阶段（SERVER_KICK 结构化证据字段）。 */
  phase?: "PRE_LOGIN" | "POST_LOGIN" | "POST_SPAWN";
};

export type BotDamageInfo = Readonly<{
  previousHealth: number;
  currentHealth: number;
}>;

/** 死亡事实：世界侧最后已知位置与时间。恢复决策由 runtime/director 做。 */
export type BotChatMessage = Readonly<{
  speaker: string;
  message: string;
}>;

export type BotDeathInfo = Readonly<{
  position: Readonly<{ x: number; y: number; z: number }> | null;
  dimension: string | null;
  /**
   * 2026-09-03 门禁 3：死亡时刻的背包快照（含盔甲/副手槽）。死亡后背包
   * 被清空——掉落物评估必须在 death 事件当场抓，不能用重生后的空背包。
   */
  droppedItems?: ReadonlyArray<Readonly<{ itemId: string; count: number }>>;
  /** 死亡时刻的 XP 点数。 */
  xpPoints?: number;
}>;

export type BotRecoveryAction = Readonly<{
  kind: "local-unstick" | "local-replan";
  trigger: "stuck" | "no-progress" | "loop" | "oscillation" | "deadline-exceeded";
  taskId: string;
  goalKey: string | null;
  durationMs: number;
}>;

export type BotRecoveryActionResult = Readonly<{
  outcome: "executed" | "skipped" | "failed";
  errorCode: string | null;
}>;

export type BotClientHandlers = {
  onSpawn: () => void;
  onStateChanged: () => void;
  onPhysicsTick?: () => void;
  onDamaged?: (info: BotDamageInfo) => void;
  onDeath?: (info: BotDeathInfo) => void;
  onChat?: (info: BotChatMessage) => void;
  onDisconnected: (info: BotDisconnectInfo) => void;
  onError: (error: Error) => void;
  onVersionUnsupported: () => void;
};

export interface BotClient {
  setHandlers(handlers: BotClientHandlers): void;
  /** Phase 3 测量面（可选）：高频事件→状态回调链的分段计时包装。 */
  setPerfSpanWrap?(wrap: (category: string, fn: () => void) => void): void;
  /** Phase 4 测量面（可选）：客户端内部子段计时记录器。 */
  setPerfRecorder?(record: (category: string, durationMs: number, detail?: Readonly<Record<string, unknown>>) => void): void;
  snapshot(): BotClientSnapshot;
  executeSafetyAction(action: L0SafetyAction): Promise<L0SafetyActionResult>;
  /** Stop ordinary gathering/pathfinding before a higher-priority reaction. */
  interruptNormalActions?(): void;
  /** Optional for legacy/test clients; rich clients execute bounded P30 recovery. */
  executeRecoveryAction?(
    action: BotRecoveryAction,
  ): Promise<BotRecoveryActionResult>;
  invokeSkillCapability?(request: SkillCapabilityRequest): Promise<unknown>;
  /** Narrow deterministic combat boundary; absent means this client cannot fight. */
  combatObservation?(nowMs: number): CombatDriverObservation | null;
  /**
   * Round 7 兼容层信号快照（bounded 事件 + family 统计）。absent = 该 client
   * 不采集服务器行为信号（测试替身/遗留 client），调用方按无信号处理。
   */
  compatSignals?(): CompatSignalsSnapshot;
  executeCombatAction?(
    action: CombatPrimitiveAction,
    signal: AbortSignal,
  ): Promise<CombatActionAcknowledgement>;
  resetCombat?(): void;
  setPursuitCombat?(combat: import("./pursuit-controller.js").PursuitCombat): void;
  setCombatClock?(clock: () => number): void;
  versionCompatibility(): MinecraftVersionCompatibility;
  skillCompatibilityEnvironment(): SkillCompatibilityEnvironment;
  /** Optional richer event-driven snapshot. Legacy test clients may omit it. */
  worldStateSnapshot?(): WorldStateSnapshot;
  /** Cheap identity/freshness key of the shared asynchronous source. */
  worldStateSnapshotKey?(): string;
  close(gracePeriodMs: number): Promise<void>;
}

/**
 * The runtime owns the authoritative WorldStateStore. Rich clients must use
 * the supplied store for both telemetry snapshots and inventory readback so
 * one observation cannot acquire two unrelated versions.
 */
export type BotClientFactory = (
  profile: ServerProfile,
  worldState: WorldStateStore,
) => BotClient;

export type RuntimeState = BotConnectionState;
