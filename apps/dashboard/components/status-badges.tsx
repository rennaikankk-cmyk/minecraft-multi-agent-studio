// ---------------------------------------------------------------------------
// 统一状态组件 + 纯分类函数（三十四节：不要每页自己画状态）
//
// 原则：状态不只靠颜色（附文字标签）；分类逻辑是纯函数，单元测试覆盖。
// 后端只有 6 态 connection（connecting/online/stale/offline/stopping/error）
// —— 细粒度登录态机（WAITING_SPAWN 等）是后端 NOT IMPLEMENTED，前端不伪造。
// ---------------------------------------------------------------------------

export type BadgeTone = "ok" | "warn" | "bad" | "muted" | "info";

export type BotConnectionState =
  | "connecting"
  | "online"
  | "stale"
  | "offline"
  | "stopping"
  | "error";

export type BotProcessState = "starting" | "running" | "stopping" | "stopped" | "error";

/** 连接态 → 展示语义（CONNECTED ≠ READY：online 仅代表协议在线）。 */
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

/** Facility slot 7 态 → 展示语义（与后端 TRANSITIONS 一一对应）。 */
export type FacilitySlotStatus =
  | "planned"
  | "placement_reserved"
  | "occupied"
  | "missing"
  | "temporarily_blocked"
  | "invalid"
  | "unknown";

export function facilitySlotTone(status: string): BadgeTone {
  switch (status as FacilitySlotStatus) {
    case "occupied": return "ok";
    case "planned": return "muted";
    case "placement_reserved": return "info";
    case "missing": return "bad";
    case "temporarily_blocked": return "warn";
    case "invalid": return "bad";
    default: return "warn"; // unknown 及一切非预期值
  }
}

export function facilitySlotLabel(status: string): string {
  const known: readonly string[] = [
    "planned", "placement_reserved", "occupied", "missing",
    "temporarily_blocked", "invalid", "unknown",
  ];
  return known.includes(status) ? status.toUpperCase() : `UNKNOWN(${status})`;
}

/** Base lifecycle → 展示语义。 */
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

function toneClass(tone: BadgeTone): string {
  return `badge badge-${tone}`;
}

export function StatusBadge({ tone, children, title }: { tone: BadgeTone; children: React.ReactNode; title?: string }) {
  return (
    <span className={toneClass(tone)} title={title}>
      {children}
    </span>
  );
}

export function ConnectionStateBadge({ state, title }: { state: BotConnectionState; title?: string }) {
  return (
    <StatusBadge tone={connectionTone(state)} title={title ?? `connection=${state}`}>
      {connectionLabel(state)}
    </StatusBadge>
  );
}

export function ProcessStateBadge({ state }: { state: BotProcessState }) {
  const tone = processTone(state);
  return <StatusBadge tone={tone}>{state.toUpperCase()}</StatusBadge>;
}

export function FacilitySlotBadge({ status }: { status: string }) {
  return (
    <StatusBadge tone={facilitySlotTone(status)} title={`slot=${status}`}>
      {facilitySlotLabel(status)}
    </StatusBadge>
  );
}

export function BaseStatusBadge({ status }: { status: string }) {
  return <StatusBadge tone={baseStatusTone(status)}>{status.toUpperCase()}</StatusBadge>;
}

/** 实时连接状态（三十五节）：LIVE / RECONNECTING / DISCONNECTED / STALE。 */
export type StreamHealth = "live" | "reconnecting" | "disconnected" | "stale";

export function streamHealthTone(health: StreamHealth): BadgeTone {
  switch (health) {
    case "live": return "ok";
    case "reconnecting": return "info";
    case "stale": return "warn";
    case "disconnected": return "bad";
  }
}

export function StaleBadge({ sinceMs }: { sinceMs: number }) {
  const age = Math.max(0, Date.now() - sinceMs);
  const seconds = Math.round(age / 1000);
  return (
    <StatusBadge tone="warn" title="数据已超过新鲜阈值">
      STALE {seconds}s
    </StatusBadge>
  );
}
