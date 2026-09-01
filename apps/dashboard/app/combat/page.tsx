import type { Metadata } from "next";

import { CombatDashboard } from "@/components/combat-dashboard";

export const metadata: Metadata = {
  title: "作战 · Minecraft Multi-Agent Studio",
};

export default function CombatPage() {
  return (
    <main >
      <header className="pageHeader">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">CONTROL PLANE · COMBAT</p>
        <h1 className="text-lg font-semibold tracking-tight">作战指挥</h1>
        <p>确定性战斗驱动器的只读运行态。</p>
      </header>
      <CombatDashboard />
    </main>
  );
}
