import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import {
  COMBAT_MELEE_MAX_ATTACKS,
  COMBAT_MELEE_MAX_DISTANCE,
  COMBAT_MELEE_TIMEOUT_MS,
  combatMeleeOutputSchema,
} from "./combat-pve-melee.js";
import { defineSkill } from "../types.js";

const usernameSchema = z
  .string()
  .min(3)
  .max(16)
  .regex(/^[A-Za-z0-9_]+$/u);
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

export const combatPvpMeleeInputSchema = z
  .object({
    serverProfileId: identifierSchema,
    dimension: dimensionSchema,
    targetUsername: usernameSchema,
    maxDistance: z.number().min(2).max(COMBAT_MELEE_MAX_DISTANCE),
    maxAttackAttempts: z.number().int().min(1).max(COMBAT_MELEE_MAX_ATTACKS),
    retreatHealth: z.number().min(9).max(18),
  })
  .strict();

export const combatPvpMeleeStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

export const combatPvpMeleeCapabilityInputSchema = combatPvpMeleeInputSchema;
export const combatPvpMeleeCapabilityOutputSchema = combatMeleeOutputSchema;

/**
 * Optional PvP extension. Runtime registers it only when the isolated
 * ServerProfile explicitly enables PvP and allow-lists target usernames.
 */
export const combatPvpMeleeSkill = defineSkill({
  id: "combat.pvp-melee",
  version: "1.0.0",
  inputSchema: combatPvpMeleeInputSchema,
  outputSchema: combatMeleeOutputSchema,
  stateSchema: combatPvpMeleeStateSchema,
  compatibility: {
    variants: [
      {
        id: "isolated-pvp-allowlist",
        requirements: [
          { kind: "server-capability", name: "combat.pvp-enabled" },
        ],
        verifiedMinecraftVersions: [],
      },
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
      "combat.pvp-melee-allowlisted",
      combatPvpMeleeCapabilityInputSchema.parse(input),
    );
    return combatPvpMeleeCapabilityOutputSchema.parse(raw);
  },
});
