import type { Metadata } from "next";

import { IncidentsConsole } from "@/components/incidents-console";

export const metadata: Metadata = { title: "Incidents · Minecraft Multi-Agent Studio" };

export default function IncidentsPage() {
  return (
    <main className="shell">
      <header className="pageHeader">
        <p className="eyebrow">CONTROL PLANE · INCIDENTS</p>
        <h2>失败与卡住事故</h2>
        <p>真实后端驱动的 Incident 聚合：崩溃、阈值卡住、假成功、重试耗尽。同 fingerprint 去重，suspectedLayer 来自确定性规则。</p>
      </header>
      <IncidentsConsole />
    </main>
  );
}
