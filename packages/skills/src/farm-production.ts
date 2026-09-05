import { z } from "zod";
import { farmMaintainInputSchema, farmMaintainOutputSchema, type FarmMaintainInput } from "./farm-maintenance.js";
import { SAFE_FOOD_ITEMS } from "./bot-state-catalog.js";
import type { Facility, FacilityRegistry } from "./facility-registry.js";

export const farmProductionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  input: farmMaintainInputSchema,
  enabled: z.boolean(),
  nextRunAtMs: z.number().nonnegative(),
  lastTaskId: z.string().nullable(),
  lastObservedAt: z.string().datetime().nullable(),
  status: z.enum(["UNVERIFIED", "PRODUCING", "WAITING_GROWTH", "WAITING_SEEDS", "WAITING_OBSERVATION", "BLOCKED"]),
  reason: z.string().max(128).nullable(),
  samples: z.array(z.object({ atMs: z.number().nonnegative(), netFood: z.number().int().positive() }).strict()).max(16),
}).strict();
export type FarmProduction = z.infer<typeof farmProductionSchema>;

export function readFarmProduction(facility: Facility): FarmProduction | null {
  const result = farmProductionSchema.safeParse(facility.metadata.production);
  if (!result.success || facility.facilityType !== "crop_farm" ||
    result.data.input.area.serverProfileId !== facility.serverProfileId ||
    result.data.input.area.dimension !== facility.dimension) return null;
  return result.data;
}

export function registerCropProduction(registry: FacilityRegistry, baseId: string, raw: FarmMaintainInput): Facility {
  const input = farmMaintainInputSchema.parse(raw);
  const facility = registry.create({ facilityType: "crop_farm", baseId, serverProfileId: input.area.serverProfileId,
    dimension: input.area.dimension, anchor: input.area.min, orientation: "north", layoutVersion: "crop-production-v1", patternSlots: [] });
  if (facility.baseId !== baseId) throw new Error("FARM_BASE_SCOPE_MISMATCH");
  const existing = readFarmProduction(facility);
  if (existing && JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error("FARM_CONFIGURATION_CONFLICT");
  if (!existing) facility.metadata.production = farmProductionSchema.parse({ schemaVersion: "1.0", input,
    enabled: true, nextRunAtMs: 0, lastTaskId: null, lastObservedAt: null, status: "UNVERIFIED", reason: null, samples: [] });
  return facility;
}

export function recordFarmProduction(facility: Facility, taskId: string, output: unknown, nowMs: number, errorCode?: string): void {
  const current = readFarmProduction(facility);
  if (!current || current.lastTaskId === taskId) return;
  const parsed = farmMaintainOutputSchema.safeParse(output);
  const next = { ...current, lastTaskId: taskId, nextRunAtMs: nowMs + 30_000 };
  if (errorCode || !parsed.success || Date.parse(parsed.data.observedAt) > nowMs + 5_000 || Date.parse(parsed.data.observedAt) < nowMs - 120_000) {
    next.status = "BLOCKED";
    next.reason = errorCode ?? "FARM_RECEIPT_INVALID";
    next.nextRunAtMs = nowMs + 60_000;
  } else {
    const result = parsed.data;
    next.lastObservedAt = result.observedAt;
    const netFood = result.harvested > 0 ? result.inventoryDelta.filter((item) => SAFE_FOOD_ITEMS.has(item.itemName))
      .reduce((sum, item) => sum + item.delta, 0) : 0;
    next.samples = current.samples.filter((sample) => sample.atMs >= nowMs - 3_600_000);
    if (netFood > 0) next.samples = [...next.samples, { atMs: nowMs, netFood }].slice(-16);
    next.status = result.status === "WAITING_SEEDS" || result.status === "WAITING_OBSERVATION" || result.status === "WAITING_GROWTH"
      ? result.status : netFood > 0 ? "PRODUCING" : "UNVERIFIED";
    next.reason = result.status === "PASS_COMPLETE" && result.harvested + result.planted + result.tilled === 0 ? "FARM_NO_PRODUCTIVE_CROPS" : null;
    if (result.status === "BATCH_LIMIT") next.nextRunAtMs = nowMs + 1_000;
  }
  facility.metadata.production = farmProductionSchema.parse(next);
  facility.lastObservedAt = new Date(nowMs).toISOString();
}
