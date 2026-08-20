import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const SLEEP_TIMEOUT_MS = 12_000;
export const SLEEP_MAX_DISTANCE = 4.5;

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

const observedPositionSchema = blockPositionSchema.extend({
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
}).strict();

export const sleepInputSchema = z
  .object({
    serverProfileId: identifierSchema,
    dimension: dimensionSchema,
    bed: blockPositionSchema,
  })
  .strict();

export const sleepStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

export const sleepOutputSchema = z
  .object({
    sleeping: z.literal(true),
    bed: blockPositionSchema,
  })
  .strict();

export const sleepCapabilityInputSchema = sleepInputSchema;
export const sleepCapabilityOutputSchema = sleepOutputSchema;

function bedWithinReach(
  bed: { x: number; y: number; z: number },
  position: { x: number; y: number; z: number },
): boolean {
  return Math.hypot(
    bed.x + 0.5 - position.x,
    bed.y + 0.5 - position.y,
    bed.z + 0.5 - position.z,
  ) <= SLEEP_MAX_DISTANCE;
}

export const sleepSkill = defineSkill({
  id: "survival.sleep",
  version: "1.0.0",
  inputSchema: sleepInputSchema,
  outputSchema: sleepOutputSchema,
  stateSchema: sleepStateSchema,
  compatibility: {
    variants: [
      {
        id: "portable-bed",
        requirements: [
          {
            kind: "resource",
            resource: "block",
            names: ["white_bed", "red_bed"],
            match: "any",
          },
        ],
        verifiedMinecraftVersions: [],
      },
    ],
  },
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: SLEEP_TIMEOUT_MS,
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
      id: "bed.within-reach",
      failureCode: "BED_OUT_OF_REACH",
      check: (input, state) =>
        state.position !== null && bedWithinReach(input.bed, state.position),
    },
  ],
  execute: async (context, input) => {
    const raw = await context.callCapability(
      "world.interact",
      "bed.sleep-safe",
      sleepCapabilityInputSchema.parse(input),
    );
    return sleepCapabilityOutputSchema.parse(raw);
  },
});
