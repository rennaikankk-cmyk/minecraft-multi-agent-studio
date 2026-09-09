import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/primitives";

import { ServersConsole } from "@/components/servers-console";

export const metadata: Metadata = { title: "服务器 · Minecraft Multi-Agent Studio" };

export default function ServersPage() {
  return (
    <main>
      <PageHeader eyebrow="OPERATIONS · SERVERS" title="Servers">External Server 由 Studio 连接但不管理其进程；Local Test Server 由 Studio 启停并记录 ownership。observed 状态来自真实容器探测。</PageHeader>
      <ServersConsole />
    </main>
  );
}
