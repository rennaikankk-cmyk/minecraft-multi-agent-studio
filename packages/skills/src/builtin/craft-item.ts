import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 合成技能，自研（mineflayer 原生 bot.recipesFor + bot.craft，无第三方插件）。
// 生存链条的核心一环：撸木→合成工作台/木镐→撸石→石器→铁器全靠它。
// 需要工作台的配方必须显式给 craftingTable 坐标——技能不会自己乱跑找方块，
// 寻路由 movement.goto 负责，职责分离。
// ---------------------------------------------------------------------------

export const CRAFT_ITEM_TIMEOUT_MS = 20_000;
export const CRAFT_MAX_COUNT = 64;
/** 工作台必须在伸手可及范围内（与原版交互距离一致，留 0.5 余量）。 */
export const CRAFTING_TABLE_MAX_DISTANCE = 4.5;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const itemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);

const blockPositionSchema = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2_048).max(2_048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  })
  .strict();

const observedPositionSchema = z
  .object({
    x: z.number().finite().min(-30_000_000).max(30_000_000),
    y: z.number().finite().min(-2_048).max(2_048),
    z: z.number().finite().min(-30_000_000).max(30_000_000),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const craftItemInputSchema = z
  .object({
    itemName: itemNameSchema,
    count: z.number().int().min(1).max(CRAFT_MAX_COUNT),
    // null = 只允许 2x2 随身合成；给坐标 = 用该处工作台（3x3）。
    craftingTable: blockPositionSchema.nullable(),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const craftItemStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

export const craftItemOutputSchema = z
  .object({
    itemName: itemNameSchema,
    requestedCount: z.number().int().min(1).max(CRAFT_MAX_COUNT),
    // 库存实际增量（合成后读回），不是"配方理论产量"。不伪造成功。
    craftedCount: z.number().int().min(0),
    usedCraftingTable: z.boolean(),
  })
  .strict();

export const craftItemCapabilityInputSchema = craftItemInputSchema;
export const craftItemCapabilityOutputSchema = craftItemOutputSchema;

function tableWithinReach(
  table: { x: number; y: number; z: number },
  position: { x: number; y: number; z: number },
): boolean {
  return (
    Math.hypot(
      table.x + 0.5 - position.x,
      table.y + 0.5 - position.y,
      table.z + 0.5 - position.z,
    ) <= CRAFTING_TABLE_MAX_DISTANCE
  );
}

export const craftItemSkill = defineSkill({
  id: "craft.item",
  version: "1.0.0",
  inputSchema: craftItemInputSchema,
  outputSchema: craftItemOutputSchema,
  stateSchema: craftItemStateSchema,
  requiredCapabilities: ["craft.execute"] as const,
  timeoutMs: CRAFT_ITEM_TIMEOUT_MS,
  // 合成部分成功后重试会重复消耗材料，禁止自动重试。
  idempotent: false,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 50,
    maxDelayMs: 250,
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
    {
      id: "crafting-table.within-reach",
      failureCode: "CRAFTING_TABLE_OUT_OF_REACH",
      check: (input, state) =>
        input.craftingTable === null ||
        (state.position !== null &&
          tableWithinReach(input.craftingTable, state.position)),
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "craft.execute",
      "craft.item-safe",
      craftItemCapabilityInputSchema.parse(input),
    ),
});
