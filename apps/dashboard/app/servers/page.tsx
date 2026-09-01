import type { Metadata } from "next";

import { ServersConsole } from "@/components/servers-console";

export const metadata: Metadata = { title: "服务器 · Minecraft Multi-Agent Studio" };

export default function ServersPage() {
  return (
    <main>
      <header className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">OPERATIONS · SERVERS</p>
        <h1 className="text-lg font-semibold tracking-tight">Servers</h1>
        <p className="mt-1 max-w-3xl text-[12.5px] text-muted-foreground">
          External Server 由 Studio 连接但不管理其进程；Local Test Server 由 Studio 启停并记录 ownership。observed 状态来自真实容器探测。
        </p>
      </header>
      <ServersConsole />
    </main>
  );
}
