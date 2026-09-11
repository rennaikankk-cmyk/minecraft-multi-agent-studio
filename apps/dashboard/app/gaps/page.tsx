import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/primitives";

import { GapConsole } from "@/components/gap-console";

export const metadata: Metadata = {
  title: "Gap Console · Minecraft Multi-Agent Studio",
};

export default function GapsPage() {
  return (
    <main>
      <PageHeader eyebrow="INTELLIGENCE · SELF-IMPROVEMENT LOOP" title="Gap Console">自我改善闭环的人审面：gap 自动入册、composition 建议优先于新技能、release 生命周期在 verified 停车，canary/active 必须人在此批准。</PageHeader>
      <GapConsole />
    </main>
  );
}
