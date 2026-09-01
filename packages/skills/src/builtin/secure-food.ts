import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 主动食物储备技能。L0 的 HUNGER 反应是"快饿死了才动手"，而且是 20 秒预算
// 的一次性动作；自主生存需要的是**提前**把安全食物补到一个储备水位，这
// 样长时间挖矿/探索期间 L0 永远有东西可吃。
//
// 实现完全复用 Runtime 侧 L0 forage 的同一套确定性机器（掉落物 → 成熟
// 作物 → 被动生物 → 八方向短探索），只是把"拿到任意 1 份就停"换成
// "补到 targetCount 或预算耗尽"。技能幂等：已达标时立即成功。
// ---------------------------------------------------------------------------

export const SECURE_FOOD_TIMEOUT_MS = 120_000;
export const SECURE_FOOD_MAX_TARGET = 32;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

export const secureFoodInputSchema = z
  .object({
    targetCount: z.number().int().min(1).max(SECURE_FOOD_MAX_TARGET),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

const observedPositionSchema = z
  .object({
    x: z.number().finite().min(-30_000_000).max(30_000_000),
    y: z.number().finite().min(-2_048).max(2_048),
    z: z.number().finite().min(-30_000_000).max(30_000_000),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    // runtime 快照附带朝向角（与 movement-goto 同一形状）：strict 下缺失会拒真状态
    yaw: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
  })
  .strict();

export const secureFoodStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

export const secureFoodOutputSchema = z
  .object({
    /** 结束时背包里的安全食物总数（读回，不是计划值）。 */
    safeFoodCount: z.number().int().min(0).max(2_304),
    targetCount: z.number().int().min(1).max(SECURE_FOOD_MAX_TARGET),
    /** 安全食物总数是否达到目标。预算耗尽而未达标时如实为 false。 */
    targetReached: z.boolean(),
    /** 本轮实际新获得的安全食物份数（读回差值）。 */
    secured: z.number().int().min(0).max(SECURE_FOOD_MAX_TARGET),
    /**
     * 未达标时的诚实原因码：NO_SAFE_FOOD_SOURCE 附近确实没有食物来源；
     * BUDGET_EXHAUSTED 预算先到。两者都算 completed——技能如实报告
     * 观测结果，补给与否由上层根据水位重新评估。
     */
    reasonCode: z.enum(["TARGET_REACHED", "NO_SAFE_FOOD_SOURCE", "BUDGET_EXHAUSTED"]),
  })
  .strict();

export const secureFoodCapabilityInputSchema = secureFoodInputSchema;
export const secureFoodCapabilityOutputSchema = secureFoodOutputSchema;

export const secureFoodSkill = defineSkill({
  id: "food.secure",
  version: "1.0.0",
  inputSchema: secureFoodInputSchema,
  outputSchema: secureFoodOutputSchema,
  stateSchema: secureFoodStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: SECURE_FOOD_TIMEOUT_MS,
  idempotent: true,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 100,
    maxDelayMs: 500,
    retryableErrorCodes: [],
  },
  preconditions: [
    {
      id: "bot.online",
      failureCode: "BOT_NOT_ONLINE",
      check: (_input, state) => state.online,
    },
    {
      id: "l0.normal-actions-allowed",
      failureCode: "NORMAL_ACTIONS_PAUSED",
      check: (_input, state) => state.normalActionsAllowed,
    },
    {
      id: "target.server-profile-matches",
      failureCode: "TARGET_SERVER_PROFILE_MISMATCH",
      check: (input, state) => input.serverProfileId === state.serverProfileId,
    },
    {
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input, state) =>
        state.position !== null && input.dimension === state.position.dimension,
    },
  ],
  execute: async (context, input) =>
    secureFoodCapabilityOutputSchema.parse(
      await context.callCapability(
        "world.interact",
        "food.forage-safe",
        secureFoodCapabilityInputSchema.parse(input),
      ),
    ),
});
