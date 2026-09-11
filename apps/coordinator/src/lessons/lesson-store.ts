// ---------------------------------------------------------------------------
// lesson-store.ts —— lesson 卡文件持久化（Phase B）。
//
// 纪律（对齐 FilePersonalMemoryStore 的桌面文件边界）：
//   1. 原子写：tmp + rename；corrupt 文件读取时跳过（记忆是增强不是前置）。
//   2. 落盘前 fail-closed：redact 后 residual secret scan 不过 → 拒写该卡。
//   3. 文件名=内容指纹：同指纹重写覆盖（幂等去重），按 serverProfileId
//      目录隔离；单 profile bounded（超限从最旧淘汰）。
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scanResidualSecrets } from "@minecraft-studio/skills";
import { lessonCardSchema, lessonFileName, type LessonCard } from "./lesson-card.js";

export const LESSON_STORE_MAX_PER_PROFILE = 64;

export class LessonStoreError extends Error {
  constructor(readonly code: "LESSON_STORE_WRITE_FAILED" | "LESSON_STORE_SECRET_RESIDUE") {
    super(code);
    this.name = "LessonStoreError";
  }
}

export class FileLessonStore {
  constructor(private readonly dir: string, private readonly maxPerProfile = LESSON_STORE_MAX_PER_PROFILE) {}

  /** @returns true=新写入；false=幂等覆盖（同指纹已存在，仅刷新时间戳）。 */
  save(card: LessonCard): boolean {
    const parsed = lessonCardSchema.parse(card);
    if (!scanResidualSecrets(JSON.stringify(parsed))) throw new LessonStoreError("LESSON_STORE_SECRET_RESIDUE");
    const profileDir = path.join(this.dir, safeSegment(parsed.serverProfileId));
    const target = path.join(profileDir, lessonFileName(parsed));
    const existed = existsSync(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(parsed));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, target);
      this.evictOverBudget(profileDir);
    } catch (error) {
      if (error instanceof LessonStoreError) throw error;
      throw new LessonStoreError("LESSON_STORE_WRITE_FAILED");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* Only our own temporary file. */ }
    }
    return !existed;
  }

  list(serverProfileId: string): readonly LessonCard[] {
    const profileDir = path.join(this.dir, safeSegment(serverProfileId));
    let entries: readonly string[];
    try {
      entries = readdirSync(profileDir);
    } catch {
      return [];
    }
    const cards: LessonCard[] = [];
    for (const entry of entries) {
      if (!/^[a-f0-9]{16}\.json$/u.test(entry)) continue;
      try {
        cards.push(lessonCardSchema.parse(JSON.parse(readFileSync(path.join(profileDir, entry), "utf8"))));
      } catch {
        continue;
      }
    }
    return cards.sort((a, b) => b.observedAtMs - a.observedAtMs);
  }

  /** planner 记忆消费：同 profile 最近 K 张卡的最小摘要。 */
  listTop(serverProfileId: string, limit: number): readonly LessonCard[] {
    return this.list(serverProfileId).slice(0, limit);
  }

  private evictOverBudget(profileDir: string): void {
    let entries: readonly string[];
    try {
      entries = readdirSync(profileDir);
    } catch {
      return;
    }
    const cards = entries
      .filter((entry) => /^[a-f0-9]{16}\.json$/u.test(entry))
      .map((entry) => {
        try {
          return { entry, observedAtMs: lessonCardSchema.parse(JSON.parse(readFileSync(path.join(profileDir, entry), "utf8"))).observedAtMs };
        } catch {
          return null;
        }
      })
      .filter((value): value is { entry: string; observedAtMs: number } => value !== null)
      .sort((a, b) => a.observedAtMs - b.observedAtMs);
    let excess = cards.length - this.maxPerProfile;
    for (const card of cards) {
      if (excess <= 0) break;
      try { rmSync(path.join(profileDir, card.entry), { force: true }); } catch { /* eviction is best-effort */ }
      excess--;
    }
  }
}

/** 目录段只允许安全字符（serverProfileId 可能来自外部配置）。 */
function safeSegment(serverProfileId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(serverProfileId)) {
    throw new LessonStoreError("LESSON_STORE_WRITE_FAILED");
  }
  return serverProfileId;
}
