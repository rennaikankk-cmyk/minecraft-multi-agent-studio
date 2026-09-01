import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import {
  MINIMUM_INCOMING_SLOTS,
  inventoryHasRoomFor,
  observedInventorySchema,
} from "./inventory-space.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 采集底座技能。底层直接依赖 MIT 许可的 mineflayer-collectblock 1.6.0（供应链
// 已按 P1.2.1 流程锁定，见 SECURITY.md）。插件永不直接暴露给 AI 或任务层——
// 本技能是唯一入口：声明式输入、前置条件、单一能力调用，L0 可随时中断。
// ---------------------------------------------------------------------------

export const COLLECT_BLOCK_TIMEOUT_MS = 60_000;
export const COLLECT_MAX_COUNT = 64;
// 无规则服强度优先：半径上限直接拉满（findBlocks 有 count 截断，稀疏目标
// 才会吃满扫描面积）。反作弊兼容档位不受此影响——那是每动作合法性，
// 不是"找多远"。
export const COLLECT_MAX_DISTANCE = 64;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const blockNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);

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

export const collectBlockInputSchema = z
  .object({
    blockName: blockNameSchema,
    maxCount: z.number().int().min(1).max(COLLECT_MAX_COUNT),
    maxDistance: z.number().int().min(2).max(COLLECT_MAX_DISTANCE),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const collectBlockStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
    // 观测不到时为 null，前置条件按"没位置"拒绝（fail-closed）。
    inventory: observedInventorySchema.nullable(),
  })
  .strip();

export const collectBlockOutputSchema = z
  .object({
    blockName: blockNameSchema,
    // 实际找到并交给采集器的目标方块数（≤ maxCount）。
    targetsFound: z.number().int().min(0).max(COLLECT_MAX_COUNT),
    // 库存总数增量（按背包所有物品计——石头挖出来是圆石，掉落物名可能
    // 不等于方块名，所以用总量增量做诚实遥测，不假设掉落映射）。
    itemsCollected: z.number().int().min(0),
  })
  .strict();

export const collectBlockCapabilityInputSchema = collectBlockInputSchema;
export const collectBlockCapabilityOutputSchema = collectBlockOutputSchema;

export const collectBlockSkill = defineSkill({
  id: "collect.block",
  version: "1.0.0",
  progressContract: "INVENTORY_CHANGE",
  inputSchema: collectBlockInputSchema,
  outputSchema: collectBlockOutputSchema,
  stateSchema: collectBlockStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: COLLECT_BLOCK_TIMEOUT_MS,
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
      // 背包满了就别开工：采集器会照样挖满 60 秒，掉落物落地无人捡，
      // 技能却报成功。宁可现在拒绝，让上层先去存箱子。
      id: "inventory.has-room",
      failureCode: "INVENTORY_FULL",
      check: (_input, state) =>
        inventoryHasRoomFor(state.inventory, MINIMUM_INCOMING_SLOTS),
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "world.interact",
      "collect.blocks-safe",
      collectBlockCapabilityInputSchema.parse(input),
    ),
});
