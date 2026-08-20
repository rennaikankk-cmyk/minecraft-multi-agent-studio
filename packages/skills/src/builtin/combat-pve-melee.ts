import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const COMBAT_MELEE_TIMEOUT_MS = 12_000;
export const COMBAT_MELEE_MAX_DISTANCE = 4.5;
export const COMBAT_MELEE_MAX_ATTACKS = 6;

export const HOSTILE_MOB_NAMES = [
  "blaze",
  "bogged",
  "breeze",
  "cave_spider",
  "creeper",
  "drowned",
  "elder_guardian",
  "enderman",
  "endermite",
  "evoker",
  "ghast",
  "guardian",
  "hoglin",
  "husk",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "silverfish",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "warden",
  "witch",
  "wither_skeleton",
  "zoglin",
  "zombie",
  "zombie_villager",
  "zombified_piglin",
] as const;

const hostileMobNameSchema = z.enum(HOSTILE_MOB_NAMES);
const entityNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);
const itemNameSchema = entityNameSchema;
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

export const combatPveMeleeInputSchema = z
  .object({
    serverProfileId: identifierSchema,
    dimension: dimensionSchema,
    targetTypes: z
      .array(hostileMobNameSchema)
      .min(1)
      .max(12)
      .refine((values) => new Set(values).size === values.length),
    maxDistance: z.number().min(2).max(COMBAT_MELEE_MAX_DISTANCE),
    maxAttackAttempts: z.number().int().min(1).max(COMBAT_MELEE_MAX_ATTACKS),
    retreatHealth: z.number().min(9).max(18),
  })
  .strict();

export const combatPveMeleeStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

export const combatMeleeOutputSchema = z
  .object({
    targetFound: z.boolean(),
    targetName: entityNameSchema.nullable(),
    targetEntityId: z.number().int().nonnegative().nullable(),
    weaponName: itemNameSchema.nullable(),
    attackAttempts: z.number().int().min(0).max(COMBAT_MELEE_MAX_ATTACKS),
    targetStillTracked: z.boolean(),
    retreated: z.boolean(),
    finalDistance: z.number().finite().min(0).max(256).nullable(),
  })
  .strict();

export const combatPveMeleeCapabilityInputSchema = combatPveMeleeInputSchema;
export const combatPveMeleeCapabilityOutputSchema = combatMeleeOutputSchema;

export const combatPveMeleeSkill = defineSkill({
  id: "combat.pve-melee",
  version: "1.0.0",
  inputSchema: combatPveMeleeInputSchema,
  outputSchema: combatMeleeOutputSchema,
  stateSchema: combatPveMeleeStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["combat.execute"] as const,
  timeoutMs: COMBAT_MELEE_TIMEOUT_MS,
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
      "combat.execute",
      "combat.pve-melee-safe",
      combatPveMeleeCapabilityInputSchema.parse(input),
    );
    return combatPveMeleeCapabilityOutputSchema.parse(raw);
  },
});
