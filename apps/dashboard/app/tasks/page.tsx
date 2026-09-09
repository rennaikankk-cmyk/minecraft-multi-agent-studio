import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/primitives";

import { GoalConsole } from "@/components/goal-console";
import { TaskHistory } from "@/components/task-history";

export const metadata: Metadata = {
  title: "任务 · Minecraft Multi-Agent Studio",
};

export default function TasksPage() {
  return (
    <main >
      <PageHeader eyebrow="CONTROL PLANE · TASKS" title="任务控制"></PageHeader>
      <GoalConsole />
      <TaskHistory />
    </main>
  );
}
