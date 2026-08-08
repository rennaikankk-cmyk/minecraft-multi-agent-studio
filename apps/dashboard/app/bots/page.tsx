import type { Metadata } from "next";

import { BotDashboard } from "@/components/bot-dashboard";

export const metadata: Metadata = {
  title: "机器人 · Minecraft Multi-Agent Studio",
};

export default function BotsPage() {
  return (
    <main className="shell">
      <header className="pageHeader">
        <p className="eyebrow">CONTROL PLANE · BOTS</p>
        <h2>机器人集群</h2>
        <p>
          实时展示 Control API 注册表中的全部机器人。数据优先来自实时推送流，
          流不可用时自动退回轮询并明确标注；本页永远不展示模拟机器人。
        </p>
      </header>
      <BotDashboard />
    </main>
  );
}
