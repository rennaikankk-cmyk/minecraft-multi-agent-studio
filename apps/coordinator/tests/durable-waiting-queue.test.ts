// DurableWaitingGoalQueue 测试：持久化/恢复/幂等/过期/bounded/disk降级。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DurableWaitingGoalQueue } from "../src/durable-waiting-queue.js";

let dir: string;

function makeQueue(options: Partial<{ maxEntries: number; now: () => number }> = {}) {
  return new DurableWaitingGoalQueue({ filePath: path.join(dir, "wq.json"), now: () => 0, ...options });
}

function makeGoal(botId = "bot-1", operationId = "op-1") {
  return {
    operationId,
    botId,
    taskId: operationId,
    clientId: "test-client",
    controlApiInstanceId: "test-cai",
    actorId: "test-actor",
    operatorGoal: "test goal",
    timeoutMs: 30_000,
    issuedAtMs: 1_000,
    expiresAtMs: 31_000,
  };
}

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "wq-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("DurableWaitingGoalQueue", () => {
  it("enqueue + dequeue 基本操作", () => {
    const q = makeQueue();
    const result = q.enqueue(makeGoal());
    expect(result.accepted).toBe(true);
    expect(q.size).toBe(1);
    const entry = q.dequeueForBot("bot-1");
    expect(entry).not.toBeNull();
    expect(entry!.operationId).toBe("op-1");
    expect(q.size).toBe(0);
    expect(q.dequeueForBot("bot-1")).toBeNull();
  });

  it("同 operationId 幂等（不重复创建）", () => {
    const q = makeQueue();
    q.enqueue(makeGoal());
    q.enqueue(makeGoal());
    expect(q.size).toBe(1);
  });

  it("不同 bot 隔离", () => {
    const q = makeQueue();
    q.enqueue(makeGoal("bot-1", "op-1"));
    q.enqueue(makeGoal("bot-2", "op-2"));
    expect(q.dequeueForBot("bot-2")!.operationId).toBe("op-2");
    expect(q.dequeueForBot("bot-1")!.operationId).toBe("op-1");
  });

  it("FIFO：同 bot 先入先出", () => {
    const q = makeQueue({ now: (() => 0) });
    q.enqueue(makeGoal("bot-1", "op-a"));
    const q2 = makeQueue({ now: (() => 100) });
    // 直接用同一个 queue 测时间排序
    q.enqueue({ ...makeGoal("bot-1", "op-b"), issuedAtMs: 100, expiresAtMs: 130_100 });
    const first = q.dequeueForBot("bot-1");
    expect(first!.operationId).toBe("op-a");
  });

  it("持久化到磁盘", () => {
    const q = makeQueue();
    q.enqueue(makeGoal());
    const filePath = path.join(dir, "wq.json");
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.schemaVersion).toBe("1.0");
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].operationId).toBe("op-1");
  });

  it("重启后恢复", () => {
    const q1 = makeQueue();
    q1.enqueue(makeGoal());
    const q2 = makeQueue();
    const result = q2.initialize();
    expect(result.recovered).toBe(1);
    expect(result.expired).toBe(0);
    expect(q2.size).toBe(1);
    expect(q2.dequeueForBot("bot-1")).not.toBeNull();
  });

  it("过期条目在恢复时清除", () => {
    const q1 = makeQueue();
    q1.enqueue(makeGoal()); // expiresAtMs=31000
    const q2 = makeQueue({ now: (() => 50_000) }); // 50s > 31s
    const result = q2.initialize();
    expect(result.recovered).toBe(0);
    expect(result.expired).toBe(1);
    expect(q2.size).toBe(0);
  });

  it("bounded：满时拒绝", () => {
    const q = makeQueue({ maxEntries: 2 });
    q.enqueue(makeGoal("b1", "op-1"));
    q.enqueue(makeGoal("b2", "op-2"));
    const result = q.enqueue(makeGoal("b3", "op-3"));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("QUEUE_FULL");
  });

  it("bounded：已有条目不受满限制（幂等更新）", () => {
    const q = makeQueue({ maxEntries: 1 });
    q.enqueue(makeGoal("b1", "op-1"));
    const result = q.enqueue(makeGoal("b1", "op-1"));
    expect(result.accepted).toBe(true);
    expect(q.size).toBe(1);
  });

  it("peek 不删除", () => {
    const q = makeQueue();
    q.enqueue(makeGoal());
    expect(q.peek("op-1")).not.toBeNull();
    expect(q.size).toBe(1);
  });

  it("dequeue by operationId", () => {
    const q = makeQueue();
    q.enqueue(makeGoal());
    const entry = q.dequeue("op-1");
    expect(entry).not.toBeNull();
    expect(q.size).toBe(0);
    expect(q.dequeue("op-1")).toBeNull();
  });

  it("listForBot", () => {
    const q = makeQueue();
    q.enqueue(makeGoal("bot-1", "op-1"));
    q.enqueue(makeGoal("bot-2", "op-2"));
    const list = q.listForBot("bot-1");
    expect(list).toHaveLength(1);
    expect(list[0]!.botId).toBe("bot-1");
  });

  it("corrupt 文件隔离为 .corrupt-*，不杀进程", () => {
    const filePath = path.join(dir, "wq.json");
    // 写入非法内容
    const fs = require("node:fs");
    fs.writeFileSync(filePath, "NOT VALID JSON {{{{");
    const q = makeQueue();
    const result = q.initialize();
    expect(result.diskDegraded).toBe(true);
    expect(result.recovered).toBe(0);
    expect(q.diskDegraded).toBe(true);
    // .corrupt 文件存在
    const files = fs.readdirSync(dir).filter((f: string) => f.startsWith("wq.json.corrupt-"));
    expect(files.length).toBe(1);
  });


  // ---- 原子性审计（2026-09-03）：CLAIMED 态闭环 ----

  it("claimForBot 标记不删除；completeClaim 才删除", () => {
    const q = makeQueue();
    q.enqueue(makeGoal());
    const claimed = q.claimForBot("bot-1");
    expect(claimed).not.toBeNull();
    expect(q.size).toBe(1); // 仍在队列（claimed）
    // claimed 条目不会被再次 claim/dequeue
    expect(q.claimForBot("bot-1")).toBeNull();
    expect(q.dequeueForBot("bot-1")).toBeNull();
    q.completeClaim("op-1");
    expect(q.size).toBe(0);
    // 幂等：非 claimed 的 completeClaim 是 no-op
    expect(() => q.completeClaim("op-1")).not.toThrow();
  });

  it("claim 后崩溃（重启恢复）→ claimed 重置回 waiting，goal 不丢", () => {
    const q1 = makeQueue();
    q1.enqueue(makeGoal());
    q1.claimForBot("bot-1");
    // 模拟 claim→begin 之间崩溃：新实例 initialize()
    const q2 = makeQueue();
    const result = q2.initialize();
    expect(result.recovered).toBe(1);
    // 恢复后可再次 claim（claimed 态被清除）
    const reClaimed = q2.claimForBot("bot-1");
    expect(reClaimed).not.toBeNull();
    expect(reClaimed!.claimedAtMs).toBeDefined();
  });

  it("claim 后 completeClaim（begin 落地）→ 重启后不再恢复", () => {
    const q1 = makeQueue();
    q1.enqueue(makeGoal());
    q1.claimForBot("bot-1");
    q1.completeClaim("op-1");
    const q2 = makeQueue();
    const result = q2.initialize();
    expect(result.recovered).toBe(0);
    expect(q2.size).toBe(0);
  });

  it("FIFO：claim 只取最早的未认领条目", () => {
    const q = makeQueue({ now: () => 0 });
    q.enqueue(makeGoal("bot-1", "op-1"));
    q.enqueue(makeGoal("bot-1", "op-2"));
    const first = q.claimForBot("bot-1");
    expect(first!.operationId).toBe("op-1");
    const second = q.claimForBot("bot-1");
    expect(second!.operationId).toBe("op-2");
  });
});
