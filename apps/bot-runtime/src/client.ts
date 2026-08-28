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
  CombatActionAcknowledgement,
  CombatDriverObservation,
  CombatPrimitiveAction,
} from "./combat-driver.js";

export type BotClientSnapshot = {
  health: { current: number; maximum: number | null };
  food: { level: number; saturation: number };
  armorPoints: number | null;
  inventory: readonly Readonly<{ itemName: string; count: number }>[];
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

export type BotClientHandlers = {
  onSpawn: () => void;
  onStateChanged: () => void;
  onDamaged?: (info: BotDamageInfo) => void;
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
  close(gracePeriodMs: number): Promise<void>;
}

export type BotClientFactory = (profile: ServerProfile) => BotClient;

export type RuntimeState = BotConnectionState;
