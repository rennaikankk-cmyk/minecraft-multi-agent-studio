// ---------------------------------------------------------------------------
// 状态徽章分类纯函数（从 status-badges.tsx 抽出，供组件与测试共用，无 JSX）
// ---------------------------------------------------------------------------
export type BadgeTone = "ok" | "warn" | "bad" | "muted" | "info";

export type BotConnectionState = "connecting" | "online" | "stale" | "offline" | "stopping" | "error";
export type BotProcessState = "starting" | "running" | "stopping" | "stopped" | "error";
export type FacilitySlotStatus = "planned" | "placement_reserved" | "occupied" | "missing" | "temporarily_blocked" | "invalid" | "unknown";
export type StreamHealth = "live" | "reconnecting" | "disconnected" | "stale";

export function connectionTone(state: BotConnectionState): BadgeTone {
  switch (state) {
    case "online": return "ok";
    case "connecting": return "info";
    case "stale": return "warn";
    case "stopping": return "muted";
    case "offline": return "muted";
    case "error": return "bad";
  }
}

export function connectionLabel(state: BotConnectionState): string {
  switch (state) {
    case "online": return "ONLINE";
    case "connecting": return "CONNECTING";
    case "stale": return "STALE";
    case "offline": return "OFFLINE";
    case "stopping": return "STOPPING";
    case "error": return "ERROR";
  }
}

export function processTone(state: BotProcessState): BadgeTone {
  switch (state) {
    case "running": return "ok";
    case "starting": return "info";
    case "stopping": return "muted";
    case "stopped": return "muted";
    case "error": return "bad";
  }
}

export function facilitySlotTone(status: string): BadgeTone {
  switch (status as FacilitySlotStatus) {
    case "occupied": return "ok";
    case "planned": return "muted";
    case "placement_reserved": return "info";
    case "missing": return "bad";
    case "temporarily_blocked": return "warn";
    case "invalid": return "bad";
    default: return "warn";
  }
}

export function facilitySlotLabel(status: string): string {
  const known: readonly string[] = [
    "planned", "placement_reserved", "occupied", "missing",
    "temporarily_blocked", "invalid", "unknown",
  ];
  return known.includes(status) ? status.toUpperCase() : `UNKNOWN(${status})`;
}

export function baseStatusTone(status: string): BadgeTone {
  switch (status) {
    case "operational": return "ok";
    case "building": return "info";
    case "planned": return "muted";
    case "damaged": return "bad";
    case "abandoned": return "muted";
    default: return "warn";
  }
}

export function streamHealthTone(health: StreamHealth): BadgeTone {
  switch (health) {
    case "live": return "ok";
    case "reconnecting": return "info";
    case "stale": return "warn";
    case "disconnected": return "bad";
  }
}
