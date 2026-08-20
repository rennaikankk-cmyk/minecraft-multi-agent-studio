import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const STORAGE_ACCOUNT_TIMEOUT_MS = 10_000;
export const STORAGE_ACCOUNT_MAX_ITEMS = 32;
export const STORAGE_ACCOUNT_MAX_DISTANCE = 4.5;

const itemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);
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

export const storageAccountInputSchema = z
  .object({
    serverProfileId: identifierSchema,
    dimension: dimensionSchema,
    container: blockPositionSchema,
    itemNames: z
      .array(itemNameSchema)
      .min(1)
      .max(STORAGE_ACCOUNT_MAX_ITEMS)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

export const storageAccountStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

const storageItemCountSchema = z
  .object({
    itemName: itemNameSchema,
    inventoryCount: z.number().int().nonnegative(),
    containerCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
  })
  .strict();

export const storageAccountOutputSchema = z
  .object({
    containerName: itemNameSchema,
    containerUsedSlots: z.number().int().nonnegative(),
    containerTotalSlots: z.number().int().nonnegative(),
    items: z.array(storageItemCountSchema).min(1).max(STORAGE_ACCOUNT_MAX_ITEMS),
  })
  .strict();

export const storageAccountCapabilityInputSchema = storageAccountInputSchema;
export const storageAccountCapabilityOutputSchema = storageAccountOutputSchema;

function withinReach(
  target: { x: number; y: number; z: number },
  position: { x: number; y: number; z: number },
): boolean {
  return Math.hypot(
    target.x + 0.5 - position.x,
    target.y + 0.5 - position.y,
    target.z + 0.5 - position.z,
  ) <= STORAGE_ACCOUNT_MAX_DISTANCE;
}

export const storageAccountSkill = defineSkill({
  id: "storage.account",
  version: "1.0.0",
  inputSchema: storageAccountInputSchema,
  outputSchema: storageAccountOutputSchema,
  stateSchema: storageAccountStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["container.read", "inventory.read"] as const,
  timeoutMs: STORAGE_ACCOUNT_TIMEOUT_MS,
  idempotent: true,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 50,
    maxDelayMs: 250,
    retryableErrorCodes: [],
  },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_input, state) => state.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (input, state) => input.serverProfileId === state.serverProfileId },
    { id: "target.dimension-matches", failureCode: "TARGET_DIMENSION_MISMATCH", check: (input, state) => state.position !== null && input.dimension === state.position.dimension },
    { id: "container.within-reach", failureCode: "CONTAINER_OUT_OF_REACH", check: (input, state) => state.position !== null && withinReach(input.container, state.position) },
  ],
  execute: async (context, input) => {
    const raw = await context.callCapability(
      "container.read",
      "container.account-safe",
      storageAccountCapabilityInputSchema.parse(input),
    );
    return storageAccountCapabilityOutputSchema.parse(raw);
  },
});
