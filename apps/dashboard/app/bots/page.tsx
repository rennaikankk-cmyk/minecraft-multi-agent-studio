import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/primitives";

import { BotDashboard } from "@/components/bot-dashboard";
import { BotFleetTable } from "@/components/bot-fleet-table";
import { StudioBotManager } from "@/components/studio-bot-manager";

export const metadata: Metadata = {
  title: "机器人 · Minecraft Multi-Agent Studio",
};

export default function BotsPage() {
  return (
    <main>
      <PageHeader eyebrow="OPERATIONS · BOTS" title="Bot Fleet">高密度总表（5s 真实轮询）+ 管理/详情。数据来自 Control API 注册表与实时流；本页永远不展示模拟机器人。</PageHeader>
      <div className="space-y-4">
        <BotFleetTable />
        <StudioBotManager />
        <BotDashboard />
      </div>
    </main>
  );
}
