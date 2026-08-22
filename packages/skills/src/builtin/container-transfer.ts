import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import {
  MINIMUM_INCOMING_SLOTS,
  inventoryHasRoomFor,
  observedInventorySchema,
} from "./inventory-space.js";
import { blockWithinPolicyReach } from "./reach.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 箱子存取技能，自研（mineflayer 原生 openContainer + deposit/withdraw）。
// 基地存储与后勤的底座：分类入库、按角色补货套件都建立在"把 N 个 X 从背包
// 移到坐标 (x,y,z) 的箱子 / 反向取出"这一个原子动作上。
// 遥测报"实际移动数量"（操作前后读回背包差值），不伪造成功。
// ---------------------------------------------------------------------------

export const CONTAINER_TRANSFER_TIMEOUT_MS = 15_000;
export const TRANSFER_MAX_COUNT = 27 * 64;

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

export const containerTransferInputSchema = z
  .object({
    // deposit = 背包→箱子；withdraw = 箱子→背包。
    direction: z.enum(["deposit", "withdraw"]),
    itemName: itemNameSchema,
    count: z.number().int().min(1).max(TRANSFER_MAX_COUNT),
    container: blockPositionSchema,
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const containerTransferStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
    // 只有 withdraw 方向用得上；deposit 不占新槽，见 inventory.has-room。
    inventory: observedInventorySchema.nullable(),
  })
  .strip();

export const containerTransferOutputSchema = z
  .object({
    direction: z.enum(["deposit", "withdraw"]),
    itemName: itemNameSchema,
    requestedCount: z.number().int().min(1).max(TRANSFER_MAX_COUNT),
    // 实际移动数量 = 操作前后背包该物品数量差的绝对值（读回，非理论值）。
    // 少于请求量（箱子满/物品不够）如实上报，由上层决定下一步。
    movedCount: z.number().int().min(0).max(TRANSFER_MAX_COUNT),
  })
  .strict();

export const containerTransferCapabilityInputSchema =
  containerTransferInputSchema;
export const containerTransferCapabilityOutputSchema =
  containerTransferOutputSchema;

export const containerTransferSkill = defineSkill({
  id: "container.transfer",
  version: "1.0.0",
  inputSchema: containerTransferInputSchema,
  outputSchema: containerTransferOutputSchema,
  stateSchema: containerTransferStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  // 读写都要：开箱清点是读，存取是写。
  requiredCapabilities: ["container.read", "container.write"] as const,
  timeoutMs: CONTAINER_TRANSFER_TIMEOUT_MS,
  // 部分转移后重试会造成重复搬运，禁止自动重试；幂等收敛由上层用
  // movedCount 反馈决定是否续搬。
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
      id: "container.within-reach",
      failureCode: "CONTAINER_OUT_OF_REACH",
      // 上限来自当前 ServerPolicy，不是技能里的常量。
      check: (input, state, policy) =>
        state.position !== null &&
        blockWithinPolicyReach(input.container, state.position, policy),
    },
    {
      // 取货才需要背包位置；存货是往外放，永远放行（incomingSlots 传 0）。
      // 方向敏感是刻意的：一刀切会让"背包满了去存箱子"这条唯一自救路径也被拦死。
      id: "inventory.has-room",
      failureCode: "INVENTORY_FULL",
      check: (input, state) =>
        inventoryHasRoomFor(
          state.inventory,
          input.direction === "withdraw" ? MINIMUM_INCOMING_SLOTS : 0,
        ),
    },
  ],
  execute: async (context, input) => {
    // 存与取都改变箱子内容，统一走 container.write；container.read 声明
    // 用于开箱清点（能力授权层面把"看箱子"也纳入显式授权）。
    const raw = await context.callCapability(
      "container.write",
      "container.transfer-safe",
      containerTransferCapabilityInputSchema.parse(input),
    );
    return containerTransferCapabilityOutputSchema.parse(raw);
  },
});
