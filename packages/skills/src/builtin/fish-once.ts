import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const FISH_ONCE_TIMEOUT_MS = 45_000;

const itemNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u);
const dimensionSchema = z.string().min(3).max(128).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

export const fishOnceInputSchema = z.object({
  serverProfileId: identifierSchema,
  dimension: dimensionSchema,
}).strict();

export const fishOnceStateSchema = z.object({
  online: z.boolean(),
  normalActionsAllowed: z.boolean(),
  serverProfileId: identifierSchema,
  position: z.object({
    x: z.number().finite(), y: z.number().finite(), z: z.number().finite(),
    dimension: dimensionSchema, serverProfileId: identifierSchema,
  }).strict().nullable(),
}).strip();

export const fishOnceOutputSchema = z.object({
  caught: z.boolean(),
  itemsGained: z.number().int().nonnegative(),
  itemName: itemNameSchema.nullable(),
}).strict();

export const fishOnceCapabilityInputSchema = fishOnceInputSchema;
export const fishOnceCapabilityOutputSchema = fishOnceOutputSchema;

export const fishOnceSkill = defineSkill({
  id: "gather.fish-once",
  version: "1.0.0",
  inputSchema: fishOnceInputSchema,
  outputSchema: fishOnceOutputSchema,
  stateSchema: fishOnceStateSchema,
  compatibility: {
    variants: [{
      id: "fishing-rod",
      requirements: [{ kind: "resource", resource: "item", names: ["fishing_rod"], match: "all" }],
      verifiedMinecraftVersions: [],
    }],
  },
  requiredCapabilities: ["world.interact", "inventory.write"] as const,
  timeoutMs: FISH_ONCE_TIMEOUT_MS,
  idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 250, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_input, state) => state.normalActionsAllowed },
    { id: "bot.position-available", failureCode: "BOT_POSITION_UNAVAILABLE", check: (_input, state) => state.position !== null },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (input, state) => input.serverProfileId === state.serverProfileId },
    { id: "target.dimension-matches", failureCode: "TARGET_DIMENSION_MISMATCH", check: (input, state) => state.position !== null && input.dimension === state.position.dimension },
  ],
  execute: async (context, input) => {
    const raw = await context.callCapability(
      "world.interact",
      "fishing.cast-once-safe",
      fishOnceCapabilityInputSchema.parse(input),
    );
    return fishOnceCapabilityOutputSchema.parse(raw);
  },
});
