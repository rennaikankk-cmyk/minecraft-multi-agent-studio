import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/primitives";

import { CombatDashboard } from "@/components/combat-dashboard";

export const metadata: Metadata = {
  title: "作战 · Minecraft Multi-Agent Studio",
};

export default function CombatPage() {
  return (
    <main >
      <PageHeader eyebrow="CONTROL PLANE · COMBAT" title="作战指挥">确定性战斗驱动器的只读运行态。</PageHeader>
      <CombatDashboard />
    </main>
  );
}
