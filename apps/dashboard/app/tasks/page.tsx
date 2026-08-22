import type { Metadata } from "next";

import { GoalConsole } from "@/components/goal-console";
import { TaskHistory } from "@/components/task-history";

export const metadata: Metadata = {
  title: "任务 · Minecraft Multi-Agent Studio",
};

export default function TasksPage() {
  return (
    <main className="shell">
      <header className="pageHeader">
        <p className="eyebrow">CONTROL PLANE · TASKS</p>
        <h2>任务控制</h2>
      </header>
      <GoalConsole />
      <TaskHistory />
    </main>
  );
}
