import type { Metadata } from "next";

import { UiEmptyState } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "E2E · Minecraft Multi-Agent Studio" };

export default function E2EPage() {
  return (
    <main>
      <header className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">RELIABILITY · E2E</p>
        <h1 className="text-lg font-semibold tracking-tight">E2E 隔离验收</h1>
      </header>
      <UiEmptyState
        title="E2E fixture 实时面板：capability 未接入 dashboard"
        hint="隔离 fixture（唯一容器/动态端口/独立 world/finally cleanup）由命令行驱动：apps/bot-runtime/e2e/{goal-incident,goal-stuck,llm-goal}-e2e.mjs，证据写入运行日志与 Incident。 fixture 状态的实时 UI 通道是已记录缺口。"
      />
    </main>
  );
}
