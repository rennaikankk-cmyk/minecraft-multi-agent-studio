import { MAX_BLUEPRINT_CELLS, dimensionSchema, coordinateSchema, itemNameSchema, blueprintBlockClasses, blueprintBlockClassSchema, blueprintCellSchema, blueprintSchema, CLASS_RANK, blueprintClassRank, orderBlueprintCells, type BlueprintBlockClass, type BlueprintCell, type Blueprint } from '@minecraft-studio/base-management/blueprint-contracts';
export { MAX_BLUEPRINT_CELLS, dimensionSchema, coordinateSchema, itemNameSchema, blueprintBlockClasses, blueprintBlockClassSchema, blueprintCellSchema, blueprintSchema, CLASS_RANK, blueprintClassRank, orderBlueprintCells, type BlueprintBlockClass, type BlueprintCell, type Blueprint } from '@minecraft-studio/base-management/blueprint-contracts';
import { identifierSchema, skillJsonValueSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { SkillFault } from "../errors.js";
import { defineSkill, type SkillExecutionContext } from "../types.js";
import { blueprintWorksetObservationSchema, blueprintWorksetSummarySchema, selectBlueprintWorkset } from "./blueprint-workset.js";

/**
 * Blueprint execution is intentionally bounded and resumable.  It orders
 * relative cells and delegates every actual placement to world.place-block;
 * it never invents a second block-placement primitive.
 */
export const BUILD_BLUEPRINT_TIMEOUT_MS = 60_000;

export const MAX_BLUEPRINT_BATCH = 128;
export const BLUEPRINT_DESIGN_PLACEMENT_MS = 250;

const materialSchema = z
  .object({ itemName: itemNameSchema, count: z.number().int().min(0).max(64 * MAX_BLUEPRINT_CELLS) })
  .strict();

export const buildBlueprintInputSchema = z
  .object({
    blueprint: blueprintSchema,
    startIndex: z.number().int().min(0).max(MAX_BLUEPRINT_CELLS).optional(),
    maxPlacements: z.number().int().min(1).max(MAX_BLUEPRINT_BATCH).optional(),
    reconcile: z.boolean().optional(),
    inspectOnly: z.boolean().optional(),
    strategy: z.enum(["linear", "workset"]).optional(),
    /** Empty means inventory is unknown; the runtime remains authoritative. */
    availableMaterials: z.array(materialSchema).max(256).optional(),
  })
  .strict();
export type BuildBlueprintInput = z.infer<typeof buildBlueprintInputSchema>;

const observedPositionSchema = z
  .object({
    x: z.number().finite().min(-30_000_000).max(30_000_000),
    y: z.number().finite().min(-2_048).max(2_048),
    z: z.number().finite().min(-30_000_000).max(30_000_000),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    // runtime 快照附带朝向角（与 movement-goto 同一形状）：strict 下缺失会拒真状态
    yaw: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
  })
  .strict();
export const buildBlueprintStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    retreatInProgress: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

const placementSchema = z
  .object({
    index: z.number().int().min(0).max(MAX_BLUEPRINT_CELLS - 1),
    position: coordinateSchema,
    itemName: itemNameSchema,
    blockClass: blueprintBlockClassSchema,
    placed: z.literal(true),
  })
  .strict();
export const blueprintObservationSchema = z.object({
  states: z.array(z.enum(["match", "different", "unknown"])).min(1).max(MAX_BLUEPRINT_CELLS),
  observedAt: z.iso.datetime(),
}).strict();
export const buildBlueprintOutputSchema = z
  .object({
    completed: z.boolean(),
    startIndex: z.number().int().min(0).max(MAX_BLUEPRINT_CELLS),
    nextIndex: z.number().int().min(0).max(MAX_BLUEPRINT_CELLS),
    totalCells: z.number().int().min(1).max(MAX_BLUEPRINT_CELLS),
    placements: z.array(placementSchema).max(MAX_BLUEPRINT_BATCH),
    estimatedDurationMs: z.number().int().min(0),
    verification: blueprintObservationSchema.optional(),
    workset: blueprintWorksetSummarySchema.optional(),
  })
  .strict()
  .superRefine((output, context) => {
    if (output.nextIndex < (output.startIndex ?? 0)) {
      context.addIssue({ code: "custom", path: ["nextIndex"], message: "nextIndex cannot move backwards" });
    }
    if (output.nextIndex > output.totalCells) {
      context.addIssue({ code: "custom", path: ["nextIndex"], message: "nextIndex exceeds totalCells" });
    }
  });

export const buildBlueprintCapabilityInputSchema = z
  .object({
    itemName: itemNameSchema,
    referenceBlock: coordinateSchema,
    face: faceSchema,
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    target: coordinateSchema,
    blueprintIndex: z.number().int().min(0).max(MAX_BLUEPRINT_CELLS - 1),
  })
  .strict();
export const buildBlueprintCapabilityOutputSchema = z
  .object({ placed: z.literal(true), placedBlockName: itemNameSchema, position: coordinateSchema })
  .strict();

function absolutePosition(blueprint: Blueprint, cell: BlueprintCell): z.infer<typeof coordinateSchema> {
  return coordinateSchema.parse({
    x: blueprint.anchor.x + cell.offset.x,
    y: blueprint.anchor.y + cell.offset.y,
    z: blueprint.anchor.z + cell.offset.z,
  });
}

/** A prefix of the ordered plan never decorates an unbuilt structure. */
export function isIntermediateBlueprintSafe(cells: readonly BlueprintCell[]): boolean {
  let highestRank = -1;
  for (const cell of cells) {
    const rank = CLASS_RANK[cell.blockClass];
    if (rank < highestRank) return false;
    highestRank = Math.max(highestRank, rank);
  }
  return true;
}

function requiredMaterials(cells: readonly BlueprintCell[]): Map<string, number> {
  const required = new Map<string, number>();
  for (const cell of cells) required.set(cell.itemName, (required.get(cell.itemName) ?? 0) + 1);
  return required;
}

function hasMaterials(input: BuildBlueprintInput, cells: readonly BlueprintCell[]): boolean {
  if ((input.availableMaterials ?? []).length === 0) return true;
  const available = new Map((input.availableMaterials ?? []).map((entry) => [entry.itemName, entry.count]));
  for (const [itemName, count] of requiredMaterials(cells)) {
    if ((available.get(itemName) ?? 0) < count) return false;
  }
  return true;
}

function distance(a: z.infer<typeof coordinateSchema>, b: z.infer<typeof observedPositionSchema>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export type BlueprintPlan = Readonly<{
  orderedCells: readonly BlueprintCell[];
  totalCells: number;
  estimatedDurationMs: number;
}>;

export function planBlueprint(input: BuildBlueprintInput): BlueprintPlan {
  const orderedCells = orderBlueprintCells(input.blueprint);
  return Object.freeze({
    orderedCells,
    totalCells: orderedCells.length,
    estimatedDurationMs: orderedCells.length * BLUEPRINT_DESIGN_PLACEMENT_MS,
  });
}

function cellCapabilityInput(blueprint: Blueprint, cell: BlueprintCell, index: number) {
  const target = absolutePosition(blueprint, cell);
  const referenceOffset = cell.referenceOffset ?? { x: 0, y: -1, z: 0 };
  const face = cell.face ?? { x: 0, y: 1, z: 0 };
  return buildBlueprintCapabilityInputSchema.parse({
    itemName: cell.itemName,
    referenceBlock: {
      x: target.x + referenceOffset.x,
      y: target.y + referenceOffset.y,
      z: target.z + referenceOffset.z,
    },
    face,
    dimension: blueprint.dimension,
    serverProfileId: blueprint.serverProfileId,
    target,
    blueprintIndex: index,
  });
}

async function executeBlueprint(
  context: SkillExecutionContext,
  input: BuildBlueprintInput,
  state: z.infer<typeof buildBlueprintStateSchema>,
): Promise<z.infer<typeof buildBlueprintOutputSchema>> {
  if (input.strategy === "workset") return executeBlueprintWorkset(context, input);
  const plan = planBlueprint(input);
  const inspect = async () => {
    const observation = blueprintObservationSchema.parse(await context.callCapability(
      "world.interact", "blueprint.inspect", skillJsonValueSchema.parse(input.blueprint),
    ));
    if (observation.states.length !== plan.totalCells || observation.states.includes("unknown")) {
      throw new SkillFault("BUILD_VERIFY_TIMEOUT");
    }
    return observation;
  };
  const before = input.reconcile || input.inspectOnly ? await inspect() : null;
  const firstMissing = before?.states.indexOf("different") ?? -1;
  const startIndex = before ? (firstMissing < 0 ? plan.totalCells : firstMissing) : Math.min(input.startIndex ?? 0, plan.totalCells);
  const maxPlacements = input.maxPlacements ?? MAX_BLUEPRINT_BATCH;
  const cells = input.inspectOnly ? [] : plan.orderedCells.slice(startIndex, startIndex + maxPlacements);
  if (!isIntermediateBlueprintSafe(cells)) {
    // server false-success / 世界漂移证据：cell 索引与期望进入 reason（P1-1）
    throw new SkillFault(
      "BUILD_WRONG_BLOCK",
      `anchor=${input.blueprint.anchor.x},${input.blueprint.anchor.y},${input.blueprint.anchor.z}@${input.blueprint.dimension} startIndex=${startIndex} expected=intermediate cells match plan actual=placed state diverges (server false-success or world drift)`,
    );
  }
  const placements: z.infer<typeof placementSchema>[] = [];
  for (let offset = 0; offset < cells.length; offset += 1) {
    if (context.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    const index = startIndex + offset;
    const cell = cells[offset]!;
    const target = absolutePosition(input.blueprint, cell);
    if (before?.states[index] === "match") {
      placements.push({ index, position: target, itemName: cell.itemName, blockClass: cell.blockClass, placed: true });
      continue;
    }
    const raw = await context.callCapability(
      "world.interact",
      "block.place-safe",
      cellCapabilityInput(input.blueprint, cell, index),
    );
    const receipt = buildBlueprintCapabilityOutputSchema.parse(raw);
    if (receipt.placedBlockName !== cell.itemName || receipt.position.x !== target.x || receipt.position.y !== target.y || receipt.position.z !== target.z) {
      throw new SkillFault(
        "BUILD_WRONG_BLOCK",
        `anchor=${input.blueprint.anchor.x},${input.blueprint.anchor.y},${input.blueprint.anchor.z}@${input.blueprint.dimension} cellIndex=${index} order=${cell.order} expected=${cell.itemName}@${target.x},${target.y},${target.z} actual=receipt@${receipt.position.x},${receipt.position.y},${receipt.position.z}`,
      );
    }
    placements.push({ index, position: target, itemName: cell.itemName, blockClass: cell.blockClass, placed: true });
  }
  const after = input.inspectOnly ? before : input.reconcile ? await inspect() : null;
  const nextMissing = after?.states.indexOf("different") ?? -1;
  const nextIndex = after ? (nextMissing < 0 ? plan.totalCells : nextMissing) : startIndex + placements.length;
  if (after && nextIndex < startIndex + placements.length) throw new SkillFault("BUILD_WRONG_BLOCK");
  return buildBlueprintOutputSchema.parse({
    completed: nextIndex >= plan.totalCells,
    startIndex,
    nextIndex,
    totalCells: plan.totalCells,
    placements,
    estimatedDurationMs: placements.length * BLUEPRINT_DESIGN_PLACEMENT_MS,
    ...(after ? { verification: after } : {}),
  });
}

async function executeBlueprintWorkset(context: SkillExecutionContext, input: BuildBlueprintInput) {
  const ordered = orderBlueprintCells(input.blueprint);
  const placements: z.infer<typeof placementSchema>[] = [];
  const budget = input.availableMaterials?.map((m) => ({ ...m }));
  const maxPlacements = input.maxPlacements ?? MAX_BLUEPRINT_BATCH;
  const inspect = async () => {
    if (context.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    const observed = blueprintWorksetObservationSchema.parse(await context.callCapability(
      "world.interact", "blueprint.inspect-workset", skillJsonValueSchema.parse(input.blueprint)));
    if (observed.cells.length !== ordered.length) throw new SkillFault("BLUEPRINT_WORKSET_INVALID");
    if (context.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    const policy = context.policy;
    if (!policy || policy.serverProfileId !== input.blueprint.serverProfileId) throw new SkillFault("SKILL_POLICY_UNAVAILABLE");
    const origin = observed.playerPosition;
    const permitted = (p: { x: number; y: number; z: number }) => origin !== null && policy.checkBlockReach(
      Math.hypot(p.x + 0.5 - origin.x, p.y + 0.5 - origin.y, p.z + 0.5 - origin.z)).allowed;
    observed.cells = observed.cells.map((cell, index) => ({ ...cell,
      reachable: cell.reachable && permitted(absolutePosition(input.blueprint, ordered[index]!)),
      workfaces: cell.workfaces.filter((face) => permitted(face.referenceBlock)),
    }));
    return observed;
  };
  // Each effect is followed by a bounded fresh snapshot, including the final effect.
  // Workfaces are never a persistent second world model.
  let observation = await inspect();
  let selected = selectBlueprintWorkset(input, observation);
  while (!input.inspectOnly && selected.next && placements.length < maxPlacements) {
    if (context.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    const { index, referenceBlock, face } = selected.next;
    const cell = ordered[index]!;
    const target = absolutePosition(input.blueprint, cell);
    const receipt = buildBlueprintCapabilityOutputSchema.parse(await context.callCapability("world.interact", "block.place-safe",
      buildBlueprintCapabilityInputSchema.parse({ ...cellCapabilityInput(input.blueprint, cell, index), referenceBlock, face })));
    if (receipt.placedBlockName !== cell.itemName || receipt.position.x !== target.x || receipt.position.y !== target.y || receipt.position.z !== target.z) {
      throw new SkillFault("BUILD_WRONG_BLOCK");
    }
    placements.push({ index, position: target, itemName: cell.itemName, blockClass: cell.blockClass, placed: true });
    const material = budget?.find((m) => m.itemName === cell.itemName);
    if (material) material.count = Math.max(0, material.count - 1);
    observation = await inspect();
    if (observation.cells[index]?.state !== "match") throw new SkillFault("BUILD_WRONG_BLOCK");
    selected = selectBlueprintWorkset({ ...input, ...(budget ? { availableMaterials: budget } : {}) }, observation);
  }
  const states = observation.cells.map((c) => c.state);
  const firstUnverified = states.findIndex((value) => value !== "match");
  return buildBlueprintOutputSchema.parse({
    completed: firstUnverified < 0, startIndex: 0, nextIndex: firstUnverified < 0 ? ordered.length : firstUnverified,
    totalCells: ordered.length, placements, estimatedDurationMs: placements.length * BLUEPRINT_DESIGN_PLACEMENT_MS,
    verification: { states, observedAt: observation.observedAt },
    workset: { ...selected.summary, status: selected.next && placements.length >= maxPlacements ? "BATCH_LIMIT" : selected.summary.status },
  });
}

export const buildBlueprintSkill = defineSkill({
  id: "build.blueprint",
  version: "1.0.0",
  progressContract: "PLACE_AND_VERIFY",
  inputSchema: buildBlueprintInputSchema,
  outputSchema: buildBlueprintOutputSchema,
  stateSchema: buildBlueprintStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: BUILD_BLUEPRINT_TIMEOUT_MS,
  idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 250, maxDelayMs: 2_000, retryableErrorCodes: [] },
  preconditions: [
    { id: "retreat.not-in-progress", failureCode: "RETREAT_IN_PROGRESS", check: (_input, state) => !state.retreatInProgress },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_input, state) => state.normalActionsAllowed },
    {
      id: "blueprint.anchor-valid",
      failureCode: "BLUEPRINT_ANCHOR_INVALID",
      check: (input, state) =>
        input.blueprint.serverProfileId === state.serverProfileId &&
        state.position !== null &&
        input.blueprint.dimension === state.position.dimension &&
        input.blueprint.cells.every((cell) => {
          const target = absolutePosition(input.blueprint, cell);
          return Number.isSafeInteger(target.x) && Number.isSafeInteger(target.y) && Number.isSafeInteger(target.z);
        }),
    },
    {
      id: "blueprint.materials-available",
      failureCode: "BUILD_MATERIAL_MISSING",
      check: (input) => {
        const ordered = orderBlueprintCells(input.blueprint);
        const startIndex = input.startIndex ?? 0;
        const maxPlacements = input.maxPlacements ?? MAX_BLUEPRINT_BATCH;
        return input.strategy === "workset" || input.reconcile === true || input.inspectOnly === true || hasMaterials(input, ordered.slice(startIndex, startIndex + maxPlacements));
      },
    },
    {
      id: "blueprint.any-cell-in-reach",
      failureCode: "BUILD_CELL_UNREACHABLE",
      check: (input, state, policy) => {
        if (input.inspectOnly || input.strategy === "workset") return true;
        const position = state.position;
        if (position === null) return false;
        const startIndex = input.startIndex ?? 0;
        const maxPlacements = input.maxPlacements ?? MAX_BLUEPRINT_BATCH;
        const ordered = orderBlueprintCells(input.blueprint).slice(startIndex, startIndex + maxPlacements);
        return ordered.some((cell) => policy.checkBlockReach(distance(absolutePosition(input.blueprint, cell), position)).allowed);
      },
    },
  ],
  execute: (context, input, state) => executeBlueprint(context, input, state),
});
import { faceSchema } from '@minecraft-studio/base-management/blueprint-contracts';
