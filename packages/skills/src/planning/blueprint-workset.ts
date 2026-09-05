import { z } from "zod";
import { reconcileBlueprint, resolveMaterials } from "../base-registry.js";
import { SkillFault } from "../errors.js";
import { blueprintClassRank, orderBlueprintCells, type BuildBlueprintInput } from "./blueprint-planner.js";

const position = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict();
const face = position.refine((v) => Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z) === 1);
const material = z.object({ itemName: z.string().min(1).max(64), count: z.number().int().nonnegative() }).strict();

export const blueprintWorksetObservationSchema = z.object({
  snapshotId: z.uuid(), observedAt: z.iso.datetime(),
  playerPosition: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict().nullable(),
  cells: z.array(z.object({
    state: z.enum(["match", "different", "unknown"]),
    observedItemName: z.string().min(1).max(64).nullable(),
    workfaces: z.array(z.object({ referenceBlock: position, face }).strict()).max(6),
    supportUnknown: z.boolean(), reachable: z.boolean(),
  }).strict()).min(1).max(512),
  availableMaterials: z.array(material).max(256),
}).strict();
export type BlueprintWorksetObservation = z.infer<typeof blueprintWorksetObservationSchema>;

export const blueprintWorksetSummarySchema = z.object({
  snapshotId: z.uuid(),
  status: z.enum(["READY", "COMPLETE", "BATCH_LIMIT", "WAITING_MATERIAL", "WAITING_OBSERVATION",
    "WAITING_SUPPORT", "WAITING_REACH", "WAITING_PROPERTIES"]),
  remainingCells: z.number().int().min(0).max(512),
  missingMaterials: z.array(material).max(256),
}).strict();

/** Select one observed, supplied workface in the earliest unfinished structural class. */
export function selectBlueprintWorkset(input: BuildBlueprintInput, observation: BlueprintWorksetObservation) {
  const blueprint = input.blueprint;
  const ordered = orderBlueprintCells(blueprint);
  const key = (p: { x: number; y: number; z: number }) => JSON.stringify(p);
  const offsets = new Map(ordered.map((cell, index) => [key(cell.offset), index]));
  if (offsets.size !== ordered.length || observation.cells.length !== ordered.length) {
    throw new SkillFault("BLUEPRINT_WORKSET_INVALID");
  }
  const observations = new Map<string, string | null>();
  const propertyDifferences = new Set<string>();
  for (const [index, cell] of ordered.entries()) {
    const observed = observation.cells[index]!;
    if (observed.state === "unknown") continue;
    observations.set(key(cell.offset), observed.observedItemName);
    if (observed.state === "different" && observed.observedItemName === cell.itemName) propertyDifferences.add(key(cell.offset));
    if (observed.state === "match" && observed.observedItemName !== cell.itemName) throw new SkillFault("BLUEPRINT_WORKSET_INVALID");
  }
  const reconciled = reconcileBlueprint(blueprint, observations, propertyDifferences);
  const remainingCells = ordered.length - reconciled.placed.length;
  const summary = (status: z.infer<typeof blueprintWorksetSummarySchema>["status"], missingMaterials: z.infer<typeof material>[] = []) =>
    ({ snapshotId: observation.snapshotId, status, remainingCells, missingMaterials });
  if (remainingCells === 0) return { next: null, summary: summary("COMPLETE") };
  const rank = Math.min(...ordered.filter((_, index) => observation.cells[index]!.state !== "match").map(blueprintClassRank));
  const available = new Map(observation.availableMaterials.map((m) => [m.itemName, m.count]));
  if (input.availableMaterials?.length) {
    const budget = new Map(input.availableMaterials.map((m) => [m.itemName, m.count]));
    for (const [name, count] of available) available.set(name, Math.min(count, budget.get(name) ?? 0));
  }
  let unknown = false, unreachable = false, unsupported = false, properties = false;
  const suppliedFaces: Array<{ index: number; referenceBlock: z.infer<typeof position>; face: z.infer<typeof face> }> = [];
  for (const [index, cell] of ordered.entries()) {
    if (blueprintClassRank(cell) !== rank || observation.cells[index]!.state === "match") continue;
    const observed = observation.cells[index]!;
    if (observed.state === "unknown") { unknown = true; continue; }
    if (propertyDifferences.has(key(cell.offset))) { properties = true; continue; }
    if (!observed.reachable) { unreachable = true; continue; }
    const target = { x: blueprint.anchor.x + cell.offset.x, y: blueprint.anchor.y + cell.offset.y, z: blueprint.anchor.z + cell.offset.z };
    const workface = observed.workfaces.find(({ referenceBlock, face: normal }) => {
      if (referenceBlock.x + normal.x !== target.x || referenceBlock.y + normal.y !== target.y || referenceBlock.z + normal.z !== target.z) {
        throw new SkillFault("BLUEPRINT_WORKSET_INVALID");
      }
      const support = offsets.get(key({ x: referenceBlock.x - blueprint.anchor.x,
        y: referenceBlock.y - blueprint.anchor.y, z: referenceBlock.z - blueprint.anchor.z }));
      return support === undefined || observation.cells[support]!.state === "match";
    });
    if (!workface) { unknown ||= observed.supportUnknown; unsupported = true; continue; }
    suppliedFaces.push({ index, ...workface });
    if ((available.get(cell.itemName) ?? 0) > 0) return { next: { index, ...workface }, summary: summary("READY") };
  }
  const missingMaterials = suppliedFaces.length ? [...resolveMaterials({ ...blueprint,
    cells: suppliedFaces.slice(0, input.maxPlacements ?? 128).map(({ index }) => ordered[index]!),
  }, available)].map(([itemName, count]) => ({ itemName, count })) : [];
  return { next: null, summary: summary(unknown ? "WAITING_OBSERVATION" : missingMaterials.length ? "WAITING_MATERIAL"
    : properties ? "WAITING_PROPERTIES" : unsupported ? "WAITING_SUPPORT" : unreachable ? "WAITING_REACH" : "WAITING_SUPPORT", missingMaterials) };
}
