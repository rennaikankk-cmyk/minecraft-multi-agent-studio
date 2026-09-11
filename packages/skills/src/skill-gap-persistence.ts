// ---------------------------------------------------------------------------
// skill-gap-persistence.ts —— SkillGapStore 的文件持久化（自我改善闭环 D1）。
//
// 纪律（对齐 incidents store 的桌面文件边界）：
//   1. 原子写：tmp + rename；写入失败降级内存（gap 记录是增强，不杀进程）。
//   2. corrupt 文件启动时隔离到 .corrupt-* 并从空开始（不静默清空：原文件
//      保留在隔离名下）。
//   3. 恢复的条目经 schema 再校验；非法条目丢弃（bounded 语义在内存侧维持）。
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  skillGapRequestSchema,
  SkillGapStore,
  type SkillGapStoreOptions,
} from "./skill-gap.js";

const STORE_VERSION = "1.0";

export class FileSkillGapStore extends SkillGapStore {
  private readonly filePath: string;
  private persistDegraded = false;

  constructor(dir: string, options: SkillGapStoreOptions = {}) {
    super(options);
    this.filePath = path.join(dir, "skill-gaps.json");
    this.initialize();
  }

  /** 启动恢复：corrupt 隔离；可恢复条目回灌（super.record 的聚合路径）。 */
  private initialize(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return; // 不存在=首启，正常
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.quarantine();
      return;
    }
    const envelope = parsed as { schemaVersion?: unknown; gaps?: unknown };
    if (envelope?.schemaVersion !== STORE_VERSION || !Array.isArray(envelope.gaps)) {
      this.quarantine();
      return;
    }
    for (const entry of envelope.gaps) {
      const validated = skillGapRequestSchema.safeParse(entry);
      if (!validated.success) continue;
      // 原样回灌（保留 occurrenceCount/时间戳），不走 record 的聚合语义。
      this.restore(validated.data);
    }
  }

  override record(input: Parameters<SkillGapStore["record"]>[0]): ReturnType<SkillGapStore["record"]> {
    const result = super.record(input);
    this.flush();
    return result;
  }

  get durability(): "file" | "memory-degraded" {
    return this.persistDegraded ? "memory-degraded" : "file";
  }

  private flush(): void {
    const payload = JSON.stringify({ schemaVersion: STORE_VERSION, gaps: this.list() });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, payload, { mode: 0o600 });
      renameSync(temporary, this.filePath);
      this.persistDegraded = false;
    } catch {
      // 持久化失败降级内存：gap 记录绝不阻塞调用方路径。
      this.persistDegraded = true;
      try { unlinkSync(temporary); } catch { /* best effort */ }
    }
  }

  private quarantine(): void {
    const target = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      renameSync(this.filePath, target);
    } catch {
      // 隔离失败时保留原文件不动（下次启动再试）。
    }
  }
}
