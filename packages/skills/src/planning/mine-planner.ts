import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { SkillFault } from "../errors.js";
import { defineSkill } from "../types.js";

/**
 * Mining is deliberately a planner, not a Mineflayer loop.  The runtime is
 * expected to execute one bounded sequence and report observations back before
 * the next sequence is planned.  The constants below are design targets and
 * have not been validated against a Minecraft server.
 */
export const MINE_BRANCH_TIMEOUT_MS = 60_000;
export const MINE_VEIN_TIMEOUT_MS = 60_000;
export const MINE_MAX_BLOCKS = 128;
export const MINE_MIN_SAFE_Y = -58;
export const MINE_DESIGN_DIG_MS = 250;
export const MINE_TRAVEL_STEP_MS = 75;

export const mineExclusionKinds = [
  "own-hideout",
  "blueprint-anchor",
  "load-bearing",
  "liquid-adjacent",
] as const;
export type MineExclusionKind = (typeof mineExclusionKinds)[number];

export type MinePosition = Readonly<{ x: number; y: number; z: number }>;
export type MineDimension = Readonly<{
  dimension: string;
  serverProfileId: string;
}>;

export type MineSafetyFacts = Readonly<{
  lavaAdjacent: boolean;
  voidRisk: boolean;
  waterAdjacent?: boolean | undefined;
}>;

export type MinePlanStep = Readonly<{
  index: number;
  kind: "main" | "branch" | "vein" | "return";
  position: MinePosition;
  targetItem: string;
  backfill: boolean;
  exclusions: readonly MineExclusionKind[];
}>;

export type MinePlan = Readonly<{
  ok: true;
  targetItem: string;
  yLevel: number;
  steps: readonly MinePlanStep[];
  estimatedDurationMs: number;
  exposureScore: number;
  oreConfidence: number;
  exclusions: readonly MineExclusionKind[];
}> | Readonly<{
  ok: false;
  failureCode: "MINE_LAVA_ADJACENT" | "MINE_VOID_RISK" | "MINE_NO_TARGET";
}>;

export type MineYLayerDefault = Readonly<{
  targetItem: string;
  minimumMinecraftVersion: string;
  recommendedY: number;
  verified: false;
  note: "未实测";
}>;

/** Version-gated hints only. Callers must still pass yLevel to a skill. */
export const defaultOreYLayers: readonly MineYLayerDefault[] = Object.freeze([
  { targetItem: "minecraft:diamond", minimumMinecraftVersion: "1.18.0", recommendedY: -59, verified: false, note: "未实测" },
  { targetItem: "minecraft:iron_ore", minimumMinecraftVersion: "1.18.0", recommendedY: 16, verified: false, note: "未实测" },
  { targetItem: "minecraft:gold_ore", minimumMinecraftVersion: "1.18.0", recommendedY: -16, verified: false, note: "未实测" },
  { targetItem: "minecraft:ancient_debris", minimumMinecraftVersion: "1.16.0", recommendedY: 15, verified: false, note: "未实测" },
  { targetItem: "minecraft:obsidian", minimumMinecraftVersion: "1.16.0", recommendedY: 16, verified: false, note: "未实测" },
]);

const positionSchema = z.object({
  x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-2_048).max(2_048),
  z: z.number().int().min(-30_000_000).max(30_000_000),
}).strict();
const dimensionSchema = z.string().min(3).max(128).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);
const blockNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9_]+:[a-z0-9_./-]+$/u);
const safetySchema = z.object({
  lavaAdjacent: z.boolean(),
  voidRisk: z.boolean(),
  waterAdjacent: z.boolean().optional(),
}).strict();
const exclusionsSchema = z.array(z.enum(mineExclusionKinds)).min(4).max(4);

export const mineBranchInputSchema = z.object({
  targetItem: blockNameSchema,
  yLevel: z.number().int().min(-2_048).max(2_048),
  branchLength: z.number().int().min(1).max(MINE_MAX_BLOCKS),
  branchSpacing: z.number().int().min(1).max(MINE_MAX_BLOCKS),
  maxBlocks: z.number().int().min(1).max(MINE_MAX_BLOCKS),
  origin: positionSchema,
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
  backfill: z.boolean(),
  exclusions: exclusionsSchema,
  safety: safetySchema.optional(),
}).strict();
export type MineBranchInput = z.infer<typeof mineBranchInputSchema>;

export const mineVeinInputSchema = z.object({
  targetItem: blockNameSchema,
  yLevel: z.number().int().min(-2_048).max(2_048),
  maxBlocks: z.number().int().min(1).max(MINE_MAX_BLOCKS),
  origin: positionSchema,
  /** Observed connected ore positions. Unknown means no target, fail closed. */
  orePositions: z.array(positionSchema).max(MINE_MAX_BLOCKS),
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
  backfill: z.boolean(),
  exclusions: exclusionsSchema,
  safety: safetySchema.optional(),
}).strict();
export type MineVeinInput = z.infer<typeof mineVeinInputSchema>;

const observedPositionSchema = positionSchema.extend({
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
}).strict();
const mineStateSchema = z.object({
  online: z.boolean(),
  normalActionsAllowed: z.boolean(),
  serverProfileId: identifierSchema,
  position: observedPositionSchema.nullable(),
  safety: safetySchema,
}).strip();
const planStepSchema = z.object({
  index: z.number().int().min(0),
  kind: z.enum(["main", "branch", "vein", "return"]),
  position: positionSchema,
  targetItem: blockNameSchema,
  backfill: z.boolean(),
  exclusions: z.array(z.enum(mineExclusionKinds)).min(4).max(4),
}).strict();
const planOutputSchema = z.object({
  targetItem: blockNameSchema,
  yLevel: z.number().int(),
  steps: z.array(planStepSchema).max(MINE_MAX_BLOCKS * 2),
  estimatedDurationMs: z.number().int().min(0),
  exposureScore: z.number().min(0).max(1),
  oreConfidence: z.number().min(0).max(1),
}).strict();

export const mineBranchStateSchema = mineStateSchema;
export const mineVeinStateSchema = mineStateSchema;
export const mineBranchOutputSchema = planOutputSchema;
export const mineVeinOutputSchema = planOutputSchema;
export const mineBranchCapabilityInputSchema = mineBranchInputSchema.extend({ plan: planOutputSchema });
export const mineVeinCapabilityInputSchema = mineVeinInputSchema.extend({ plan: planOutputSchema });
export const mineBranchCapabilityOutputSchema = planOutputSchema;
export const mineVeinCapabilityOutputSchema = planOutputSchema;

function assertSafe(yLevel: number, safety: MineSafetyFacts | undefined): MinePlan | null {
  if (safety?.lavaAdjacent || safety?.waterAdjacent) return { ok: false, failureCode: "MINE_LAVA_ADJACENT" };
  if (safety?.voidRisk || yLevel < MINE_MIN_SAFE_Y) return { ok: false, failureCode: "MINE_VOID_RISK" };
  return null;
}

function step(index: number, kind: MinePlanStep["kind"], position: MinePosition, targetItem: string, backfill: boolean, exclusions: readonly MineExclusionKind[]): MinePlanStep {
  return { index, kind, position: { ...position }, targetItem, backfill, exclusions: [...exclusions] };
}

function finalise(targetItem: string, yLevel: number, steps: readonly MinePlanStep[], backfill: boolean, exclusions: readonly MineExclusionKind[], oreConfidence: number): MinePlan {
  const count = steps.length;
  // Exposure is deliberately a telemetry score, not a policy decision. It is
  // monotonic with work spent in one area and remains bounded for callers.
  const exposureScore = Math.min(1, count / MINE_MAX_BLOCKS);
  const estimatedDurationMs = count * (MINE_DESIGN_DIG_MS + MINE_TRAVEL_STEP_MS) + (backfill ? count * MINE_DESIGN_DIG_MS : 0);
  return { ok: true, targetItem, yLevel, steps, estimatedDurationMs, exposureScore, oreConfidence, exclusions: [...exclusions] };
}

/** Build a bounded main tunnel and alternating side branches along the z axis. */
export function planBranchMine(input: MineBranchInput, safety = input.safety): MinePlan {
  const unsafe = assertSafe(input.yLevel, safety);
  if (unsafe) return unsafe;
  const steps: MinePlanStep[] = [];
  const add = (kind: MinePlanStep["kind"], position: MinePosition) => {
    if (steps.length < input.maxBlocks) steps.push(step(steps.length, kind, position, input.targetItem, input.backfill, input.exclusions));
  };
  for (let distance = 1; distance <= input.branchLength && steps.length < input.maxBlocks; distance += 1) {
    add("main", { x: input.origin.x + distance, y: input.yLevel, z: input.origin.z });
    if (distance % input.branchSpacing !== 0) continue;
    for (let side = -1; side <= 1 && steps.length < input.maxBlocks; side += 2) {
      for (let offset = 1; offset <= input.branchLength && steps.length < input.maxBlocks; offset += 1) {
        add("branch", { x: input.origin.x + distance, y: input.yLevel, z: input.origin.z + side * offset });
      }
    }
  }
  return finalise(input.targetItem, input.yLevel, steps, input.backfill, input.exclusions, 0);
}

/** Follow observed connected ore in deterministic nearest-neighbour order, then return home. */
export function planVeinMine(input: MineVeinInput, safety = input.safety): MinePlan {
  const unsafe = assertSafe(input.yLevel, safety);
  if (unsafe) return unsafe;
  const unique = new Map(input.orePositions.map((position) => [`${position.x},${position.y},${position.z}`, position]));
  if (unique.size === 0) return { ok: false, failureCode: "MINE_NO_TARGET" };
  const remaining = [...unique.values()];
  const ordered: MinePosition[] = [];
  let cursor = input.origin;
  while (remaining.length > 0 && ordered.length < input.maxBlocks) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (candidate === undefined) continue;
      const bestCandidate = remaining[bestIndex];
      if (bestCandidate === undefined) continue;
      const distance = Math.abs(candidate.x - cursor.x) + Math.abs(candidate.y - cursor.y) + Math.abs(candidate.z - cursor.z);
      if (distance < bestDistance || (distance === bestDistance && `${candidate.x},${candidate.y},${candidate.z}` < `${bestCandidate.x},${bestCandidate.y},${bestCandidate.z}`)) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    if (next === undefined) break;
    ordered.push(next);
    cursor = next;
  }
  const steps = ordered.map((position, index) => step(index, "vein", position, input.targetItem, input.backfill, input.exclusions));
  if (steps.length < input.maxBlocks) steps.push(step(steps.length, "return", input.origin, input.targetItem, false, input.exclusions));
  return finalise(input.targetItem, input.yLevel, steps, input.backfill, input.exclusions, Math.min(1, ordered.length / Math.max(1, input.orePositions.length)));
}

async function executeMine<TInput extends MineBranchInput | MineVeinInput>(context: Parameters<typeof defineSkill>[0] extends never ? never : any, input: TInput, planner: (value: TInput, safety: MineSafetyFacts | undefined) => MinePlan, operation: string): Promise<z.infer<typeof planOutputSchema>> {
  const plan = planner(input, input.safety);
  if (!plan.ok) throw new SkillFault(plan.failureCode);
  const output = await context.callCapability("world.interact", operation, { ...input, plan });
  return planOutputSchema.parse(output);
}

export const mineBranchSkill = defineSkill({
  id: "mine.branch", version: "1.0.0", inputSchema: mineBranchInputSchema,
  outputSchema: mineBranchOutputSchema, stateSchema: mineBranchStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: MINE_BRANCH_TIMEOUT_MS, idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 500, maxDelayMs: 2_000, retryableErrorCodes: ["POLICY_RATE_EXCEEDED"] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_input, state) => state.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (input, state) => input.serverProfileId === state.serverProfileId },
    { id: "mine.safety-clear", failureCode: "MINE_LAVA_ADJACENT", check: (_input, state) => !state.safety.lavaAdjacent && !state.safety.waterAdjacent && !state.safety.voidRisk },
  ],
  execute: (context, input) => executeMine(context, input, planBranchMine, "mine.branch-safe"),
});

export const mineVeinSkill = defineSkill({
  id: "mine.vein", version: "1.0.0", inputSchema: mineVeinInputSchema,
  outputSchema: mineVeinOutputSchema, stateSchema: mineVeinStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: MINE_VEIN_TIMEOUT_MS, idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 500, maxDelayMs: 2_000, retryableErrorCodes: ["POLICY_RATE_EXCEEDED"] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_input, state) => state.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (input, state) => input.serverProfileId === state.serverProfileId },
    { id: "mine.safety-clear", failureCode: "MINE_LAVA_ADJACENT", check: (_input, state) => !state.safety.lavaAdjacent && !state.safety.waterAdjacent && !state.safety.voidRisk },
  ],
  execute: (context, input) => executeMine(context, input, planVeinMine, "mine.vein-safe"),
});
