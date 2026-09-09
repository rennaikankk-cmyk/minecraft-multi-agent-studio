import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/primitives";

import { IncidentsConsole } from "@/components/incidents-console";

export const metadata: Metadata = { title: "Incidents · Minecraft Multi-Agent Studio" };

export default function IncidentsPage() {
  return (
    <main>
      <PageHeader eyebrow="RELIABILITY · INCIDENTS" title="Incidents">可靠性运维视图：Issue（fingerprint 聚合）→ Occurrence drill-down → 服务端导出。suspectedLayer 来自确定性规则，不默认归咎 Skill。</PageHeader>
      <IncidentsConsole />
    </main>
  );
}
