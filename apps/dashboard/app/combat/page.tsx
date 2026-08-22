import type { Metadata } from "next";

import { CombatDashboard } from "@/components/combat-dashboard";

export const metadata: Metadata = {
  title: "作战 · Minecraft Multi-Agent Studio",
};

export default function CombatPage() {
  return (
    <main className="shell">
      <header className="pageHeader">
        <p className="eyebrow">CONTROL PLANE · COMBAT</p>
        <h2>作战指挥</h2>
        <p>确定性战斗驱动器的只读运行态。</p>
      </header>
      <CombatDashboard />
    </main>
  );
}
