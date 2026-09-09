import { z } from "zod";
import { automatedFacilityKindSchema } from "@minecraft-studio/asset-policy/facility-platform";
import { workScopeSchema, workPositionSchema, withinWorkArea, type WorkPosition } from "@minecraft-studio/asset-policy/work-area";

// Planning bounds are not executable work areas. Runtime batches retain their 4096-cell cap.
const planningAreaSchema = workScopeSchema.extend({ min: workPositionSchema, max: workPositionSchema }).strict()
  .refine((area) => (["x", "y", "z"] as const).every((axis) => area.min[axis] <= area.max[axis] && area.max[axis] - area.min[axis] <= 512), "BASE_LAYOUT_BOUNDS_INVALID");

const plotSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  kind: automatedFacilityKindSchema.nullable(),
  blueprintId: z.string().nullable(),
  stage: z.number().int().min(1).max(4),
  satellite: z.boolean(),
  area: planningAreaSchema,
  workAnchor: workPositionSchema,
}).strict();

export const baseLayoutSchema = z.object({
  schemaVersion: z.literal("1.0"),
  anchor: workPositionSchema,
  mainArea: planningAreaSchema,
  corridorWidth: z.literal(4),
  plots: z.array(plotSchema).min(1).max(24),
}).strict().superRefine((plan, ctx) => {
  const ids = new Set<string>();
  for (const [index, plot] of plan.plots.entries()) {
    if (ids.has(plot.id) || plot.area.serverProfileId !== plan.mainArea.serverProfileId || plot.area.dimension !== plan.mainArea.dimension ||
        !withinWorkArea(plot.area, plot.workAnchor) || !plot.satellite &&
        (!withinWorkArea(plan.mainArea, plot.area.min) || !withinWorkArea(plan.mainArea, plot.area.max))) {
      ctx.addIssue({ code: "custom", path: ["plots", index], message: "BASE_LAYOUT_SCOPE_INVALID" });
    }
    ids.add(plot.id);
    for (const other of plan.plots.slice(0, index)) {
      // Horizontal separation also protects circulation when facilities grow vertically.
      if (plot.area.min.x <= other.area.max.x && plot.area.max.x >= other.area.min.x &&
          plot.area.min.z <= other.area.max.z && plot.area.max.z >= other.area.min.z) {
        ctx.addIssue({ code: "custom", path: ["plots", index], message: "BASE_LAYOUT_PLOT_OVERLAP" });
      }
    }
  }
});
export type BaseLayout = z.infer<typeof baseLayoutSchema>;

/** Reservations describe intended use. Each plot still needs a live survey before building. */
export function planBaseLayout(scope: { serverProfileId: string; dimension: string; anchor: WorkPosition }): BaseLayout {
  const at = (x: number, y: number, z: number) => ({ x: scope.anchor.x + x, y: scope.anchor.y + y, z: scope.anchor.z + z });
  const area = (x1: number, z1: number, x2: number, z2: number, height = 16) => ({
    serverProfileId: scope.serverProfileId, dimension: scope.dimension, min: at(x1, -2, z1), max: at(x2, height, z2),
  });
  const plot = (id: string, kind: z.infer<typeof automatedFacilityKindSchema> | null, blueprintId: string | null,
    stage: number, x1: number, z1: number, x2: number, z2: number, x: number, z: number, satellite = false, height = 16) =>
    ({ id, kind, blueprintId, stage, satellite, area: area(x1, z1, x2, z2, height), workAnchor: at(x, 0, z) });
  return baseLayoutSchema.parse({ schemaVersion: "1.0", anchor: scope.anchor, mainArea: area(-48, -48, 47, 47, 32), corridorWidth: 4,
    plots: [
      plot("core-storage", "storage_system", "starter-base-v1", 1, -8, -8, 11, 11, 0, 0),
      plot("food", "crop_farm", "carrot-farm-9x9", 1, 16, -8, 35, 11, 24, 0),
      plot("smelting", "smelting_array", null, 2, -32, -8, -13, 11, -24, 0),
      plot("trading", "trading_hall", null, 2, -32, 16, -13, 39, -24, 24),
      plot("bot-quarters", null, null, 2, -8, 16, 11, 39, 0, 24),
      plot("materials", "cobblestone_generator", "cobble-generator", 2, 16, 16, 35, 39, 24, 24),
      plot("tree", "tree_farm", null, 2, 16, -40, 39, -13, 24, -24, false, 32),
      plot("expansion", null, null, 3, -40, -40, 11, -13, -24, -24, false, 32),
      // Distance is a conservative reservation, not proof of villager or spawning mechanics.
      plot("iron-satellite", "iron_farm", null, 3, 144, -16, 175, 15, 160, 0, true, 32),
      plot("mob-satellite", "mob_drop_farm", null, 4, -32, 224, 31, 287, 0, 256, true, 96),
    ] });
}

export function plannedBlueprintAnchor(plan: BaseLayout, blueprintId: string): WorkPosition | null {
  return plan.plots.find((plot) => plot.blueprintId === blueprintId)?.workAnchor ?? null;
}
