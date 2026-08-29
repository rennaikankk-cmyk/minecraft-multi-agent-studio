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
}>;

export type BotRecoveryAction = Readonly<{
  kind: "local-unstick" | "local-replan";
  trigger: "stuck" | "no-progress" | "loop";
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
  onDamaged?: (info: BotDamageInfo) => void;
  onDeath?: (info: BotDeathInfo) => void;
  onChat?: (info: BotChatMessage) => void;
  onDisconnected: (info: BotDisconnectInfo) => void;
  onError: (error: Error) => void;
  onVersionUnsupported: () => void;
};

export interface BotClient {
  setHandlers(handlers: BotClientHandlers): void;
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
  executeCombatAction?(
    action: CombatPrimitiveAction,
    signal: AbortSignal,
  ): Promise<CombatActionAcknowledgement>;
  resetCombat?(): void;
  setCombatClock?(clock: () => number): void;
  versionCompatibility(): MinecraftVersionCompatibility;
  skillCompatibilityEnvironment(): SkillCompatibilityEnvironment;
  /** Optional richer event-driven snapshot. Legacy test clients may omit it. */
  worldStateSnapshot?(): WorldStateSnapshot;
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
