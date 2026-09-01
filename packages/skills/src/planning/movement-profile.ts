import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { SkillFault } from "../errors.js";
import { defineSkill } from "../types.js";
import type { ServerPolicyLimits } from "../policy/server-policy.js";

/** SAFE is the only default. PARKOUR is an explicitly gated test-only option. */
export const movementProfiles = ["SAFE", "PARKOUR"] as const;
export const movementProfileSchema = z.enum(movementProfiles);
export type MovementProfile = z.infer<typeof movementProfileSchema>;

export const movementProfileConfigSchema = z.object({
  profile: movementProfileSchema,
  allowSprinting: z.boolean(),
  allowParkour: z.boolean(),
  allowFreeMotion: z.boolean(),
  allowAirStrafe: z.boolean(),
  allowSprintJumpCombo: z.boolean(),
  maxDropDown: z.number().int().min(0).max(8),
  maxFallBlocks: z.number().int().min(0).max(8),
  verified: z.literal(false),
  verificationNote: z.literal("未实测"),
}).strict();
export type MovementProfileConfig = z.infer<typeof movementProfileConfigSchema>;

export type MovementProfileDecision =
  | Readonly<{ allowed: true; config: MovementProfileConfig }>
  | Readonly<{ allowed: false; errorCode: "POLICY_PARKOUR_FORBIDDEN" | "POLICY_SPRINT_JUMP_FORBIDDEN" | "POLICY_AIR_STRAFE_FORBIDDEN" | "POLICY_FALL_TOO_FAR" }>;

/** Resolve both policy layers together so they cannot disagree about a jump. */
export function resolveMovementProfile(
  profile: MovementProfile,
  limits: ServerPolicyLimits,
  isolatedTestServer: boolean,
): MovementProfileDecision {
  if (profile === "SAFE") {
    return {
      allowed: true,
      config: movementProfileConfigSchema.parse({
        profile,
        allowSprinting: false,
        allowParkour: false,
        allowFreeMotion: false,
        allowAirStrafe: false,
        allowSprintJumpCombo: false,
        maxDropDown: Math.min(2, limits.maxFallBlocks),
        maxFallBlocks: Math.min(2, limits.maxFallBlocks),
        verified: false,
        verificationNote: "未实测",
      }),
    };
  }
  if (!isolatedTestServer || !limits.allowSprintJumpCombo) {
    return { allowed: false, errorCode: "POLICY_PARKOUR_FORBIDDEN" };
  }
  if (limits.allowAirStrafe) {
    // Air strafing is intentionally never enabled by this profile; the caller
    // must ask for a separate, measured policy before adding it.
    return { allowed: false, errorCode: "POLICY_AIR_STRAFE_FORBIDDEN" };
  }
  if (limits.maxFallBlocks > 8) return { allowed: false, errorCode: "POLICY_FALL_TOO_FAR" };
  return {
    allowed: true,
    config: movementProfileConfigSchema.parse({
      profile,
      allowSprinting: limits.allowSprint,
      allowParkour: true,
      allowFreeMotion: false,
      allowAirStrafe: false,
      allowSprintJumpCombo: true,
      maxDropDown: Math.min(8, limits.maxFallBlocks),
      maxFallBlocks: Math.min(8, limits.maxFallBlocks),
      verified: false,
      verificationNote: "未实测",
    }),
  };
}

export const movementProfileInputSchema = z.object({
  profile: movementProfileSchema,
  serverProfileId: identifierSchema,
}).strict();
export const movementProfileStateSchema = z.object({
  online: z.boolean(),
  normalActionsAllowed: z.boolean(),
  serverProfileId: identifierSchema,
  isolatedTestServer: z.boolean(),
  policyLimits: z.object({
    allowSprint: z.boolean(),
    allowSprintJumpCombo: z.boolean(),
    allowAirStrafe: z.boolean(),
    maxFallBlocks: z.number().int().min(0).max(8),
  }).strict(),
}).strip();
export const movementProfileOutputSchema = z.object({
  serverProfileId: identifierSchema,
  config: movementProfileConfigSchema,
}).strict();

export const movementProfileSkill = defineSkill({
  id: "movement.profile",
  version: "1.0.0",
  progressContract: "RECOVERING",
  inputSchema: movementProfileInputSchema,
  outputSchema: movementProfileOutputSchema,
  stateSchema: movementProfileStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: [] as const,
  timeoutMs: 2_000,
  idempotent: true,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 20, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_input, state) => state.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (input, state) => input.serverProfileId === state.serverProfileId },
    { id: "movement.profile-allowed", failureCode: "POLICY_PARKOUR_FORBIDDEN", check: (input, state) => resolveMovementProfile(input.profile, state.policyLimits as ServerPolicyLimits, state.isolatedTestServer).allowed },
  ],
  execute: async (_context, input, state) => {
    const decision = resolveMovementProfile(input.profile, state.policyLimits as ServerPolicyLimits, state.isolatedTestServer);
    if (!decision.allowed) throw new SkillFault(decision.errorCode);
    return movementProfileOutputSchema.parse({ serverProfileId: input.serverProfileId, config: decision.config });
  },
});

