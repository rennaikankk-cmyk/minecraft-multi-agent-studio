import { identifierSchema, skillJsonValueSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";
import {
  SAFE_PATH_MAX_DISTANCE,
  safeMovementGotoOutputSchema,
  safeMovementGotoStateSchema,
} from "./movement-goto.js";

/**
 * 死亡掉落回收。movement.goto 停在半径 2 格就算到达，物品碰撞拾取半径更小，
 * 协调器因此会把“走近了”记成“已经捡回”。本技能要求：走到死亡方块，逐个接近
 * 6 格内的掉落物，并用背包增量证明捡到了什么；现场仍有物品则失败，不能记完成。
 */
export const RECOVER_DROPS_TIMEOUT_MS = 45_000;
export const RECOVER_DROPS_MAX_DISTANCE = SAFE_PATH_MAX_DISTANCE;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const itemCountSchema = z
  .object({
    itemId: z.string().regex(/^[a-z0-9_]+$/u).max(64),
    count: z.number().int().min(1).max(2304),
  })
  .strict();

export const recoverDropsInputSchema = z
  .object({
    target: z
      .object({
        x: z.number().int().min(-30_000_000).max(30_000_000),
        y: z.number().int().min(-2_048).max(2_048),
        z: z.number().int().min(-30_000_000).max(30_000_000),
        dimension: dimensionSchema,
        serverProfileId: identifierSchema,
      })
      .strict(),
    expectedItems: z.array(itemCountSchema).max(36).optional(),
  })
  .strict();

export const recoverDropsOutputSchema = z
  .object({
    reached: z.literal(true),
    finalPosition: safeMovementGotoOutputSchema.shape.finalPosition,
    distanceToTarget: z.number().finite().min(0).max(SAFE_PATH_MAX_DISTANCE + 8),
    recovered: z.array(itemCountSchema).max(36),
    stillNearby: z.number().int().min(0).max(64),
    expectedMissing: z.array(itemCountSchema).max(36),
  })
  .strict();

export const recoverDropsStateSchema = safeMovementGotoStateSchema;

type RecoverDropsInput = z.infer<typeof recoverDropsInputSchema>;
type RecoverDropsState = z.infer<typeof recoverDropsStateSchema>;

function distance(
  left: RecoverDropsInput["target"],
  right: NonNullable<RecoverDropsState["position"]>,
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

export const recoverDropsSkill = defineSkill({
  id: "recover.drops",
  version: "1.0.0",
  progressContract: "RECOVERING",
  inputSchema: recoverDropsInputSchema,
  outputSchema: recoverDropsOutputSchema,
  stateSchema: recoverDropsStateSchema,
  compatibility: {
    variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }],
  },
  requiredCapabilities: ["bot.move"] as const,
  timeoutMs: RECOVER_DROPS_TIMEOUT_MS,
  idempotent: true,
  retryPolicy: {
    maxAttempts: 2,
    baseDelayMs: 400,
    maxDelayMs: 1_000,
    retryableErrorCodes: ["PATHFINDER_GOTO_FAILED", "DROPS_STILL_PRESENT"],
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
      id: "bot.position-available",
      failureCode: "BOT_POSITION_UNAVAILABLE",
      check: (_input, state) => state.position !== null,
    },
    {
      id: "target.server-profile-matches",
      failureCode: "TARGET_SERVER_PROFILE_MISMATCH",
      check: (input, state) => input.target.serverProfileId === state.serverProfileId,
    },
    {
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input, state) =>
        state.position !== null && input.target.dimension === state.position.dimension,
    },
    {
      id: "target.within-safe-range",
      failureCode: "TARGET_OUT_OF_SAFE_RANGE",
      check: (input, state) =>
        state.position !== null && distance(input.target, state.position) <= RECOVER_DROPS_MAX_DISTANCE,
    },
  ],
  execute: async (context, input) => {
    const parsed = recoverDropsInputSchema.parse(input);
    const capabilityInput: {
      target: RecoverDropsInput["target"];
      expectedItems?: Array<{ itemId: string; count: number }>;
    } = { target: parsed.target };
    if (parsed.expectedItems !== undefined) {
      capabilityInput.expectedItems = parsed.expectedItems;
    }
    return recoverDropsOutputSchema.parse(
      await context.callCapability(
        "bot.move",
        "drops.recover-safe",
        skillJsonValueSchema.parse(capabilityInput),
      ),
    );
  },
});
