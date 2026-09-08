import { z } from 'zod';
import { identifierSchema } from '@minecraft-studio/protocol';
export const MAX_BLUEPRINT_CELLS = 512;
export const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);
export const itemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);
export const coordinateSchema = z
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
export const faceSchema = z
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
    blockProperties: z.array(z.object({ name: z.string().min(1).max(64), value: z.union([z.string(), z.number(), z.boolean()]) }).strict()).max(32).optional(),
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

export const CLASS_RANK: Readonly<Record<BlueprintBlockClass, number>> = Object.freeze({
  foundation: 0,
  "load-bearing": 1,
  structural: 1,
  structure: 1,
  utility: 2,
  shell: 3,
  decoration: 4,
});

export function blueprintClassRank(cell: BlueprintCell): number { return CLASS_RANK[cell.blockClass]; }


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
