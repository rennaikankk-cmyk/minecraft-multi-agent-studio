import { skillJsonValueSchema, type SkillJsonValue, type SkillCapability } from "@minecraft-studio/protocol";
import { z } from "zod";
import { defineSkill } from "./types.js";
import { workAreaSchema, workPositionSchema, workScopeSchema } from "./work-area.js";

export const processStateSchema = z.object({ online: z.boolean(), normalActionsAllowed: z.boolean(),
  isolatedTestServer: z.boolean().default(false),
  retreatInProgress: z.boolean().default(false), serverProfileId: workScopeSchema.shape.serverProfileId,
  position: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite(),
    dimension: workScopeSchema.shape.dimension }).strip().nullable() }).strip();
export const navigationClauseSchema = z.object({
  kind: z.enum(["block", "near", "xz", "y", "adjacent", "runaway"]),
  position: workPositionSchema, radius: z.number().min(1).max(64).default(2), invert: z.boolean().default(false),
}).strict();
export const navigationGoalInputSchema = workScopeSchema.extend({
  clauses: z.array(navigationClauseSchema).min(1).max(16), combine: z.enum(["any", "all"]).default("any"),
}).strict();
export const navigationGoalOutputSchema = z.object({ reached: z.literal(true), position: workPositionSchema,
  observedAt: z.string().datetime() }).strict();
export const followEntityInputSchema = workScopeSchema.extend({
  entityId: z.number().int().nonnegative(), radius: z.number().min(1).max(16).default(3),
  durationMs: z.number().int().min(100).max(30_000).default(10_000),
  maxDistance: z.number().min(2).max(256).default(64),
}).strict();
export const followEntityOutputSchema = z.object({
  completed: z.boolean(), status: z.enum(["INTERVAL_COMPLETE", "TARGET_LOST", "TARGET_OUT_OF_RANGE", "WAITING_PATH"]),
  trackedMs: z.number().int().nonnegative(), nearTargetMs: z.number().int().nonnegative(),
  observedAt: z.string().datetime(),
}).strict();
export const getToBlockInputSchema = workScopeSchema.extend({
  blockName: z.string().regex(/^[a-z0-9_]+$/).max(64), maxDistance: z.number().int().min(1).max(128).default(32),
  maxCandidates: z.number().int().min(1).max(64).default(16),
}).strict();
export const getToBlockOutputSchema = z.object({
  reached: z.literal(true), position: workPositionSchema, blockName: z.string(), observedAt: z.string().datetime(),
}).strict();
const chunkSchema = z.object({ x: z.number().int().min(-1_875_000).max(1_875_000), z: z.number().int().min(-1_875_000).max(1_875_000) }).strict();
export const exploreInputSchema = workScopeSchema.extend({
  center: chunkSchema, radiusChunks: z.number().int().min(0).max(16).default(2),
  maxChunks: z.number().int().min(1).max(16).default(4),
  visited: z.array(chunkSchema).max(1089).default([]),
  excluded: z.array(chunkSchema).max(1089).default([]),
}).strict();
export const exploreOutputSchema = z.object({ completed: z.boolean(),
  status: z.enum(["AREA_OBSERVED", "BATCH_LIMIT", "WAITING_PATH", "WAITING_OBSERVATION"]),
  visited: z.array(chunkSchema).max(1089), newlyObserved: z.number().int().min(0).max(16),
  observedAt: z.string().datetime(),
}).strict();
export const clearAreaInputSchema = z.object({ area: workAreaSchema,
  maxBlocks: z.number().int().min(1).max(64).default(16),
  blockNames: z.array(z.string().regex(/^[a-z0-9_]+$/).max(64)).min(1).max(64),
}).strict();
export const clearAreaOutputSchema = z.object({ completed: z.boolean(),
  status: z.enum(["AREA_CLEAR", "BATCH_LIMIT", "WAITING_OBSERVATION", "BLOCKED"]),
  broken: z.number().int().min(0).max(64), remaining: z.number().int().min(0).max(4096),
  unknown: z.number().int().min(0).max(4096), blocked: z.number().int().min(0).max(4096),
  observedAt: z.string().datetime(),
}).strict();
export const elytraInputSchema = workScopeSchema.extend({
  target: workPositionSchema, waypoints: z.array(workPositionSchema).max(16).default([]), radius: z.number().min(2).max(8).default(4),
  maxFlightMs: z.number().int().min(1000).max(120_000).default(30_000),
  useFireworks: z.boolean().default(true), minimumFireworks: z.number().int().min(0).max(64).default(2),
  maxFireworks: z.number().int().min(0).max(64).default(16),
  rocketReserve: z.number().int().min(0).max(64).default(1),
  autoEquip: z.boolean().default(true),
  minimumDurability: z.number().int().min(20).max(400).default(40),
}).strict();
export const elytraOutputSchema = z.object({ landed: z.literal(true), reached: z.boolean(),
  touchdown: workPositionSchema.optional(), groundApproachDistance: z.number().finite().min(0).max(24).default(0),
  status: z.enum(["TARGET_LANDED", "EMERGENCY_LANDED"]), reason: z.string().max(80).nullable(),
  position: workPositionSchema, segments: z.number().int().positive(), distance: z.number().finite().nonnegative(), fireworksUsed: z.number().int().nonnegative(), observedAt: z.string().datetime() }).strict();

function processSkill<I, O>(id: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>,
  capability: SkillCapability, scope: (input: I) => { serverProfileId: string; dimension: string }) {
  return defineSkill({ id, version: "1.0.0", inputSchema, outputSchema, stateSchema: processStateSchema,
    progressContract: capability === "bot.move" ? "MOVE_TO_TARGET" as const : "PLACE_AND_VERIFY" as const,
    compatibility: { variants: [{ id: "mineflayer", requirements: [], verifiedMinecraftVersions: [] }] },
    requiredCapabilities: capability === "bot.move" ? ["bot.move"] : ["world.interact", "bot.move"],
    timeoutMs: 60_000, idempotent: false,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500, retryableErrorCodes: [] },
    preconditions: [
      { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_i, s) => s.online },
      { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_i, s) => s.normalActionsAllowed && !s.retreatInProgress },
      { id: "scope.server-profile", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (i, s) => scope(i).serverProfileId === s.serverProfileId },
      { id: "scope.dimension", failureCode: "TARGET_DIMENSION_MISMATCH", check: (i, s) => scope(i).dimension === s.position?.dimension },
    ],
    execute: async (context, input) => outputSchema.parse(await context.callCapability(capability, `${id}-safe`, skillJsonValueSchema.parse(input) as SkillJsonValue)),
  });
}
export const navigationGoalSkill = processSkill("movement.goal", navigationGoalInputSchema, navigationGoalOutputSchema, "bot.move", (i) => i);
export const followEntitySkill = processSkill("movement.follow", followEntityInputSchema, followEntityOutputSchema, "bot.move", (i) => i);
export const getToBlockSkill = processSkill("movement.get-to-block", getToBlockInputSchema, getToBlockOutputSchema, "bot.move", (i) => i);
export const exploreSkill = processSkill("world.explore", exploreInputSchema, exploreOutputSchema, "bot.move", (i) => i);
export const clearAreaSkill = processSkill("build.clear-area", clearAreaInputSchema, clearAreaOutputSchema, "world.interact", (i) => i.area);
const elytraProcess = processSkill("movement.elytra", elytraInputSchema, elytraOutputSchema, "bot.move", (i) => i);
export const elytraSkill = defineSkill({ ...elytraProcess,
  version: "1.1.0", timeoutMs: 150_000,
  preconditions: [
    ...elytraProcess.preconditions,
    { id: "flight.isolated-validation", failureCode: "ELYTRA_ISOLATED_VALIDATION_REQUIRED", check: (_i, s) => s.isolatedTestServer },
  ],
  compatibility: { variants: [{ id: "mineflayer-elytra", requirements: [{ kind: "resource", resource: "item", names: ["elytra"], match: "all" }], verifiedMinecraftVersions: [] }] },
});
export const baritoneProcessSkills = [navigationGoalSkill, followEntitySkill, getToBlockSkill, exploreSkill, clearAreaSkill, elytraSkill] as const;
