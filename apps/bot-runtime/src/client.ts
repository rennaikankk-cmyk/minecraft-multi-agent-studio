import type { BotConnectionState, BotPosition } from "./runtime-types.js";
import type { ServerProfile } from "./server-profile.js";

export type BotClientSnapshot = {
  health: { current: number; maximum: number | null };
  food: { level: number; saturation: number };
  armorPoints: number | null;
  position: BotPosition;
  latencyMs: number | null;
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
};

export interface BotClient {
  setHandlers(handlers: BotClientHandlers): void;
  snapshot(): BotClientSnapshot;
  close(gracePeriodMs: number): Promise<void>;
}

export type BotClientFactory = (profile: ServerProfile) => BotClient;

export type RuntimeState = BotConnectionState;
