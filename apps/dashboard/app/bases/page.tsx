import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/primitives";

import { BasesConsole } from "@/components/shared-state-console";
import { BotDispatchPanel } from "@/components/bot-dispatch";

export const metadata: Metadata = { title: "基地 · Minecraft Multi-Agent Studio" };

export default function BasesPage() {
  return (
    <main >
      <PageHeader eyebrow="WORLD · BASES" title="基地与生产"></PageHeader>
      <BotDispatchPanel />
      <BasesConsole />
    </main>
  );
}
