import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const MOVEMENT_RECOVER_TIMEOUT_MS = 8_000;
export const MOVEMENT_RECOVER_MAX_ATTEMPTS = 3;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const observedPositionSchema = z
  .object({
    x: z.number().finite().min(-30_000_000).max(30_000_000),
    y: z.number().finite().min(-2_048).max(2_048),
    z: z.number().finite().min(-30_000_000).max(30_000_000),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const movementRecoverInputSchema = z
  .object({
    serverProfileId: identifierSchema,
    dimension: dimensionSchema,
    maxAttempts: z.number().int().min(1).max(MOVEMENT_RECOVER_MAX_ATTEMPTS),
  })
  .strict();

export const movementRecoverStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

export const movementRecoverOutputSchema = z
  .object({
    recovered: z.boolean(),
    attempts: z.number().int().min(1).max(MOVEMENT_RECOVER_MAX_ATTEMPTS),
    distanceMoved: z.number().finite().min(0).max(16),
    finalPosition: observedPositionSchema,
  })
  .strict();

export const movementRecoverCapabilityInputSchema = movementRecoverInputSchema;
export const movementRecoverCapabilityOutputSchema = movementRecoverOutputSchema;

export const movementRecoverSkill = defineSkill({
  id: "movement.recover",
  version: "1.0.0",
  inputSchema: movementRecoverInputSchema,
  outputSchema: movementRecoverOutputSchema,
  stateSchema: movementRecoverStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["bot.move"] as const,
  timeoutMs: MOVEMENT_RECOVER_TIMEOUT_MS,
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
      check: (input, state) => input.serverProfileId === state.serverProfileId,
    },
    {
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input, state) =>
        state.position !== null && input.dimension === state.position.dimension,
    },
  ],
  execute: async (context, input) => {
    const raw = await context.callCapability(
      "bot.move",
      "movement.recover-bounded",
      movementRecoverCapabilityInputSchema.parse(input),
    );
    return movementRecoverCapabilityOutputSchema.parse(raw);
  },
});
