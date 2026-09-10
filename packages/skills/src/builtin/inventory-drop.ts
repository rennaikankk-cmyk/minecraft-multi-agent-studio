import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 丢弃物品技能（bot.toss / tossStack 原语）。
// 用途：①背包满（INVENTORY_FULL）时卸载低价值物品恢复采集能力；
// ②多 Bot 物资交接（drop 给队友拾取）；③清垃圾。
// 只在脚下丢弃——不做投掷弹道（那是实体物理，不可靠且反作弊敏感）。
// 幂等语义：按剩余数量有界重试（数量对账，不重复丢）。
// ---------------------------------------------------------------------------

export const INVENTORY_DROP_TIMEOUT_MS = 8_000;

const itemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

export const inventoryDropInputSchema = z
  .object({
    itemName: itemNameSchema,
    count: z.number().int().min(1).max(2_304),
    /** 期望丢完后背包里该物品的剩余数（默认 0 = 全丢）。 */
    keepReserve: z.number().int().min(0).max(2_304).default(0),
    serverProfileId: identifierSchema,
  })
  .strict();

export const inventoryDropStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        z: z.number().finite(),
        dimension: dimensionSchema,
        serverProfileId: identifierSchema,
        yaw: z.number().finite().optional(),
        pitch: z.number().finite().optional(),
      })
      .strip()
      .nullable(),
    /** 背包快照中该物品当前总数；未知 = null（拒绝执行，fail-closed）。 */
    heldItemCount: z.number().int().min(0).nullable().optional(),
  })
  .strip();

export const inventoryDropOutputSchema = z
  .object({
    dropped: z.literal(true),
    itemName: itemNameSchema,
    count: z.number().int().min(1).max(2_304),
    /** 丢完后背包剩余（服务器回执对账后的真值）。 */
    remainingCount: z.number().int().min(0),
  })
  .strict();

export const inventoryDropCapabilityInputSchema = inventoryDropInputSchema;
export const inventoryDropCapabilityOutputSchema = inventoryDropOutputSchema;

export const inventoryDropSkill = defineSkill({
  id: "inventory.drop",
  version: "1.0.0",
  progressContract: "INVENTORY_CHANGE",
  inputSchema: inventoryDropInputSchema,
  outputSchema: inventoryDropOutputSchema,
  stateSchema: inventoryDropStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["inventory.write"] as const,
  timeoutMs: INVENTORY_DROP_TIMEOUT_MS,
  // 丢弃是背包单调减少：重复执行不会多丢（数量对账），安全重试。
  idempotent: true,
  retryPolicy: {
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 1_000,
    retryableErrorCodes: ["INVENTORY_DROP_NOT_SETTLED"],
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
      id: "inventory.count-known",
      failureCode: "INVENTORY_COUNT_UNKNOWN",
      check: (_input, state) => state.heldItemCount != null,
    },
    {
      id: "inventory.enough-items",
      failureCode: "INVENTORY_INSUFFICIENT_ITEMS",
      check: (input, state) =>
        state.heldItemCount != null &&
        state.heldItemCount >= input.count + (input.keepReserve ?? 0),
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "inventory.write",
      "inventory.drop-safe",
      inventoryDropCapabilityInputSchema.parse(input),
    ),
});
