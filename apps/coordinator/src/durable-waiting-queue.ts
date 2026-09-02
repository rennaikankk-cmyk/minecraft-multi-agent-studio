// ---------------------------------------------------------------------------
// durable-waiting-queue.ts —— Phase 1b：waiting goal 的磁盘持久化。
//
// 当前问题：parkWaitingGoal 放在内存 Map，协调器重启后丢失。
// goalStore.begin() 已把 task 写成 running + lease——重启后 store recovery
// 会过期 stale running task 而不是恢复等待。
//
// 修复策略：goal 提交时 bot 未 ready → **不调 goalStore.begin()**（不进
// running 状态），改为把完整的 goal request 写入本持久化队列。Bot ready 后
// 从队列取出、调 begin()、正常执行。重启时 initialize() 恢复未过期条目。
//
// 纪律：
//   1. 原子写（tmp+rename），.corrupt-* 隔离，不静默清空。
//   2. bounded（条目数+年龄），过期条目在恢复时清除。
//   3. 磁盘失败不杀协调器——降级为内存队列（PARTIAL，日志记录）。
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface DurableWaitingGoal {
  operationId: string;
  botId: string;
  taskId: string;
  clientId: string;
  controlApiInstanceId: string;
  actorId: string;
  operatorGoal: string;
  timeoutMs: number;
  issuedAtMs: number;
  /** 计算的死线（epoch ms）= issuedAt + timeoutMs；过期后不再恢复。 */
  expiresAtMs: number;
  /** 入队时间。 */
  enqueuedAtMs: number;
}

export interface DurableWaitingQueueOptions {
  filePath?: string;
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_FILE = path.join(process.cwd(), "runtime-data", "waiting-goals.json");

export class DurableWaitingGoalQueue {
  private entries = new Map<string, DurableWaitingGoal>();
  private readonly filePath: string;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private diskHealthy = true;
  private loaded = false;

  constructor(options: DurableWaitingQueueOptions = {}) {
    this.filePath = options.filePath ?? DEFAULT_FILE;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 启动时恢复未过期条目。corrupt 文件隔离为 .corrupt-*（不清空）。
   * 磁盘不可用时降级为内存队列（diskHealthy=false），不杀进程。
   */
  initialize(): { recovered: number; expired: number; diskDegraded: boolean } {
    if (this.loaded) return { recovered: 0, expired: 0, diskDegraded: !this.diskHealthy };
    this.loaded = true;
    try {
      if (!existsSync(this.filePath)) return { recovered: 0, expired: 0, diskDegraded: false };
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { schemaVersion: string; entries: DurableWaitingGoal[] };
      if (parsed.schemaVersion !== "1.0" || !Array.isArray(parsed.entries)) {
        throw new Error("invalid schema");
      }
      const nowMs = this.now();
      let expired = 0;
      for (const entry of parsed.entries) {
        if (entry.expiresAtMs <= nowMs) {
          expired += 1;
          continue;
        }
        this.entries.set(entry.operationId, entry);
      }
      this.persist();
      return { recovered: this.entries.size, expired, diskDegraded: false };
    } catch (cause) {
      // corrupt → 隔离
      try {
        if (existsSync(this.filePath)) {
          renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        }
      } catch {
        // 隔离也失败——继续用空队列
      }
      this.diskHealthy = false;
      return { recovered: 0, expired: 0, diskDegraded: true };
    }
  }

  /** 入队。同 operationId 幂等（更新不重复创建）。满时拒绝。 */
  enqueue(goal: Omit<DurableWaitingGoal, "enqueuedAtMs">): { accepted: boolean; reason?: string } {
    if (this.entries.size >= this.maxEntries && !this.entries.has(goal.operationId)) {
      return { accepted: false, reason: "QUEUE_FULL" };
    }
    this.entries.set(goal.operationId, { ...goal, enqueuedAtMs: this.now() });
    this.persist();
    return { accepted: true };
  }

  /** 取出（并删除）指定 bot 的最早未过期条目。无则返回 null。 */
  dequeueForBot(botId: string): DurableWaitingGoal | null {
    const nowMs = this.now();
    let earliest: DurableWaitingGoal | null = null;
    for (const entry of this.entries.values()) {
      if (entry.botId !== botId) continue;
      if (entry.expiresAtMs <= nowMs) {
        this.entries.delete(entry.operationId);
        continue;
      }
      if (earliest === null || entry.enqueuedAtMs < earliest.enqueuedAtMs) {
        earliest = entry;
      }
    }
    if (earliest !== null) {
      this.entries.delete(earliest.operationId);
      this.persist();
    }
    return earliest;
  }

  /** 取出（并删除）指定 operationId。 */
  dequeue(operationId: string): DurableWaitingGoal | null {
    const entry = this.entries.get(operationId) ?? null;
    if (entry !== null) {
      this.entries.delete(operationId);
      this.persist();
    }
    return entry;
  }

  peek(operationId: string): DurableWaitingGoal | null {
    return this.entries.get(operationId) ?? null;
  }

  get size(): number {
    return this.entries.size;
  }

  get diskDegraded(): boolean {
    return !this.diskHealthy;
  }

  listForBot(botId: string): readonly DurableWaitingGoal[] {
    return [...this.entries.values()].filter((entry) => entry.botId === botId);
  }

  /** 原子持久化。失败标记 diskDegraded，不抛出。 */
  private persist(): void {
    if (!this.diskHealthy) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const body = JSON.stringify({
        schemaVersion: "1.0",
        updatedAt: new Date(this.now()).toISOString(),
        entries: [...this.entries.values()],
      }, null, 2) + "\n";
      const tmpPath = `${this.filePath}.tmp-${randomUUID().slice(0, 8)}`;
      writeFileSync(tmpPath, body, "utf8");
      renameSync(tmpPath, this.filePath);
    } catch {
      this.diskHealthy = false;
    }
  }
}
