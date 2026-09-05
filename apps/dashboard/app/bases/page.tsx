import type { Metadata } from "next";

import { BasesConsole } from "@/components/shared-state-console";

export const metadata: Metadata = { title: "基地 · Minecraft Multi-Agent Studio" };

export default function BasesPage() {
  return (
    <main >
      <header className="pageHeader">
        <h1 className="text-lg font-semibold">基地与生产</h1>
      </header>
      <BasesConsole />
    </main>
  );
}
