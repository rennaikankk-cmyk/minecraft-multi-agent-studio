import type { Metadata } from "next";

import { SharedStateConsole } from "@/components/shared-state-console";

export const metadata: Metadata = { title: "共享状态 · Minecraft Multi-Agent Studio" };

export default function SharedStatePage() {
  return (
    <main className="shell">
      <header className="pageHeader">
        <p className="eyebrow">CONTROL PLANE · SHARED STATE</p>
        <h2>共享状态</h2>
        <p>Workstation 观测/租约与 Facility slot 预约的 authoritative 视图（durable 快照，ephemeral 已在持久化时剥离）。</p>
      </header>
      <SharedStateConsole />
    </main>
  );
}
