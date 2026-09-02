import type { Metadata } from "next";

import { SkillsConsole } from "@/components/skills-console";

export const metadata: Metadata = {
  title: "技能体系 · Minecraft Multi-Agent Studio",
};

export default function SkillsPage() {
  return (
    <main>
      <header className="pageHeader">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">CONTROL PLANE · SKILL SYSTEM V1</p>
        <h1 className="text-lg font-semibold tracking-tight">技能体系</h1>
        <p>机器可读 Manifest 的只读渲染：成熟度只由证据推导，展示不发明事实。</p>
      </header>
      <SkillsConsole />
    </main>
  );
}
