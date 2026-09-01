import type { Metadata } from "next";

import { ServersConsole } from "@/components/servers-console";

export const metadata: Metadata = { title: "服务器 · Minecraft Multi-Agent Studio" };

export default function ServersPage() {
  return (
    <main className="shell">
      <header className="pageHeader">
        <p className="eyebrow">CONTROL PLANE · SERVERS</p>
        <h2>External Servers 与 Local Test Server</h2>
        <p>External Server 由 Studio 连接但不管理其进程；Local Test Server 由 Studio 启停并记录 ownership。observed state 来自真实容器探测，前端只发起与观察。</p>
      </header>
      <ServersConsole />
    </main>
  );
}
