import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

export const workPositionSchema = z.object({
  x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-2_048).max(2_048),
  z: z.number().int().min(-30_000_000).max(30_000_000),
}).strict();
export type WorkPosition = z.infer<typeof workPositionSchema>;
export const workScopeSchema = z.object({
  serverProfileId: identifierSchema,
  dimension: z.string().min(3).max(128).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u),
}).strict();

export const MAX_WORK_AREA_VOLUME = 4_096;
export const workAreaSchema = workScopeSchema.extend({
  min: workPositionSchema,
  max: workPositionSchema,
}).strict().superRefine((area, context) => {
  if (["x", "y", "z"].some((axis) => area.min[axis as keyof WorkPosition] > area.max[axis as keyof WorkPosition])) {
    context.addIssue({ code: "custom", message: "Work area bounds are reversed." });
  }
  const volume = (area.max.x - area.min.x + 1) * (area.max.y - area.min.y + 1) * (area.max.z - area.min.z + 1);
  if (volume < 1 || volume > MAX_WORK_AREA_VOLUME) {
    context.addIssue({ code: "custom", message: "Work area exceeds the bounded observation budget." });
  }
});
export type WorkArea = z.infer<typeof workAreaSchema>;

export function withinWorkArea(area: WorkArea, position: WorkPosition): boolean {
  return position.x >= area.min.x && position.x <= area.max.x &&
    position.y >= area.min.y && position.y <= area.max.y &&
    position.z >= area.min.z && position.z <= area.max.z;
}

export function workAreaPositions(area: WorkArea, topDown = false): WorkPosition[] {
  workAreaSchema.parse(area);
  const positions: WorkPosition[] = [];
  for (let row = 0; row <= area.max.y - area.min.y; row++) {
    const y = topDown ? area.max.y - row : area.min.y + row;
    for (let z = area.min.z; z <= area.max.z; z++) {
      for (let x = area.min.x; x <= area.max.x; x++) positions.push({ x, y, z });
    }
  }
  return positions;
}

export function workPositionKey(position: WorkPosition): string {
  return `${position.x},${position.y},${position.z}`;
}
