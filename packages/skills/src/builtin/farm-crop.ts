import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const FARM_CROP_TIMEOUT_MS = 60_000;
export const FARM_CROP_MAX_COUNT = 16;
export const FARM_CROP_MAX_DISTANCE = 24;
export const FARM_CROP_NAMES = ["wheat", "carrots", "potatoes", "beetroots", "nether_wart"] as const;

const cropNameSchema = z.enum(FARM_CROP_NAMES);
const itemNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u);
const dimensionSchema = z.string().min(3).max(128).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);
const observedPositionSchema = z.object({
  x: z.number().finite().min(-30_000_000).max(30_000_000),
  y: z.number().finite().min(-2_048).max(2_048),
  z: z.number().finite().min(-30_000_000).max(30_000_000),
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
}).strict();

export const farmCropInputSchema = z.object({
  serverProfileId: identifierSchema,
  dimension: dimensionSchema,
  cropName: cropNameSchema,
  maxCount: z.number().int().min(1).max(FARM_CROP_MAX_COUNT),
  maxDistance: z.number().int().min(2).max(FARM_CROP_MAX_DISTANCE),
}).strict();

export const farmCropStateSchema = z.object({
  online: z.boolean(),
  normalActionsAllowed: z.boolean(),
  serverProfileId: identifierSchema,
  position: observedPositionSchema.nullable(),
}).strip();

export const farmCropOutputSchema = z.object({
  cropName: cropNameSchema,
  seedItemName: itemNameSchema,
  matureTargetsFound: z.number().int().nonnegative().max(FARM_CROP_MAX_COUNT),
  harvested: z.number().int().nonnegative().max(FARM_CROP_MAX_COUNT),
  replanted: z.number().int().nonnegative().max(FARM_CROP_MAX_COUNT),
}).strict();

export const farmCropCapabilityInputSchema = farmCropInputSchema;
export const farmCropCapabilityOutputSchema = farmCropOutputSchema;

export const farmCropSkill = defineSkill({
  id: "farm.crop",
  version: "1.0.0",
  inputSchema: farmCropInputSchema,
  outputSchema: farmCropOutputSchema,
  stateSchema: farmCropStateSchema,
  compatibility: {
    variants: [{
      id: "portable-crops",
      requirements: [{ kind: "resource", resource: "block", names: [...FARM_CROP_NAMES], match: "any" }],
      verifiedMinecraftVersions: [],
    }],
  },
  requiredCapabilities: ["bot.move", "world.interact", "inventory.write"] as const,
  timeoutMs: FARM_CROP_TIMEOUT_MS,
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
      "farm.crop-replant-safe",
      farmCropCapabilityInputSchema.parse(input),
    );
    return farmCropCapabilityOutputSchema.parse(raw);
  },
});
