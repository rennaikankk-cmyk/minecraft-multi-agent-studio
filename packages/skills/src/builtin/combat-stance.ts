import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 战斗立场切换技能。立场是"运维/神谕给的配置"（AGENTS.md §0.2：AI 不能自己
// 推断立场），这个技能只是**受信调用方**（Dashboard 目标、重规划神谕的
// combat-stance 菜单项）把显式决定下发到 CombatDriver 的执行面。
// 幂等：重复切到同一立场立即成功。
// ---------------------------------------------------------------------------

export const COMBAT_STANCE_TIMEOUT_MS = 2_000;

const combatStances = ["preserve-life", "expendable", "aggressive"] as const;

export const combatStanceInputSchema = z
  .object({
    stance: z.enum(combatStances),
    serverProfileId: identifierSchema,
  })
  .strict();

export const combatStanceStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    combatAvailable: z.boolean(),
  })
  .strip();

export const combatStanceOutputSchema = z
  .object({
    stance: z.enum(combatStances),
    changed: z.boolean(),
  })
  .strict();

export const combatStanceCapabilityInputSchema = combatStanceInputSchema;
export const combatStanceCapabilityOutputSchema = combatStanceOutputSchema;

export const combatStanceSkill = defineSkill({
  id: "combat.stance",
  version: "1.0.0",
  progressContract: "WAITING_EXTERNAL",
  inputSchema: combatStanceInputSchema,
  outputSchema: combatStanceOutputSchema,
  stateSchema: combatStanceStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["combat.control"] as const,
  timeoutMs: COMBAT_STANCE_TIMEOUT_MS,
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
    {
      id: "combat.driver-available",
      failureCode: "COMBAT_DRIVER_UNAVAILABLE",
      check: (_input, state) => state.combatAvailable,
    },
  ],
  execute: async (context, input) =>
    combatStanceCapabilityOutputSchema.parse(
      await context.callCapability(
        "combat.control",
        "combat.stance-set",
        combatStanceCapabilityInputSchema.parse(input),
      ),
    ),
});
