import type { Metadata } from "next";

import { GoalConsole } from "@/components/goal-console";
import { TaskHistory } from "@/components/task-history";

export const metadata: Metadata = {
  title: "任务 · Minecraft Multi-Agent Studio",
};

export default function TasksPage() {
  return (
    <main >
      <header className="pageHeader">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">CONTROL PLANE · TASKS</p>
        <h1 className="text-lg font-semibold tracking-tight">任务控制</h1>
      </header>
      <GoalConsole />
      <TaskHistory />
    </main>
  );
}
