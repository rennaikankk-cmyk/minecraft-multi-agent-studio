import { AiNodeDashboard } from "@/components/ai-node-dashboard";

export default function AiPage() {
  return (
    <main className="shell">
      <header className="pageHeader">
        <p className="eyebrow">LOCAL AI HUB · LIVE METRICS</p>
        <h2>AI 节点</h2>
        <p>由 U9 Control API 采集 Spark 推理服务；浏览器不直接连接推理节点。</p>
      </header>
      <AiNodeDashboard />
    </main>
  );
}
