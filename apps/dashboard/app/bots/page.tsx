import type { Metadata } from "next";

import { BotDashboard } from "@/components/bot-dashboard";
import { BotFleetTable } from "@/components/bot-fleet-table";
import { StudioBotManager } from "@/components/studio-bot-manager";

export const metadata: Metadata = {
  title: "机器人 · Minecraft Multi-Agent Studio",
};

export default function BotsPage() {
  return (
    <main>
      <header className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">OPERATIONS · BOTS</p>
        <h1 className="text-lg font-semibold tracking-tight">Bot Fleet</h1>
        <p className="mt-1 max-w-3xl text-[12.5px] text-muted-foreground">
          高密度总表（5s 真实轮询）+ 管理/详情。数据来自 Control API 注册表与实时流；本页永远不展示模拟机器人。
        </p>
      </header>
      <div className="space-y-4">
        <BotFleetTable />
        <StudioBotManager />
        <BotDashboard />
      </div>
    </main>
  );
}
