import type { Metadata } from "next";

import { ServersConsole } from "@/components/servers-console";

export const metadata: Metadata = { title: "服务器 · Minecraft Multi-Agent Studio" };

export default function ServersPage() {
  return (
    <main className="shell">
      <header className="pageHeader">
        <p className="eyebrow">CONTROL PLANE · SERVERS</p>
        <h2>真实服务器与 Bot 登录</h2>
        <p>让 Bot 进入哪个真实 Minecraft 服务器、当前连接状态如何。连接命令由 Coordinator / Studio Manager 执行，前端只发起与观察。</p>
      </header>
      <ServersConsole />
    </main>
  );
}
