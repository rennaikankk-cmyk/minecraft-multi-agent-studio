import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const SMELT_ITEM_TIMEOUT_MS = 60_000;
export const SMELT_MAX_COUNT = 5;
export const FURNACE_MAX_DISTANCE = 4.5;

const dimensionSchema = z.string().min(3).max(128).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);
const itemNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u);
const blockPositionSchema = z.object({
  x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-2_048).max(2_048),
  z: z.number().int().min(-30_000_000).max(30_000_000),
}).strict();
const observedPositionSchema = z.object({
  x: z.number().finite().min(-30_000_000).max(30_000_000),
  y: z.number().finite().min(-2_048).max(2_048),
  z: z.number().finite().min(-30_000_000).max(30_000_000),
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
}).strict();

export const smeltItemInputSchema = z.object({
  inputItemName: itemNameSchema,
  fuelItemName: itemNameSchema,
  fuelCount: z.number().int().min(1).max(SMELT_MAX_COUNT),
  count: z.number().int().min(1).max(SMELT_MAX_COUNT),
  furnace: blockPositionSchema,
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
}).strict();
export const smeltItemStateSchema = z.object({
  online: z.boolean(), normalActionsAllowed: z.boolean(), serverProfileId: identifierSchema,
  position: observedPositionSchema.nullable(),
}).strip();
export const smeltItemOutputSchema = z.object({
  inputItemName: itemNameSchema, fuelItemName: itemNameSchema, outputItemName: itemNameSchema,
  insertedFuelCount: z.number().int().min(1).max(SMELT_MAX_COUNT),
  requestedCount: z.number().int().min(1).max(SMELT_MAX_COUNT),
  smeltedCount: z.number().int().min(0).max(SMELT_MAX_COUNT),
}).strict();
export const smeltItemCapabilityInputSchema = smeltItemInputSchema;
export const smeltItemCapabilityOutputSchema = smeltItemOutputSchema;

function withinReach(target: { x: number; y: number; z: number }, position: { x: number; y: number; z: number }): boolean {
  return Math.hypot(target.x + 0.5 - position.x, target.y + 0.5 - position.y, target.z + 0.5 - position.z) <= FURNACE_MAX_DISTANCE;
}

export const smeltItemSkill = defineSkill({
  id: "smelt.item", version: "1.0.0", inputSchema: smeltItemInputSchema,
  outputSchema: smeltItemOutputSchema, stateSchema: smeltItemStateSchema,
  requiredCapabilities: ["craft.execute"] as const,
  timeoutMs: SMELT_ITEM_TIMEOUT_MS, idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 250, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_input, state) => state.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (input, state) => input.serverProfileId === state.serverProfileId },
    { id: "target.dimension-matches", failureCode: "TARGET_DIMENSION_MISMATCH", check: (input, state) => state.position !== null && input.dimension === state.position.dimension },
    { id: "furnace.within-reach", failureCode: "FURNACE_OUT_OF_REACH", check: (input, state) => state.position !== null && withinReach(input.furnace, state.position) },
  ],
  execute: async (context, input) => smeltItemCapabilityOutputSchema.parse(await context.callCapability(
    "craft.execute", "smelt.item-safe", smeltItemCapabilityInputSchema.parse(input),
  )),
});

