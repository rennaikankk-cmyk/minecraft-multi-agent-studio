import type { Metadata } from "next";

import { IncidentsConsole } from "@/components/incidents-console";

export const metadata: Metadata = { title: "Incidents · Minecraft Multi-Agent Studio" };

export default function IncidentsPage() {
  return (
    <main>
      <header className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">RELIABILITY · INCIDENTS</p>
        <h1 className="text-lg font-semibold tracking-tight">Incidents</h1>
        <p className="mt-1 max-w-3xl text-[12.5px] text-muted-foreground">
          可靠性运维视图：Issue（fingerprint 聚合）→ Occurrence drill-down → 服务端导出。suspectedLayer 来自确定性规则，不默认归咎 Skill。
        </p>
      </header>
      <IncidentsConsole />
    </main>
  );
}
