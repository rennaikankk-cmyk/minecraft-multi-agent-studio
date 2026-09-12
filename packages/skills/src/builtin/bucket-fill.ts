import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { blockWithinPolicyReach } from "./reach.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// bucket.fill —— 装满一个桶（水/岩浆）。
//
// 与 fluid.place 的关系：fluid.place 是"倒出去 / 吸掉一格"，本技能是"拿空桶
// 对着一格液体源装满"。三条原语合起来才是完整的桶生命周期：
//   bucket.fill（装满）→ fluid.place(mode=place)（倒出）→ fluid.place(mode=scoop)（回收）
//
// 生存价值：水桶是灭火、坠落缓冲（落地放水）、刷石机、下界赶路的通用工具；
// 岩浆桶是燃料与陷阱。空桶本身没有用处，装桶才把它变成资源。
//
// 读回是**双证据**（缺一不可）：
//   1. 背包：对应满桶 +1 **且** 空桶 -1；
//   2. 方块：目标格的液体读数如实上报（装桶后源方块变 air/消失）。
// 只看"+1 个满桶"不够——那也可能是别处捡的；只看"-1 个空桶"也不够——那也可能是
// 桶被别的动作消耗掉了。
//
// 为什么非幂等：一次装桶消耗一个空桶，重复执行会连装（直到没有空桶）。
// 与 fluid.place 同档处理：maxAttempts=1，不给盲重试。
// ---------------------------------------------------------------------------

export const BUCKET_FILL_TIMEOUT_MS = 12_000;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

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
    yaw: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
  })
  .strict();

export const bucketFillInputSchema = z
  .object({
    /** 装什么：water → water_bucket，lava → lava_bucket。 */
    mode: z.enum(["water", "lava"]),
    /** 液体**源**方块坐标（流动水/岩浆不可装；1.13+ 的源头方块语义）。 */
    target: blockPositionSchema,
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const bucketFillStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
    /** 背包中 bucket/water_bucket/lava_bucket 计数（null = 快照不可用 → fail-closed）。 */
    bucketCounts: z
      .object({
        bucket: z.number().int().min(0).nullable(),
        water_bucket: z.number().int().min(0).nullable(),
        lava_bucket: z.number().int().min(0).nullable(),
      })
      .strip()
      .nullable()
      .optional(),
  })
  .strip();

export const bucketFillOutputSchema = z
  .object({
    /** 只有双证据都成立才会返回这个对象；字段全部是读回事实。 */
    succeeded: z.literal(true),
    mode: z.enum(["water", "lava"]),
    /** 读回：装到的满桶物品名。 */
    filledItemName: z.enum(["water_bucket", "lava_bucket"]),
    /** 读回：空桶计数（必须 -1）。 */
    emptyBucketBefore: z.number().int().min(0),
    emptyBucketAfter: z.number().int().min(0),
    /** 读回：对应满桶计数（必须 +1）。 */
    filledBucketBefore: z.number().int().min(0),
    filledBucketAfter: z.number().int().min(0),
    /** 读回：目标格现在的方块名（water/lava/air/…），如实上报不美化。 */
    resultingBlockName: z.string().min(1).max(64),
    position: blockPositionSchema,
  })
  .strict()
  // 读回自洽性：mode 与装到的桶必须一致。不一致的记录本身就是**假证据**
  // （"我要装水、读回却是岩浆桶"），宁可让 schema 拒绝，也不让它流到上层。
  .refine(
    (output) =>
      output.mode === "water"
        ? output.filledItemName === "water_bucket"
        : output.filledItemName === "lava_bucket",
    { message: "filledItemName must match the requested mode" },
  );

export const bucketFillCapabilityInputSchema = bucketFillInputSchema;
export const bucketFillCapabilityOutputSchema = bucketFillOutputSchema;

export const bucketFillSkill = defineSkill({
  id: "bucket.fill",
  version: "1.0.0",
  progressContract: "INVENTORY_CHANGE",
  inputSchema: bucketFillInputSchema,
  outputSchema: bucketFillOutputSchema,
  stateSchema: bucketFillStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  // 只碰背包（装备空桶）与方块（对着液体源 use_item）；不移动。
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: BUCKET_FILL_TIMEOUT_MS,
  // 非幂等：装一次消耗一个空桶，重复执行会连装（与 fluid.place 同档）。
  idempotent: false,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 100,
    maxDelayMs: 300,
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
      id: "bucket.snapshot-known",
      failureCode: "INVENTORY_COUNT_UNKNOWN",
      check: (_input, state) => state.bucketCounts != null,
    },
    {
      id: "bucket.held",
      failureCode: "FLUID_BUCKET_MISSING",
      check: (_input, state) => (state.bucketCounts?.bucket ?? 0) >= 1,
    },
    {
      id: "target.within-reach",
      failureCode: "TARGET_OUT_OF_REACH",
      check: (input, state, policy) =>
        state.position !== null &&
        blockWithinPolicyReach(input.target, state.position, policy),
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "world.interact",
      "fluid.fill-safe",
      bucketFillCapabilityInputSchema.parse(input),
    ),
});
