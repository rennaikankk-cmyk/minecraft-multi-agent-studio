import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { SkillFault } from "../errors.js";
import { defineSkill } from "../types.js";

export const SCOUT_SCAN_BLOCKS_TIMEOUT_MS = 8_000;
export const SCOUT_SCAN_MAX_BLOCK_NAMES = 16;
export const SCOUT_SCAN_MAX_DISTANCE = 64;
export const SCOUT_SCAN_MAX_RESULTS = 64;

const blockNameSchema = z
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
    y: z.number().int().min(-4_096).max(4_096),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  })
  .strict();
const observedPositionSchema = z
  .object({
    x: z.number().finite().min(-30_000_000).max(30_000_000),
    y: z.number().finite().min(-4_096).max(4_096),
    z: z.number().finite().min(-30_000_000).max(30_000_000),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const scoutScanBlocksInputSchema = z
  .object({
    serverProfileId: identifierSchema,
    dimension: dimensionSchema,
    blockNames: z
      .array(blockNameSchema)
      .min(1)
      .max(SCOUT_SCAN_MAX_BLOCK_NAMES)
      .refine((values) => new Set(values).size === values.length, {
        message: "Scout block names must be unique.",
      }),
    maxDistance: z.number().int().min(2).max(SCOUT_SCAN_MAX_DISTANCE),
    maxResults: z.number().int().min(1).max(SCOUT_SCAN_MAX_RESULTS),
  })
  .strict();

export const scoutScanBlocksStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

export const scoutBlockObservationSchema = z
  .object({
    blockName: blockNameSchema,
    position: blockPositionSchema,
  })
  .strict();

export const scoutScanBlocksOutputSchema = z
  .object({
    origin: blockPositionSchema,
    observations: z
      .array(scoutBlockObservationSchema)
      .max(SCOUT_SCAN_MAX_RESULTS)
      .refine(
        (values) =>
          new Set(
            values.map(
              ({ blockName, position }) =>
                `${blockName}:${position.x}:${position.y}:${position.z}`,
            ),
          ).size === values.length,
        { message: "Scout observations must be unique." },
      ),
  })
  .strict();

export const scoutScanBlocksCapabilityInputSchema =
  scoutScanBlocksInputSchema;
export const scoutScanBlocksCapabilityOutputSchema =
  scoutScanBlocksOutputSchema;

function outputMatchesRequest(
  input: z.infer<typeof scoutScanBlocksInputSchema>,
  output: z.infer<typeof scoutScanBlocksOutputSchema>,
): boolean {
  const allowedNames = new Set(input.blockNames);
  return (
    output.observations.length <= input.maxResults &&
    output.observations.every(
      ({ blockName, position }) =>
        allowedNames.has(blockName) &&
        Math.hypot(
          position.x - output.origin.x,
          position.y - output.origin.y,
          position.z - output.origin.z,
        ) <= input.maxDistance + 1,
    )
  );
}

export const scoutScanBlocksSkill = defineSkill({
  id: "scout.scan-blocks",
  version: "1.0.0",
  inputSchema: scoutScanBlocksInputSchema,
  outputSchema: scoutScanBlocksOutputSchema,
  stateSchema: scoutScanBlocksStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["world.read"] as const,
  timeoutMs: SCOUT_SCAN_BLOCKS_TIMEOUT_MS,
  idempotent: true,
  retryPolicy: {
    maxAttempts: 2,
    baseDelayMs: 50,
    maxDelayMs: 250,
    retryableErrorCodes: ["SKILL_CAPABILITY_FAILED"],
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
      check: (input, state) =>
        input.serverProfileId === state.serverProfileId,
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
      "world.read",
      "scout.scan-blocks-safe",
      scoutScanBlocksCapabilityInputSchema.parse(input),
    );
    const output = scoutScanBlocksCapabilityOutputSchema.parse(raw);
    if (!outputMatchesRequest(input, output)) {
      throw new SkillFault("SCOUT_SCAN_OUTPUT_MISMATCH");
    }
    return output;
  },
});
