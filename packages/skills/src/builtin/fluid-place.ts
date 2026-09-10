import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { blockWithinPolicyReach } from "./reach.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 液体操作技能（桶）。两种模式：
//   place：手持水桶/岩浆桶，对参照方块的指定面倾倒（流体落在邻格）。
//   scoop：手持空桶，对指定坐标的液体源方块吸取。
// 生存价值：农田供水已在 farm.sustain 内部走同原语；本技能把它开放为
// 原子能力——灭火自救、刷石机的岩浆补给、清理误放的流体都靠它。
// 1.13+ 水源方块含水机制：scoop 目标必须是 source（流动水不可吸）。
// ---------------------------------------------------------------------------

export const FLUID_PLACE_TIMEOUT_MS = 12_000;

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
    yaw: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
  })
  .strict();

const faceVectorSchema = z
  .object({
    x: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    y: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    z: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  })
  .strict()
  .refine(
    (face) => Math.abs(face.x) + Math.abs(face.y) + Math.abs(face.z) === 1,
    { message: "face must be a unit axis vector" },
  );

export const fluidPlaceInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("place"),
      /** water_bucket | lava_bucket（必须已持有）。 */
      itemName: z.enum(["water_bucket", "lava_bucket"]),
      /** 倾倒参照：流体将出现在 referenceBlock+face。 */
      referenceBlock: blockPositionSchema,
      face: faceVectorSchema,
      dimension: dimensionSchema,
      serverProfileId: identifierSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("scoop"),
      /** 目标液体源方块坐标。 */
      target: blockPositionSchema,
      dimension: dimensionSchema,
      serverProfileId: identifierSchema,
    })
    .strict(),
]);

export const fluidPlaceStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
    /** 背包中 water_bucket/lava_bucket/bucket 计数（null = 快照不可用，fail-closed）。 */
    bucketCounts: z
      .object({
        bucket: z.number().int().min(0).nullable(),
        water_bucket: z.number().int().min(0).nullable(),
        lava_bucket: z.number().int().min(0).nullable(),
      })
      .nullable()
      .optional(),
  })
  .strip();

export const fluidPlaceOutputSchema = z
  .object({
    succeeded: z.literal(true),
    mode: z.enum(["place", "scoop"]),
    /** 操作后读回的方块/流体名（water/lava/air），如实上报。 */
    resultingBlockName: z.string().min(1).max(64),
    position: blockPositionSchema,
  })
  .strict();

export const fluidPlaceCapabilityInputSchema = fluidPlaceInputSchema;
export const fluidPlaceCapabilityOutputSchema = fluidPlaceOutputSchema;

export const fluidPlaceSkill = defineSkill({
  id: "fluid.place",
  version: "1.0.0",
  progressContract: "PLACE_AND_VERIFY",
  inputSchema: fluidPlaceInputSchema,
  outputSchema: fluidPlaceOutputSchema,
  stateSchema: fluidPlaceStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: FLUID_PLACE_TIMEOUT_MS,
  // 倾倒非幂等（重复倒=多桶消耗+流体扩散）；吸取幂等（已空则失败）。
  // 统一按非幂等处理，由上层（救援/农场）控制重复。
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
      check: (input, state) => {
        if (state.bucketCounts == null) return false;
        if (input.mode === "place") {
          return (state.bucketCounts[input.itemName] ?? 0) >= 1;
        }
        return (state.bucketCounts.bucket ?? 0) >= 1;
      },
    },
    {
      id: "target.within-reach",
      failureCode: "TARGET_OUT_OF_REACH",
      check: (input, state, policy) =>
        state.position !== null &&
        (input.mode === "place"
          ? blockWithinPolicyReach(input.referenceBlock, state.position, policy)
          : blockWithinPolicyReach(input.target, state.position, policy)),
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "world.interact",
      "fluid.place-safe",
      fluidPlaceCapabilityInputSchema.parse(input),
    ),
});
