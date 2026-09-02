import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { blockWithinPolicyReach } from "./reach.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 合成技能，自研（mineflayer 原生 bot.recipesFor + bot.craft，无第三方插件）。
// 生存链条的核心一环：撸木→合成工作台/木镐→撸石→石器→铁器全靠它。
// 需要工作台的配方必须显式给 craftingTable 坐标——技能不会自己乱跑找方块，
// 寻路由 movement.goto 负责，职责分离。
// ---------------------------------------------------------------------------

export const CRAFT_ITEM_TIMEOUT_MS = 20_000;
export const CRAFT_MAX_COUNT = 64;
// Internal plans may need more than one stack of an intermediate ingredient
// even when the operator's final goal is bounded to 64 items.
export const CRAFT_CAPABILITY_MAX_COUNT = 4_096;

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
    // runtime 快照附带朝向角（与 movement-goto 同一形状）：strict 下缺失会拒真状态
    yaw: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
  })
  .strict();

export const craftItemInputSchema = z
  .object({
    itemName: itemNameSchema,
    // Desired minimum count in inventory. The runtime checks the shortfall
    // before crafting, but a timeout or partial acknowledgement can still
    // leave the write outcome uncertain.
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
    requestedCount: z.number().int().min(1).max(CRAFT_CAPABILITY_MAX_COUNT),
    // 库存实际增量（合成后读回），不是"配方理论产量"。已经满足目标时为 0。
    craftedCount: z.number().int().min(0),
    usedCraftingTable: z.boolean(),
  })
  .strict();

export const craftItemCapabilityInputSchema = craftItemInputSchema.extend({
  count: z.number().int().min(1).max(CRAFT_CAPABILITY_MAX_COUNT),
});
export const craftItemCapabilityOutputSchema = craftItemOutputSchema;

export const craftItemSkill = defineSkill({
  id: "craft.item",
  version: "1.0.0",
  progressContract: "INVENTORY_CHANGE",
  inputSchema: craftItemInputSchema,
  outputSchema: craftItemOutputSchema,
  stateSchema: craftItemStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["craft.execute"] as const,
  timeoutMs: CRAFT_ITEM_TIMEOUT_MS,
  // 合成会消耗材料，在协调器能够确认完整结果之前可能已经产生副作用；
  // 对不确定或部分结果禁止自动重放。
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
      // 距离上限由当前 ServerPolicy 给出，不写死 4.5：STRICT 档只有 3.8 格。
      check: (input, state, policy) =>
        input.craftingTable === null ||
        (state.position !== null &&
          blockWithinPolicyReach(input.craftingTable, state.position, policy)),
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "craft.execute",
      "craft.item-safe",
      craftItemCapabilityInputSchema.parse(input),
    ),
});
