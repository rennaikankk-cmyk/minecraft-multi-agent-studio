// ---------------------------------------------------------------------------
// main.ts 接线守卫。
//
// lifecycle.ts 的单测只证明"竞速机制本身正确"，不证明 main() 真的用了它——
// 而历史 bug 恰恰出在接线：main() 只 `await waitForShutdownSignal()`，worker
// 基础设施失败无人观测（BullMqTaskWorker 的 getLastInfrastructureError 当时
// 零调用者），进程静默挂死且无任何日志。
//
// main.ts 是带顶层副作用的脚本，无法在进程内直接实例化测试；这里的结构性断言
// 就是为了防止回退到那一版接线。断言刻意写得粗粒度，允许正常重构。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
  path.join(import.meta.dirname, "..", "src", "main.ts"),
  "utf8",
);

describe("task-worker main.ts 接线", () => {
  it("采用竞速结果，而不是只等关闭信号", () => {
    expect(mainSource).toContain("raceWorkerOutcome(");
    // 裸等信号即历史 bug：worker 失败将无人观测
    expect(mainSource).not.toMatch(/\bawait\s+waitForShutdownSignal\s*\(/u);
  });

  it("把基础设施失败转成非零退出码", () => {
    expect(mainSource).toContain('"infrastructure-failure"');
    expect(mainSource).toContain("process.exitCode = 1");
    expect(mainSource).toContain("task_worker_infrastructure_failed");
  });

  it("不再自己定义关闭信号监听（统一走 lifecycle 模块）", () => {
    expect(mainSource).not.toContain('process.once("SIGINT"');
    expect(mainSource).not.toContain('process.once("SIGTERM"');
  });
});
