import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const INVENTORY_COMPACT_TIMEOUT_MS = 10_000;
export const INVENTORY_COMPACT_MAX_MOVES = 36;

export const inventoryCompactInputSchema = z
  .object({
    serverProfileId: identifierSchema,
    maxMoves: z.number().int().min(1).max(INVENTORY_COMPACT_MAX_MOVES),
  })
  .strict();

export const inventoryCompactStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
  })
  .strip();

export const inventoryCompactOutputSchema = z
  .object({
    movedStacks: z.number().int().min(0).max(INVENTORY_COMPACT_MAX_MOVES),
    occupiedSlotsBefore: z.number().int().min(0).max(36),
    occupiedSlotsAfter: z.number().int().min(0).max(36),
    totalItemsBefore: z.number().int().min(0),
    totalItemsAfter: z.number().int().min(0),
    preserved: z.literal(true),
  })
  .strict();

export const inventoryCompactCapabilityInputSchema = inventoryCompactInputSchema;
export const inventoryCompactCapabilityOutputSchema = inventoryCompactOutputSchema;

/**
 * Compacts inventory stacks into earlier empty slots. It never drops items,
 * opens containers, touches equipment slots, or invents a category mapping.
 */
export const inventoryCompactSkill = defineSkill({
  id: "inventory.compact",
  version: "1.0.0",
  inputSchema: inventoryCompactInputSchema,
  outputSchema: inventoryCompactOutputSchema,
  stateSchema: inventoryCompactStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["inventory.write"] as const,
  timeoutMs: INVENTORY_COMPACT_TIMEOUT_MS,
  idempotent: true,
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
      "inventory.compact-safe",
      inventoryCompactCapabilityInputSchema.parse(input),
    );
    return inventoryCompactCapabilityOutputSchema.parse(raw);
  },
});
