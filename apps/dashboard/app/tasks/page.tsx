import type { Metadata } from "next";

import { GoalConsole } from "@/components/goal-console";

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
    </main>
  );
}
