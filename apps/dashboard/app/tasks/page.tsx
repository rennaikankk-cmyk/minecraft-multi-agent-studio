import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "任务 · Minecraft Multi-Agent Studio",
};

export default function TasksPage() {
  return (
    <main className="shell">
      <header className="pageHeader">
        <p className="eyebrow">CONTROL PLANE · TASKS</p>
        <h2>任务看板</h2>
        <p>
          任务系统的持久层（PostgreSQL 任务表、事务 outbox、BullMQ 派发）已在后端完成，
          但面向控制台的任务 API 尚未接入。
        </p>
      </header>

      <section className="notConnectedPanel" data-testid="tasks-not-connected">
        <strong>后端未接入（P1.3.2 进行中）</strong>
        <p>
          本页不展示任何模拟任务。Coordinator 任务 Control API 与看板接入完成后，这里将显示：
        </p>
        <ul>
          <li>任务队列：排队 / 执行中 / 已完成 / 已阻塞 / 已过期，含修订号与幂等键</li>
          <li>租约状态：持有者、到期时间、过期恢复记录</li>
          <li>派发 outbox：投递状态、失败预算、对账记录</li>
          <li>只追加历史：每次状态迁移的操作与原因码</li>
        </ul>
      </section>
    </main>
  );
}
