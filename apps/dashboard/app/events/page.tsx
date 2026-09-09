import type { Metadata } from "next";

import {UiEmptyState , PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Events · Minecraft Multi-Agent Studio" };

export default function EventsPage() {
  return (
    <main>
      <PageHeader eyebrow="RELIABILITY · EVENTS" title="Events / Logs"></PageHeader>
      <UiEmptyState
        title="结构化事件流面板：capability 未接入 dashboard"
        hint="当前可用的真实日志入口：Incidents 时间线（含 occurrence eventWindow）、Servers → Local Test → Open Logs（bounded+redacted）。通用 correlation 级事件流需要新的后端通道（已记录缺口），本页不伪造空壳。"
      />
    </main>
  );
}
