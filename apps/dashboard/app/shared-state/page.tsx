import type { Metadata } from "next";

import { SharedStateConsole } from "@/components/shared-state-console";

export const metadata: Metadata = { title: "共享状态 · Minecraft Multi-Agent Studio" };

export default function SharedStatePage() {
  return (
    <main >
      <header className="pageHeader">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">CONTROL PLANE · SHARED STATE</p>
        <h1 className="text-lg font-semibold tracking-tight">共享状态</h1>
        <p>Workstation 观测/租约与 Facility slot 预约的 authoritative 视图（durable 快照，ephemeral 已在持久化时剥离）。</p>
      </header>
      <SharedStateConsole />
    </main>
  );
}
