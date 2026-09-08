import { residenceCheckInputSchema, residenceCheckOutputSchema } from "@minecraft-studio/base-management";
import { skillJsonValueSchema } from "@minecraft-studio/protocol";
import { defineSkill } from "../types.js";
import { scanBlocksStateSchema } from "./scan-blocks.js";

export const residenceCheckSkill = defineSkill({
  id: "base.residence-check", version: "1.0.0",
  inputSchema: residenceCheckInputSchema, outputSchema: residenceCheckOutputSchema, stateSchema: scanBlocksStateSchema,
  progressContract: "PLACE_AND_VERIFY",
  compatibility: { variants: [{ id: "server-bed-and-sign", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["world.interact", "world.read", "bot.move", "inventory.write"] as const,
  timeoutMs: 30_000, idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 100, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_i, s) => s.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_i, s) => s.normalActionsAllowed },
    { id: "scope.matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (i, s) => i.site.scope.serverProfileId === s.serverProfileId },
    { id: "dimension.matches", failureCode: "TARGET_DIMENSION_MISMATCH", check: (i, s) => i.site.scope.dimension === s.position?.dimension },
  ],
  execute: async (context, input) => residenceCheckOutputSchema.parse(await context.callCapability(
    "world.interact", "base.residence-check", skillJsonValueSchema.parse(input))),
});
