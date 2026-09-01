import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { SkillFault } from "../errors.js";
import { defineSkill, type SkillExecutionContext } from "../types.js";

/**
 * Blueprint execution is intentionally bounded and resumable.  It orders
 * relative cells and delegates every actual placement to world.place-block;
 * it never invents a second block-placement primitive.
 */
export const BUILD_BLUEPRINT_TIMEOUT_MS = 60_000;
export const MAX_BLUEPRINT_CELLS = 512;
export const MAX_BLUEPRINT_BATCH = 128;
export const BLUEPRINT_DESIGN_PLACEMENT_MS = 250;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);
const itemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);
const coordinateSchema = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2_048).max(2_048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  })
  .strict();
const offsetSchema = z
  .object({
    x: z.number().int().min(-64).max(64),
    y: z.number().int().min(-64).max(64),
    z: z.number().int().min(-64).max(64),
  })
  .strict();
const faceSchema = z
  .object({
    x: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    y: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    z: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  })
  .strict()
  .refine((face) => Math.abs(face.x) + Math.abs(face.y) + Math.abs(face.z) === 1, {
    message: "face must be a unit axis vector",
  });

export const blueprintBlockClasses = [
  "foundation",
  "load-bearing",
  "structural",
  "structure",
  "utility",
  "shell",
  "decoration",
] as const;
export const blueprintBlockClassSchema = z.enum(blueprintBlockClasses);
export type BlueprintBlockClass = z.infer<typeof blueprintBlockClassSchema>;

export const blueprintCellSchema = z
  .object({
    offset: offsetSchema,
    itemName: itemNameSchema,
    blockClass: blueprintBlockClassSchema,
    order: z.number().int().min(0).max(MAX_BLUEPRINT_CELLS * 8),
    /** Optional support face. Defaults to the block immediately below target. */
    referenceOffset: offsetSchema.optional(),
    face: faceSchema.optional(),
  })
  .strict();
export type BlueprintCell = z.infer<typeof blueprintCellSchema>;

export const blueprintSchema = z
  .object({
    anchor: coordinateSchema,
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    cells: z.array(blueprintCellSchema).min(1).max(MAX_BLUEPRINT_CELLS),
  })
  .strict();
export type Blueprint = z.infer<typeof blueprintSchema>;

const materialSchema = z
  .object({ itemName: itemNameSchema, count: z.number().int().min(0).max(64 * MAX_BLUEPRINT_CELLS) })
  .strict();

export const buildBlueprintInputSchema = z
  .object({
    blueprint: blueprintSchema,
    startIndex: z.number().int().min(0).max(MAX_BLUEPRINT_CELLS).optional(),
    maxPlacements: z.number().int().min(1).max(MAX_BLUEPRINT_BATCH).optional(),
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
export const buildBlueprintOutputSchema = z
  .object({
    completed: z.boolean(),
    startIndex: z.number().int().min(0).max(MAX_BLUEPRINT_CELLS),
    nextIndex: z.number().int().min(0).max(MAX_BLUEPRINT_CELLS),
    totalCells: z.number().int().min(1).max(MAX_BLUEPRINT_CELLS),
    placements: z.array(placementSchema).max(MAX_BLUEPRINT_BATCH),
    estimatedDurationMs: z.number().int().min(0),
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

const CLASS_RANK: Readonly<Record<BlueprintBlockClass, number>> = Object.freeze({
  foundation: 0,
  "load-bearing": 1,
  structural: 1,
  structure: 1,
  utility: 2,
  shell: 3,
  decoration: 4,
});

function absolutePosition(blueprint: Blueprint, cell: BlueprintCell): z.infer<typeof coordinateSchema> {
  return coordinateSchema.parse({
    x: blueprint.anchor.x + cell.offset.x,
    y: blueprint.anchor.y + cell.offset.y,
    z: blueprint.anchor.z + cell.offset.z,
  });
}

/** Stable structural-first ordering; original order breaks all remaining ties. */
export function orderBlueprintCells(blueprint: Blueprint): readonly BlueprintCell[] {
  return Object.freeze(
    blueprint.cells
      .map((cell, index) => ({ cell, index }))
      .sort((left, right) =>
        CLASS_RANK[left.cell.blockClass] - CLASS_RANK[right.cell.blockClass] ||
        left.cell.order - right.cell.order ||
        left.index - right.index,
      )
      .map(({ cell }) => cell),
  );
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
  const plan = planBlueprint(input);
  const startIndex = Math.min(input.startIndex ?? 0, plan.totalCells);
  const maxPlacements = input.maxPlacements ?? MAX_BLUEPRINT_BATCH;
  const cells = plan.orderedCells.slice(startIndex, startIndex + maxPlacements);
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
    const raw = await context.callCapability(
      "world.interact",
      "block.place-safe",
      cellCapabilityInput(input.blueprint, cell, index),
    );
    const receipt = buildBlueprintCapabilityOutputSchema.parse(raw);
    if (receipt.position.x !== target.x || receipt.position.y !== target.y || receipt.position.z !== target.z) {
      throw new SkillFault(
        "BUILD_WRONG_BLOCK",
        `anchor=${input.blueprint.anchor.x},${input.blueprint.anchor.y},${input.blueprint.anchor.z}@${input.blueprint.dimension} cellIndex=${index} order=${cell.order} expected=${cell.itemName}@${target.x},${target.y},${target.z} actual=receipt@${receipt.position.x},${receipt.position.y},${receipt.position.z}`,
      );
    }
    placements.push({ index, position: target, itemName: cell.itemName, blockClass: cell.blockClass, placed: true });
  }
  const nextIndex = startIndex + placements.length;
  return buildBlueprintOutputSchema.parse({
    completed: nextIndex >= plan.totalCells,
    startIndex,
    nextIndex,
    totalCells: plan.totalCells,
    placements,
    estimatedDurationMs: placements.length * BLUEPRINT_DESIGN_PLACEMENT_MS,
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
        return hasMaterials(input, ordered.slice(startIndex, startIndex + maxPlacements));
      },
    },
    {
      id: "blueprint.any-cell-in-reach",
      failureCode: "BUILD_CELL_UNREACHABLE",
      check: (input, state, policy) => {
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

