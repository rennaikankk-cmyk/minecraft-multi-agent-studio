import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { identifierSchema } from "@minecraft-studio/protocol";
import { BaseRegistry, FacilityRegistry, workPositionSchema, workScopeSchema, withinWorkArea,
  farmMaintainInputSchema, registerCropProduction, registerFoodProduction, farmSustainInputSchema, foodFarmLayout } from "@minecraft-studio/skills";

export const operatorBaseAssignmentsSchema = z.object({
  schemaVersion: z.literal("1.0"),
  assignments: z.array(workScopeSchema.extend({
    name: z.string().trim().min(1).max(80),
    anchor: workPositionSchema,
    bounds: z.object({ min: workPositionSchema, max: workPositionSchema }).strict(),
    memberBotIds: z.array(identifierSchema).min(1).max(32),
    farms: z.array(z.object({
      min: workPositionSchema, max: workPositionSchema,
      crop: z.enum(["carrots", "potatoes", "wheat", "beetroots"]),
    }).strict()).max(8).default([]),
    foodGardens: z.array(z.object({ center: farmSustainInputSchema.shape.center, waterSource: farmSustainInputSchema.shape.waterSource,
      seedReserve: farmSustainInputSchema.shape.seedReserve, foodReserve: farmSustainInputSchema.shape.foodReserve,
      maxActions: farmSustainInputSchema.shape.maxActions }).strict()).max(8).default([]),
  }).strict().superRefine((a, ctx) => {
    if (["x", "y", "z"].some((axis) => {
      const key = axis as "x" | "y" | "z";
      return a.bounds.min[key] > a.bounds.max[key] || a.bounds.max[key] - a.bounds.min[key] > 512;
    }) || !withinWorkArea({ ...a, ...a.bounds }, a.anchor)) {
      ctx.addIssue({ code: "custom", message: "Base bounds must contain the anchor and span at most 512 blocks per axis." });
    }
    for (const farm of a.farms) {
      if (!withinWorkArea({ ...a, ...a.bounds }, farm.min) || !withinWorkArea({ ...a, ...a.bounds }, farm.max)) {
        ctx.addIssue({ code: "custom", message: "Farm must remain inside the adopted base." });
      }
    }
    for (const garden of a.foodGardens) {
      const layout = foodFarmLayout(garden.center);
      if (!withinWorkArea({ ...a, ...a.bounds }, layout.min) || !withinWorkArea({ ...a, ...a.bounds }, layout.max)) {
        ctx.addIssue({ code: "custom", message: "Food garden infrastructure must remain inside the adopted base." });
      }
    }
  })).max(32),
}).strict();

/** Operator configuration grants membership/work areas, never combat identity or structure readiness. */
export function applyOperatorBaseAssignments(raw: unknown, bases: BaseRegistry, facilities: FacilityRegistry): number {
  const config = operatorBaseAssignmentsSchema.parse(raw);
  const draftBases = BaseRegistry.restore(structuredClone(bases.serialize()));
  const draftFacilities = FacilityRegistry.restore(structuredClone(facilities.serialize()));
  const assigned = new Set<string>();
  for (const assignment of config.assignments) {
    for (const botId of assignment.memberBotIds) {
      const key = JSON.stringify([assignment.serverProfileId, assignment.dimension, botId]);
      if (assigned.has(key)) throw new Error("BASE_ASSIGNMENT_DUPLICATE");
      assigned.add(key);
    }
    const base = draftBases.create({ ...assignment, blueprintId: "operator-adopted" });
    if (base.status === "abandoned") throw new Error("BASE_ASSIGNMENT_ABANDONED");
    base.source = "operator_adopted";
    const previous = base.protectedBounds;
    base.protectedBounds = previous ? {
      min: { x: Math.min(previous.min.x, assignment.bounds.min.x), y: Math.min(previous.min.y, assignment.bounds.min.y), z: Math.min(previous.min.z, assignment.bounds.min.z) },
      max: { x: Math.max(previous.max.x, assignment.bounds.max.x), y: Math.max(previous.max.y, assignment.bounds.max.y), z: Math.max(previous.max.z, assignment.bounds.max.z) },
    } : assignment.bounds;
    for (const botId of assignment.memberBotIds) draftBases.assignMember(base.id, base.serverProfileId, base.dimension, botId);
    draftBases.recordPhaseEvidence(base.id, "BASE_SITE_RESERVED", "AVAILABLE", "operator-assigned existing base", "operator-config");
    for (const farm of assignment.farms) registerCropProduction(draftFacilities, base.id, farmMaintainInputSchema.parse({
      area: { serverProfileId: base.serverProfileId, dimension: base.dimension, min: farm.min, max: farm.max },
      crops: [farm.crop], plantEmpty: farm.crop, prepareSoil: true, maxActions: 32,
    }));
    for (const garden of assignment.foodGardens) registerFoodProduction(draftFacilities, base.id,
      farmSustainInputSchema.parse({ ...garden, serverProfileId: base.serverProfileId, dimension: base.dimension }));
  }
  bases.absorb(draftBases);
  facilities.absorb(draftFacilities);
  return config.assignments.length;
}

export function loadOperatorBaseAssignments(path: string, bases: BaseRegistry, facilities: FacilityRegistry): number {
  if (statSync(path).size > 131_072) throw new Error("BASE_ASSIGNMENTS_TOO_LARGE");
  return applyOperatorBaseAssignments(JSON.parse(readFileSync(path, "utf8")), bases, facilities);
}
