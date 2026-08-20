import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const COLLECT_DROPS_TIMEOUT_MS = 45_000;
export const COLLECT_DROPS_MAX_COUNT = 32;
export const COLLECT_DROPS_MAX_DISTANCE = 32;

const itemNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u);
const dimensionSchema = z.string().min(3).max(128).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);
const observedPositionSchema = z.object({
  x: z.number().finite().min(-30_000_000).max(30_000_000),
  y: z.number().finite().min(-2_048).max(2_048),
  z: z.number().finite().min(-30_000_000).max(30_000_000),
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
}).strict();

export const collectDropsInputSchema = z.object({
  serverProfileId: identifierSchema,
  dimension: dimensionSchema,
  itemNames: z.array(itemNameSchema).min(1).max(16).refine((values) => new Set(values).size === values.length),
  maxCount: z.number().int().min(1).max(COLLECT_DROPS_MAX_COUNT),
  maxDistance: z.number().int().min(2).max(COLLECT_DROPS_MAX_DISTANCE),
}).strict();

export const collectDropsStateSchema = z.object({
  online: z.boolean(),
  normalActionsAllowed: z.boolean(),
  serverProfileId: identifierSchema,
  position: observedPositionSchema.nullable(),
}).strip();

const collectedItemSchema = z.object({
  itemName: itemNameSchema,
  count: z.number().int().positive(),
}).strict();

export const collectDropsOutputSchema = z.object({
  targetsFound: z.number().int().nonnegative().max(COLLECT_DROPS_MAX_COUNT),
  itemsCollected: z.number().int().nonnegative(),
  items: z.array(collectedItemSchema).max(16),
}).strict();

export const collectDropsCapabilityInputSchema = collectDropsInputSchema;
export const collectDropsCapabilityOutputSchema = collectDropsOutputSchema;

export const collectDropsSkill = defineSkill({
  id: "collect.drops",
  version: "1.0.0",
  inputSchema: collectDropsInputSchema,
  outputSchema: collectDropsOutputSchema,
  stateSchema: collectDropsStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["bot.move", "inventory.write"] as const,
  timeoutMs: COLLECT_DROPS_TIMEOUT_MS,
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
      "bot.move",
      "collect.drops-safe",
      collectDropsCapabilityInputSchema.parse(input),
    );
    return collectDropsCapabilityOutputSchema.parse(raw);
  },
});
