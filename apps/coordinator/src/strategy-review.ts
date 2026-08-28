// ---------------------------------------------------------------------------
// StrategyReview —— 战略层的周期评审（AGENTS.md：战略层=分钟级、大模型）。
//
// 与重规划神谕的区别：神谕是**失败驱动**的被动救火（3 连败才问），这里是
// **周期驱动**的主动复盘。每 5 分钟给模型一份紧凑局势摘要（需求史/库存
// 概况/进度阶段），让它决定下一个评审周期的战略重心。这是无规则服上
// "先钻还是先防、先食物还是先铁"这类真决策的落点——不是每个目标的
// 执行者（那仍是 0 LLM 的确定性层），而是重心的调度者。
//
// 安全边界与神谕一致：输出收敛为白名单重心枚举 + 可选探索焦点方块 +
// 可选立场，经 schema 校验与 sanitize；模型不可用/超时保持默认重心
// （survival-needs 的固定优先级），自主性零依赖。
// ---------------------------------------------------------------------------

import {
  aiRequestPriorities,
  parseStructuredOutput,
  type AIScheduledResult,
  type GenerateResult,
  type ScheduledAIRouter,
} from "@minecraft-studio/ai-router";
import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

export const STRATEGY_REVIEW_TIMEOUT_MS = 10_000;
export const STRATEGY_REVIEW_INTERVAL_MS = 5 * 60_000;

/** 战略重心白名单：只允许在这几个之间切换，任一时刻一个主重心。 */
export const strategyFocuses = [
  "survival-basics",   // 食物/避难/基础工具优先
  "tool-progression",  // 木→石→铁→钻 梯队优先
  "defense",           // 武器/护甲/盾/图腾优先
  "resource-stockpile",// 储备囤积（木/煤/铁/食物到水位）
  "exploration",       // 探索测绘优先
  "base-building",     // 基地/储存建设优先
] as const;

export type StrategyFocus = (typeof strategyFocuses)[number];

const strategyReviewDecisionSchema = z
  .object({
    focus: z.enum(strategyFocuses),
    /** 探索焦点方块（可选；须在允许集合内，sanitize 兜底）。 */
    explorationBlock: z
      .string()
      .regex(/^[a-z0-9_]+$/u)
      .max(64)
      .nullable()
      .optional(),
    /** 立场建议（可选；走 combat.stance 白名单）。 */
    stance: z
      .enum(["preserve-life", "expendable", "aggressive"])
      .nullable()
      .optional(),
    /** 一句话理由（给人看的日志，不是执行输入）。 */
    rationale: z.string().max(200).nullable().optional(),
  })
  .strict();

export type StrategyReviewDecision = Readonly<{
  focus: StrategyFocus;
  explorationBlock: string | null;
  stance: "preserve-life" | "expendable" | "aggressive" | null;
  rationale: string | null;
}>;

/** 探索焦点方块白名单（全部是资源图内可确定性采集的目标）。 */
export const ALLOWED_EXPLORATION_BLOCKS: ReadonlySet<string> = new Set([
  "oak_log",
  "stone",
  "coal_ore",
  "iron_ore",
  "diamond_ore",
  "deepslate_diamond_ore",
]);

/** 战略重心 → 需求键加权（survival-needs 消费）。只加权，不减分。 */
export const FOCUS_NEED_BOOSTS: Readonly<
  Record<StrategyFocus, Readonly<Record<string, number>>>
> = Object.freeze({
  "survival-basics": Object.freeze({
    FOOD_SECURITY: 15,
    SHELTER: 10,
    TOOL_PROGRESSION: 5,
  }),
  "tool-progression": Object.freeze({
    TOOL_PROGRESSION: 15,
    TOOL_RECOVERY: 10,
    WOOD_RESERVE: 5,
  }),
  defense: Object.freeze({
    WEAPON: 15,
    WEAPON_RECOVERY: 12,
    ARMOR: 12,
    EQUIP_ARMOR: 12,
    SHIELD: 10,
  }),
  "resource-stockpile": Object.freeze({
    WOOD_RESERVE: 10,
    COAL_RESERVE: 10,
    IRON_RESERVE: 12,
    FOOD_SECURITY: 8,
    TORCH: 5,
  }),
  exploration: Object.freeze({
    EXPLORATION: 25,
    DIAMOND_PROGRESSION: 8,
  }),
  "base-building": Object.freeze({
    SHELTER: 12,
    CHEST: 12,
    WOOD_RESERVE: 8,
  }),
});

export function buildStrategyReviewPrompt(input: Readonly<{
  botId: string;
  focusWindowMinutes: number;
  safeFoodCount: number;
  pickaxeTier: string;
  hasSword: boolean;
  armorPoints: number;
  woodUnits: number;
  coalUnits: number;
  ironUnits: number;
  recentNeeds: readonly string[];
  recentFailures: readonly string[];
  deaths: number;
}>): string {
  return JSON.stringify({
    promptVersion: "strategy-review-v1",
    situation:
      "Periodic strategic review of a survival bot on an anarchy Minecraft server. Pick the next focus.",
    windowMinutes: input.focusWindowMinutes,
    bot: {
      safeFood: input.safeFoodCount,
      bestPickaxe: input.pickaxeTier,
      hasSword: input.hasSword,
      armorPoints: input.armorPoints,
      woodUnits: input.woodUnits,
      coalUnits: input.coalUnits,
      ironUnits: input.ironUnits,
      deathsRecently: input.deaths,
    },
    recentNeedsSelected: input.recentNeeds.slice(-12),
    recentFailures: input.recentFailures.slice(-8),
    menu: strategyFocuses,
    answerAs:
      "one JSON object {focus, explorationBlock, stance, rationale}; explorationBlock only from [" +
      [...ALLOWED_EXPLORATION_BLOCKS].join(",") +
      "] and only when focus is exploration",
  });
}

export async function askStrategyReview(options: {
  ai: { generate: ScheduledAIRouter["generate"] };
  requestId: string;
  botId: string;
  traceId: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<StrategyReviewDecision | null> {
  let ai: AIScheduledResult<GenerateResult>;
  try {
    ai = await options.ai.generate({
      requestId: options.requestId,
      botId: options.botId,
      priority: aiRequestPriorities.planning,
      supersedeKey: `strategy-review:${options.botId}`,
      prompt: options.prompt,
      systemPrompt:
        "You are the strategy layer for a Minecraft survival agent. Answer with exactly one JSON object matching the schema. Keep rationale under 30 words.",
      schema: strategyReviewDecisionSchema,
      maxTokens: 160,
      temperature: 0.2,
      timeoutMs: STRATEGY_REVIEW_TIMEOUT_MS,
      traceId: options.traceId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    return null;
  }
  let decision: z.infer<typeof strategyReviewDecisionSchema>;
  try {
    decision = parseStructuredOutput(ai.value.content, {
      name: "strategy-review-decision",
      schema: strategyReviewDecisionSchema,
    });
  } catch {
    return null;
  }
  return {
    focus: decision.focus,
    explorationBlock: decision.explorationBlock ?? null,
    stance: decision.stance ?? null,
    rationale: decision.rationale ?? null,
  };
}

/** 收敛决策：探索焦点方块必须在白名单内；非探索重心丢弃方块参数。 */
export function sanitizeStrategyReviewDecision(
  decision: StrategyReviewDecision,
): StrategyReviewDecision {
  const focus = decision.focus;
  const explorationBlock =
    focus === "exploration" && decision.explorationBlock &&
    ALLOWED_EXPLORATION_BLOCKS.has(decision.explorationBlock)
      ? decision.explorationBlock
      : null;
  return {
    focus,
    explorationBlock,
    stance: decision.stance,
    rationale: decision.rationale,
  };
}

export function strategyReviewRequestId(botId: string): string {
  return identifierSchema.parse(`strategy-${botId}-${Date.now()}`);
}
