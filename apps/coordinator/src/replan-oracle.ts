// ---------------------------------------------------------------------------
// ReplanOracle —— 模型只在"确定性恢复梯走完之后"发言，且只能从白名单里选。
//
// 定位（对应总任务书"Local Planner 多次失败后的 Replan"与 AGENTS.md 三层
// 架构的战略层）：同一需求连续失败到触发抑制时，盲目的扇区轮转已经在
// 原地打转。此时给模型一份紧凑的事实摘要，让它从**确定性菜单**里挑一个
// 替代策略：换探索焦点、拉远探索半径、延长搁置、或改采替代资源。
//
// 安全边界：输出经 schema 收敛成 4 个枚举动作 + 一个受白名单约束的参数；
// 不产出坐标、不产出技能调用、不接触世界状态。模型不可用/超时/输出不合法
// 时静默回退到默认确定性策略（扇区轮转），自主生存不依赖这一步。
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

import type { SurvivalNeedKey } from "./survival-needs.js";

export const REPLAN_ORACLE_TIMEOUT_MS = 8_000;

export const replanStrategies = [
  "rotate-sector",
  "widen-exploration",
  "defer-longer",
  "substitute-resource",
  /** 切换战斗立场（受信菜单项：只有三个白名单立场可选）。 */
  "combat-stance",
] as const;

export const replanStances = [
  "preserve-life",
  "expendable",
  "aggressive",
] as const;

export type ReplanStance = (typeof replanStances)[number];

export type ReplanStrategy = (typeof replanStrategies)[number];

const replanDecisionSchema = z
  .object({
    strategy: z.enum(replanStrategies),
    /** substitute-resource 时必填，其余必须为 null/缺省。 */
    substituteItem: z
      .string()
      .regex(/^[a-z0-9_]+$/u)
      .max(64)
      .nullable()
      .optional(),
    /** widen-exploration / defer-longer 的档位参数。 */
    magnitude: z.enum(["small", "medium", "large"]).nullable().optional(),
    /** combat-stance 时必填，其余必须为 null/缺省。 */
    stance: z.enum(replanStances).nullable().optional(),
  })
  .strict();

export type ReplanDecision = Readonly<{
  strategy: ReplanStrategy;
  substituteItem: string | null;
  magnitude: "small" | "medium" | "large" | null;
  stance: ReplanStance | null;
}>;

/** 各需求允许的替代资源（全部在确定性资源图与别名表内）。 */
const SUBSTITUTIONS: Readonly<Record<SurvivalNeedKey, readonly string[]>> = Object.freeze({
  WOOD_RESERVE: Object.freeze(["oak_log"]),
  COAL_RESERVE: Object.freeze(["coal", "charcoal"]),
  IRON_RESERVE: Object.freeze(["raw_iron"]),
  TOOL_PROGRESSION: Object.freeze([]),
  TOOL_RECOVERY: Object.freeze([]),
  WEAPON: Object.freeze([]),
  WEAPON_RECOVERY: Object.freeze([]),
  ARMOR: Object.freeze([]),
  EQUIP_ARMOR: Object.freeze([]),
  DEATH_RECOVERY: Object.freeze([]),
  SHIELD: Object.freeze([]),
  SHELTER: Object.freeze([]),
  BED: Object.freeze([]),
  FOOD_SECURITY: Object.freeze([]),
  DIAMOND_PROGRESSION: Object.freeze(["diamond"]),
  DIAMOND_ARMOR: Object.freeze(["diamond"]),
  DIAMOND_TOOLS: Object.freeze(["diamond"]),
  DIAMOND_WEAPON: Object.freeze(["diamond"]),
  BASE_SITE_SELECTION: Object.freeze([]),
  BASE_MAIN_CONSTRUCTION: Object.freeze([]),
  BASE_FACILITY_COBBLE: Object.freeze([]),
  BASE_FACILITY_FARM: Object.freeze([]),
  BASE_FARM_MAINTENANCE: Object.freeze([]),
  BASE_RETURN: Object.freeze([]),
  TORCH: Object.freeze(["torch"]),
  CHEST: Object.freeze(["chest"]),
  RECON_PATROL: Object.freeze([]),
  EXPLORATION: Object.freeze([]),
});

export function substitutionAllowlist(needKey: SurvivalNeedKey): readonly string[] {
  return SUBSTITUTIONS[needKey] ?? [];
}

/** 模型可见的紧凑事实摘要。刻意不含坐标/服务器身份（AGENTS.md 保密面）。 */
export function buildReplanPrompt(input: Readonly<{
  needKey: SurvivalNeedKey;
  reason: string;
  failures: number;
  safeFoodCount: number;
  pickaxeTier: string;
  substitutes: readonly string[];
}>): string {
  return JSON.stringify({
    promptVersion: "replan-oracle-v1",
    situation:
      "A deterministic survival need has failed repeatedly; pick ONE alternate strategy from the menu.",
    need: input.needKey,
    needReason: input.reason,
    consecutiveFailures: input.failures,
    botSummary: {
      safeFoodCount: input.safeFoodCount,
      bestPickaxe: input.pickaxeTier,
    },
    menu: [
      { strategy: "rotate-sector", meaning: "keep the need, explore the next ring sector" },
      { strategy: "widen-exploration", meaning: "explore much farther out (magnitude: small|medium|large)" },
      { strategy: "defer-longer", meaning: "park this need longer and work on others (magnitude: small|medium|large)" },
      { strategy: "substitute-resource", meaning: "acquire an alternative item that fills the same need (substituteItem must be from allowedSubstitutes)" },
      { strategy: "combat-stance", meaning: "switch combat stance (stance: preserve-life|expendable|aggressive)" },
    ],
    allowedSubstitutes: input.substitutes,
    answerAs: "a single JSON object {strategy, substituteItem, magnitude}",
  });
}

/**
 * 向模型要一次重规划决策。任何失败都返回 null：调用方使用默认确定性策略。
 */
export async function askReplanOracle(options: {
  ai: Pick<ScheduledAIRouter, "generate">;
  requestId: string;
  botId: string;
  traceId: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<ReplanDecision | null> {
  let ai: AIScheduledResult<GenerateResult>;
  try {
    ai = await options.ai.generate({
      requestId: options.requestId,
      botId: options.botId,
      priority: aiRequestPriorities.planning,
      supersedeKey: `replan:${options.botId}`,
      prompt: options.prompt,
      systemPrompt:
        "You are a strategy selector for a Minecraft survival agent. Answer with exactly one JSON object matching the schema. Never invent items outside allowedSubstitutes.",
      schema: replanDecisionSchema,
      maxTokens: 128,
      temperature: 0,
      timeoutMs: REPLAN_ORACLE_TIMEOUT_MS,
      traceId: options.traceId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    return null;
  }
  let decision: z.infer<typeof replanDecisionSchema>;
  try {
    decision = parseStructuredOutput(ai.value.content, {
      name: "replan-decision",
      schema: replanDecisionSchema,
    });
  } catch {
    return null;
  }
  return {
    strategy: decision.strategy,
    substituteItem: decision.substituteItem ?? null,
    magnitude: decision.magnitude ?? null,
    stance: decision.stance ?? null,
  };
}

/**
 * 校验并收敛决策：substitute 必须在白名单内，其余策略丢弃非法参数。
 * 这一层保证即使模型输出被劫持，可用动作也只剩确定性菜单。
 */
export function sanitizeReplanDecision(
  decision: ReplanDecision,
  needKey: SurvivalNeedKey,
): ReplanDecision {
  const fallback: ReplanDecision = {
    strategy: "rotate-sector",
    substituteItem: null,
    magnitude: null,
    stance: null,
  };
  if (decision.strategy === "substitute-resource") {
    const allowed = substitutionAllowlist(needKey);
    if (!decision.substituteItem || !allowed.includes(decision.substituteItem)) {
      return fallback;
    }
    return { ...decision, magnitude: null, stance: null };
  }
  if (decision.strategy === "combat-stance") {
    if (!decision.stance) return fallback;
    return { ...decision, substituteItem: null, magnitude: null };
  }
  return {
    strategy: decision.strategy,
    substituteItem: null,
    magnitude: decision.magnitude,
    stance: null,
  };
}

export function replanRequestId(botId: string): string {
  return identifierSchema.parse(`replan-${botId}`);
}
