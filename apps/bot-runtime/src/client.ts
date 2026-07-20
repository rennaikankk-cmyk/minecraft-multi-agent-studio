import type { BotConnectionState, BotPosition } from "./runtime-types.js";
import type { ServerProfile } from "./server-profile.js";
import type { MinecraftVersionCompatibility } from "@minecraft-studio/protocol";
import type {
  L0SafetyAction,
  L0SafetyActionResult,
} from "@minecraft-studio/safety";

export type BotClientSnapshot = {
  health: { current: number; maximum: number | null };
  food: { level: number; saturation: number };
  armorPoints: number | null;
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

export type BotClientHandlers = {
  onSpawn: () => void;
  onStateChanged: () => void;
  onDisconnected: (info: BotDisconnectInfo) => void;
  onError: (error: Error) => void;
  onVersionUnsupported: () => void;
};

export interface BotClient {
  setHandlers(handlers: BotClientHandlers): void;
  snapshot(): BotClientSnapshot;
  executeSafetyAction(action: L0SafetyAction): Promise<L0SafetyActionResult>;
  versionCompatibility(): MinecraftVersionCompatibility;
  close(gracePeriodMs: number): Promise<void>;
}

export type BotClientFactory = (profile: ServerProfile) => BotClient;

export type RuntimeState = BotConnectionState;
