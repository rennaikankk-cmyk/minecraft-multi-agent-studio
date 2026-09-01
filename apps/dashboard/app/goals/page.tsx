import type { Metadata } from "next";

import { GoalConsole } from "@/components/goal-console";
import { TaskHistory } from "@/components/task-history";

export const metadata: Metadata = { title: "Goals · Minecraft Multi-Agent Studio" };

export default function GoalsPage() {
  return (
    <main>
      <header className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">INTELLIGENCE · GOALS</p>
        <h1 className="text-lg font-semibold tracking-tight">Goals / Plans</h1>
        <p className="mt-1 max-w-3xl text-[12.5px] text-muted-foreground">
          生产 goal 提交与任务历史；manual goal 抢占 autonomy（独占 movement lease），同一 Bot 不允许两个 goal 同时控制移动。
        </p>
      </header>
      <GoalConsole />
      <TaskHistory />
    </main>
  );
}
