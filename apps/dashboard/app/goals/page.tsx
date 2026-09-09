import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/primitives";

import { GoalConsole } from "@/components/goal-console";
import { TaskHistory } from "@/components/task-history";

export const metadata: Metadata = { title: "Goals · Minecraft Multi-Agent Studio" };

export default function GoalsPage() {
  return (
    <main>
      <PageHeader eyebrow="INTELLIGENCE · GOALS" title="Goals / Plans">生产 goal 提交与任务历史；manual goal 抢占 autonomy（独占 movement lease），同一 Bot 不允许两个 goal 同时控制移动。</PageHeader>
      <GoalConsole />
      <TaskHistory />
    </main>
  );
}
