import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 放置方块技能，自研（mineflayer 原生 bot.placeBlock）。生存链条：搭庇护所、
// 放工作台/箱子/火把全靠它。一次调用放一块——批量建造由上层任务编排，
// 保证每一步都可被 L0 打断且可审计。放置后读回校验，不伪造成功。
// ---------------------------------------------------------------------------

export const PLACE_BLOCK_TIMEOUT_MS = 10_000;
/** 放置目标必须在伸手范围内；寻路靠 movement.goto，职责分离。 */
export const PLACE_MAX_DISTANCE = 4.5;

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

/** 依附面单位向量：目标 = 参照方块位置 + face。 */
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

export const placeBlockInputSchema = z
  .object({
    itemName: itemNameSchema,
    referenceBlock: blockPositionSchema,
    face: faceVectorSchema,
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const placeBlockStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

export const placeBlockOutputSchema = z
  .object({
    placed: z.literal(true),
    // 放置后读回的实际方块名（如 torch 放墙上变 wall_torch，如实上报）。
    placedBlockName: z.string().min(1).max(64),
    position: blockPositionSchema,
  })
  .strict();

export const placeBlockCapabilityInputSchema = placeBlockInputSchema;
export const placeBlockCapabilityOutputSchema = placeBlockOutputSchema;

function referenceWithinReach(
  reference: { x: number; y: number; z: number },
  position: { x: number; y: number; z: number },
): boolean {
  return (
    Math.hypot(
      reference.x + 0.5 - position.x,
      reference.y + 0.5 - position.y,
      reference.z + 0.5 - position.z,
    ) <= PLACE_MAX_DISTANCE
  );
}

export const placeBlockSkill = defineSkill({
  id: "world.place-block",
  version: "1.0.0",
  inputSchema: placeBlockInputSchema,
  outputSchema: placeBlockOutputSchema,
  stateSchema: placeBlockStateSchema,
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: PLACE_BLOCK_TIMEOUT_MS,
  // 重复放置同一目标位要么已被占用失败、要么消耗第二个方块，禁止自动重试。
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
      id: "target.within-reach",
      failureCode: "TARGET_OUT_OF_REACH",
      check: (input, state) =>
        state.position !== null &&
        referenceWithinReach(input.referenceBlock, state.position),
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "world.interact",
      "block.place-safe",
      placeBlockCapabilityInputSchema.parse(input),
    ),
});
