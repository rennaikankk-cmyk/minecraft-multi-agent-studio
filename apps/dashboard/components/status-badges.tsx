// ---------------------------------------------------------------------------
// 统一状态组件（三十四节：不要每页自己画状态）
//
// 纯分类函数在 lib/status-classification.ts（无 JSX，node 测试环境可直接
// import）；本文件只负责展示。状态不只靠颜色（附文字标签）。
// 后端只有 6 态 connection；细粒度登录态机（WAITING_SPAWN 等）是后端
// NOT IMPLEMENTED，前端不伪造。
// ---------------------------------------------------------------------------

import {
  baseStatusTone,
  connectionLabel,
  connectionTone,
  facilitySlotLabel,
  facilitySlotTone,
  processTone,
  type BadgeTone,
  type BotConnectionState,
  type BotProcessState,
} from "@/lib/status-classification";

export {
  baseStatusTone,
  connectionLabel,
  connectionTone,
  facilitySlotLabel,
  facilitySlotTone,
  processTone,
  streamHealthTone,
  type BadgeTone,
  type BotConnectionState,
  type BotProcessState,
  type FacilitySlotStatus,
  type StreamHealth,
} from "@/lib/status-classification";

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
  return <StatusBadge tone={processTone(state)}>{state.toUpperCase()}</StatusBadge>;
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

export function StaleBadge({ sinceMs }: { sinceMs: number }) {
  const age = Math.max(0, Date.now() - sinceMs);
  const seconds = Math.round(age / 1000);
  return (
    <StatusBadge tone="warn" title="数据已超过新鲜阈值">
      STALE {seconds}s
    </StatusBadge>
  );
}
