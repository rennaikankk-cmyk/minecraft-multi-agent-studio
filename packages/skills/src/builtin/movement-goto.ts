import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const SAFE_PATH_MAX_DISTANCE = 64;
export const SAFE_PATH_TIMEOUT_MS = 20_000;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const targetPositionSchema = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2_048).max(2_048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
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
    // runtime 快照附带朝向角；剥掉语义上不需要，但 strict 下缺失会拒真状态
    yaw: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
  })
  .strict();

export const safeMovementGotoInputSchema = z
  .object({
    target: targetPositionSchema,
    radius: z.number().int().min(1).max(4),
  })
  .strict();

export const safeMovementGotoStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  // 运行时下发的是一份共享 state（还带着背包占用等本技能用不到的字段）。
  // 未知键剥掉而不是 strict 拒绝，否则任何一个技能新增观测字段都会让这里
  // 报 SKILL_STATE_INVALID —— 与 equipArmorStateSchema 同一处理。
  .strip();

export const safeMovementGotoOutputSchema = z
  .object({
    reached: z.literal(true),
    finalPosition: observedPositionSchema,
    distanceToTarget: z.number().finite().min(0).max(SAFE_PATH_MAX_DISTANCE + 8),
  })
  .strict();

export const safeMovementGotoCapabilityInputSchema =
  safeMovementGotoInputSchema;

export const safeMovementGotoCapabilityOutputSchema =
  safeMovementGotoOutputSchema;

type MovementGotoInput = z.infer<typeof safeMovementGotoInputSchema>;
type MovementGotoState = z.infer<typeof safeMovementGotoStateSchema>;

function distance(
  left: MovementGotoInput["target"],
  right: NonNullable<MovementGotoState["position"]>,
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

export const movementGotoSkill = defineSkill({
  id: "movement.goto",
  version: "1.0.0",
  inputSchema: safeMovementGotoInputSchema,
  outputSchema: safeMovementGotoOutputSchema,
  stateSchema: safeMovementGotoStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["bot.move"] as const,
  timeoutMs: SAFE_PATH_TIMEOUT_MS,
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
      id: "bot.position-available",
      failureCode: "BOT_POSITION_UNAVAILABLE",
      check: (_input, state) => state.position !== null,
    },
    {
      id: "target.server-profile-matches",
      failureCode: "TARGET_SERVER_PROFILE_MISMATCH",
      check: (input, state) =>
        input.target.serverProfileId === state.serverProfileId,
    },
    {
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input, state) =>
        state.position !== null &&
        input.target.dimension === state.position.dimension,
    },
    {
      id: "target.within-safe-range",
      failureCode: "TARGET_OUT_OF_SAFE_RANGE",
      check: (input, state) =>
        state.position !== null &&
        distance(input.target, state.position) <= SAFE_PATH_MAX_DISTANCE,
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "bot.move",
      "pathfinder.goto-safe",
      safeMovementGotoCapabilityInputSchema.parse(input),
    ) as Promise<z.infer<typeof safeMovementGotoOutputSchema> | null>,
});
