import type { Metadata } from "next";

import { BasesConsole } from "@/components/shared-state-console";

export const metadata: Metadata = { title: "基地 · Minecraft Multi-Agent Studio" };

export default function BasesPage() {
  return (
    <main >
      <header className="pageHeader">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">CONTROL PLANE · BASES</p>
        <h1 className="text-lg font-semibold tracking-tight">基地 / 蓝图 / 设施</h1>
        <p>来自 Coordinator 共享状态快照：Base 生命周期、蓝图 2D 网格（按 Y 层）、Facility slot 状态机。未启用共享状态时如实提示，不显示假基地。</p>
      </header>
      <BasesConsole />
    </main>
  );
}
