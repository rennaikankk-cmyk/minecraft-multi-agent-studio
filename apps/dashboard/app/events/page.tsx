import type { Metadata } from "next";

import { UiEmptyState } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Events · Minecraft Multi-Agent Studio" };

export default function EventsPage() {
  return (
    <main>
      <header className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">RELIABILITY · EVENTS</p>
        <h1 className="text-lg font-semibold tracking-tight">Events / Logs</h1>
      </header>
      <UiEmptyState
        title="结构化事件流面板：capability 未接入 dashboard"
        hint="当前可用的真实日志入口：Incidents 时间线（含 occurrence eventWindow）、Servers → Local Test → Open Logs（bounded+redacted）。通用 correlation 级事件流需要新的后端通道（已记录缺口），本页不伪造空壳。"
      />
    </main>
  );
}
