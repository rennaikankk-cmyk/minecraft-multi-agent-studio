import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/primitives";

import { SkillsConsole } from "@/components/skills-console";

export const metadata: Metadata = {
  title: "技能体系 · Minecraft Multi-Agent Studio",
};

export default function SkillsPage() {
  return (
    <main>
      <PageHeader eyebrow="CONTROL PLANE · SKILL SYSTEM V1" title="技能体系">机器可读 Manifest 的只读渲染：成熟度只由证据推导，展示不发明事实。</PageHeader>
      <SkillsConsole />
    </main>
  );
}
