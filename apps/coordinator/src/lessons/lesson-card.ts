// ---------------------------------------------------------------------------
// lesson-card.ts —— LLM 复盘产出的结构化经验卡（自我改善闭环 Phase B）。
//
// 纪律（对齐 spark-strategy-v1）：
//   1. fingerprint=FNV-1a 64（canonical JSON：键排序、无空白）——去重判据。
//   2. 自由文本（goalPattern/advice）落盘前必须过 redact + residual scan。
//   3. 卡片按 serverProfileId 隔离：跨服教训不复用。
//   4. evidence 引用真实 taskId——验证器据此拒编造引用。
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const LESSON_CARD_SCHEMA_VERSION = "1.0" as const;

export const lessonCardKinds = ["goal-approach", "prerequisite", "hazard", "resource-strategy", "timing"] as const;
export type LessonCardKind = (typeof lessonCardKinds)[number];

/** 复盘输入里的终态任务事实（与 TaskExecutionRecord 字段解耦的最小面）。 */
export const reviewTaskFactSchema = z.object({
  taskId: z.string().min(1).max(128),
  botId: z.string().min(1).max(64),
  goal: z.string().min(1).max(2_000),
  state: z.enum(["SUCCESS", "ABORT"]),
  failureReason: z.string().max(512).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type ReviewTaskFact = z.infer<typeof reviewTaskFactSchema>;

export const lessonCardSchema = z.object({
  schemaVersion: z.literal(LESSON_CARD_SCHEMA_VERSION),
  lessonId: z.string().min(8).max(64),
  serverProfileId: z.string().min(1).max(128),
  kind: z.enum(lessonCardKinds),
  trigger: z.object({
    goalPattern: z.string().min(1).max(200),
    failureCodes: z.array(z.string().min(1).max(64)).max(8),
  }).strict(),
  advice: z.string().min(1).max(400),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.object({
    taskId: z.string().min(1).max(128),
    outcome: z.enum(["completed", "failed", "aborted"]),
  }).strict()).max(8),
  observedAtMs: z.number().int().nonnegative(),
}).strict();
export type LessonCard = z.infer<typeof lessonCardSchema>;

/** 模型返回信封：{"lessons": [...]}。 */
export const lessonResponseSchema = z.object({ lessons: z.array(lessonCardSchema).min(1).max(8) }).strict();

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffff_ffff_ffff_ffffn;

/** canonical JSON：键排序、无空白（与 spark-strategy-v1 facts 同规则）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** 卡片内容指纹：语义字段（kind/trigger/advice/scope），不含时间与 lessonId。 */
export function lessonFingerprint(card: Readonly<
  Pick<LessonCard, "serverProfileId" | "kind" | "trigger" | "advice">
>): string {
  const canonical = canonicalJson({
    serverProfileId: card.serverProfileId,
    kind: card.kind,
    trigger: card.trigger,
    advice: card.advice,
  });
  let h = FNV_OFFSET;
  for (const byte of Buffer.from(canonical, "utf8")) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/** 新卡分配稳定 id：指纹 + 随机后缀（同指纹重写不撞 id，但 store 以指纹为文件名去重）。 */
export function newLessonId(card: Readonly<
  Pick<LessonCard, "serverProfileId" | "kind" | "trigger" | "advice">
>): string {
  return `${lessonFingerprint(card).slice(0, 12)}-${randomUUID().slice(0, 8)}`;
}

export function lessonFileName(card: Readonly<
  Pick<LessonCard, "serverProfileId" | "kind" | "trigger" | "advice">
>): string {
  // 文件名只含 hex 指纹：不把自由文本或 scope 写进路径。
  return `${lessonFingerprint(card)}.json`;
}

/** content hash 导出（导出/审计用，非去重判据）。 */
export function lessonContentHash(card: LessonCard): string {
  return createHash("sha256").update(canonicalJson(card)).digest("hex");
}
