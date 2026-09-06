// ---------------------------------------------------------------------------
// site-verdict.ts —— 基地选址的模型评审（Implementation Prompt V1 · Phase 6 前置）。
//
// 纪律（与 replan-oracle/strategy-review 同源）：
//   1. 模型只做有限菜单裁决：accept / reject + 理由。**坐标、锚点、goal
//      文本永不经过模型**——候选点位由确定性层（扇区游标）给出，模型只
//      判断"这个点好不好"。
//   2. 事实快照全部是相对值（距离/数量）：prompt 刻意不含绝对坐标与
//      服务器身份（AGENTS.md 保密面，与 buildReplanPrompt 同纪律）。
//   3. fail-open：模型不可用/超时/输出不合法 → 按 accept 处理（选址
//      回退到"走到哪算哪"的旧行为），自主流水线永不因模型缺位死锁。
//   4. reject 有界：连续拒绝超过上限后强制 accept——防"永远看不上
//      任何点位"的模型洁癖死循环。
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  aiRequestPriorities,
  parseStructuredOutput,
  type AIScheduledResult,
  type GenerateResult,
  type ScheduledAIRouter,
} from "@minecraft-studio/ai-router";

/** 连续 reject 上限：达到后强制 accept（fail-open 同族护栏）。 */
export const SITE_VERDICT_REJECT_LIMIT = 3;

/** 单次评审总预算（含事实采集与模型调用；防挂起吞掉需求节拍）。 */
export const SITE_VERDICT_TIMEOUT_MS = 45_000;

/** 评审用事实项：null = 该项未观测到（或扫描失败），不是"距离为零"。 */
export type SiteFactDimension = Readonly<{
  /** 最近一处距候选点的水平距离（格，四舍五入）。 */
  nearestDistance: number;
  /** 观测到的数量（受扫描 maxCount 截断，下限语义）。 */
  count: number;
}>;

export type SiteFacts = Readonly<{
  /** 村庄标记（干草捆）——交易大厅流水线的核心前瞻信号。 */
  village: SiteFactDimension | null;
  water: SiteFactDimension | null;
  lava: SiteFactDimension | null;
  wood: SiteFactDimension | null;
}>;

/** 评审结论：sanitizer 之后的可信形态。 */
export type SiteVerdict = Readonly<{
  verdict: "accept" | "reject";
  confidence: number;
  reasons: readonly string[];
}>;

const siteVerdictResultSchema = z
  .object({
    verdict: z.enum(["accept", "reject"]),
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string().min(1).max(120)).min(1).max(3),
  })
  .strict();

function factLine(label: string, fact: SiteFactDimension | null): string {
  if (fact === null) return `- ${label}：64 格内未观测到`;
  return `- ${label}：最近 ${fact.nearestDistance} 格，共 ${fact.count} 处`;
}

/** 事实 → 评审 prompt（全相对值；无绝对坐标/无服务器身份）。 */
export function buildSiteVerdictPrompt(facts: SiteFacts): string {
  return [
    "你是 Minecraft 长期基地选址评审。确定性探索层已走到一个候选点，以下是该点的事实快照（全部为相对距离/数量，64 格观测半径）：",
    factLine("村庄标记（干草捆，村民与交易的强前瞻信号）", facts.village),
    factLine("水源", facts.water),
    factLine("岩浆（熔毁风险）", facts.lava),
    factLine("橡树原木（木材获取）", facts.wood),
    "判定标准（按权重）：靠近村庄最重要（后续村民运输与交易大厅的根基）> 有水源 > 有木材；岩浆 8 格内算硬伤。",
    "reject 仅在明确硬伤时使用（岩浆很近，或水与木材双双缺失且无村庄）；信息不足时倾向 accept。",
    '输出恰好一个 JSON 对象：{"verdict":"accept"|"reject","confidence":0到1,"reasons":["≤3 条，每条 ≤120 字"]}',
  ].join("\n");
}

/** 原始模型输出 → 可信结论。任何不合法（缺字段/越界/多余字段）→ null。 */
export function sanitizeSiteVerdict(raw: unknown): SiteVerdict | null {
  const parsed = siteVerdictResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    verdict: parsed.data.verdict,
    confidence: parsed.data.confidence,
    reasons: Object.freeze([...parsed.data.reasons]),
  };
}

/** 模型评审调用（askReplanOracle 同模式：异常一律 null，调用方 fail-open）。 */
export async function askSiteVerdict(options: {
  ai: Pick<ScheduledAIRouter, "generate">;
  requestId: string;
  botId: string;
  traceId: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<SiteVerdict | null> {
  let ai: AIScheduledResult<GenerateResult>;
  try {
    ai = await options.ai.generate({
      requestId: options.requestId,
      botId: options.botId,
      priority: aiRequestPriorities.planning,
      supersedeKey: `site-verdict:${options.botId}`,
      prompt: options.prompt,
      systemPrompt:
        "You are a site selection reviewer for a Minecraft survival agent. Answer with exactly one JSON object matching the schema. You judge only from the given facts; never invent coordinates or blocks.",
      schema: siteVerdictResultSchema,
      maxTokens: 160,
      temperature: 0,
      timeoutMs: SITE_VERDICT_TIMEOUT_MS,
      traceId: options.traceId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    return null;
  }
  try {
    return sanitizeSiteVerdict(
      parseStructuredOutput(ai.value.content, {
        name: "site-verdict",
        schema: siteVerdictResultSchema,
      }),
    );
  } catch {
    return null;
  }
}
