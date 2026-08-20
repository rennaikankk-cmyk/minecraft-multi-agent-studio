import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const CONSUME_FOOD_TIMEOUT_MS = 8_000;

const foodNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);

export const consumeFoodInputSchema = z
  .object({
    serverProfileId: identifierSchema,
    maximumFoodLevel: z.number().int().min(0).max(19),
  })
  .strict();

export const consumeFoodStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
  })
  .strip();

export const consumeFoodOutputSchema = z
  .object({
    consumed: z.boolean(),
    itemName: foodNameSchema.nullable(),
    foodLevelBefore: z.number().int().min(0).max(20),
    foodLevelAfter: z.number().int().min(0).max(20),
  })
  .strict();

export const consumeFoodCapabilityInputSchema = consumeFoodInputSchema;
export const consumeFoodCapabilityOutputSchema = consumeFoodOutputSchema;

/**
 * Deterministic L1 food action. L0 keeps its independent emergency hunger
 * reflex; this skill lets an authorized task eat before the emergency
 * threshold without letting the planner choose an arbitrary inventory item.
 */
export const consumeFoodSkill = defineSkill({
  id: "survival.consume-food",
  version: "1.0.0",
  inputSchema: consumeFoodInputSchema,
  outputSchema: consumeFoodOutputSchema,
  stateSchema: consumeFoodStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["inventory.write"] as const,
  timeoutMs: CONSUME_FOOD_TIMEOUT_MS,
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
  ],
  execute: async (context, input) => {
    const raw = await context.callCapability(
      "inventory.write",
      "food.consume-best-safe",
      consumeFoodCapabilityInputSchema.parse(input),
    );
    return consumeFoodCapabilityOutputSchema.parse(raw);
  },
});
