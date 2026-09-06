import { z } from "zod";
import { farmMaintainInputSchema, farmMaintainOutputSchema, type FarmMaintainInput } from "./farm-maintenance.js";
import { farmSustainInputSchema, farmSustainOutputSchema, foodFarmMaintenance, type FarmSustainInput } from "./farm-sustain.js";
import { SAFE_FOOD_ITEMS } from "./bot-state-catalog.js";
import type { Facility, FacilityRegistry } from "./facility-registry.js";

export const farmProductionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  input: farmMaintainInputSchema,
  sustain: farmSustainInputSchema.nullable().default(null),
  enabled: z.boolean(),
  nextRunAtMs: z.number().nonnegative(),
  lastTaskId: z.string().nullable(),
  lastObservedAt: z.string().datetime().nullable(),
  status: z.enum(["UNVERIFIED", "PRODUCING", "WAITING_GROWTH", "WAITING_SEEDS", "WAITING_OBSERVATION", "BLOCKED"]),
  reason: z.string().max(128).nullable(),
  samples: z.array(z.object({ atMs: z.number().nonnegative(), netFood: z.number().int().positive() }).strict()).max(16),
  supply: farmSustainOutputSchema.shape.supply.nullable().default(null),
  supplySamples: z.array(z.object({ atMs: z.number().nonnegative(), stock: z.number().int().nonnegative(),
    harvested: z.number().int().nonnegative(), netFood: z.number().int(), deposited: z.number().int().nonnegative(),
    consumedFood: z.number().int().nonnegative().default(0) }).strict()).max(32).default([]),
  cycles: z.number().int().nonnegative().default(0),
  lastNetFood: z.number().int().default(0),
  lastDeposited: z.number().int().nonnegative().default(0),
  recentTaskIds: z.array(z.string()).max(32).default([]),
}).strict();
export type FarmProduction = z.infer<typeof farmProductionSchema>;

export type FoodDemandSample = Readonly<{
  atMs: number;
  harvested: number;
  deposited: number;
  consumedFood: number;
}>;

/**
 * Evaluate food self-sufficiency over observed activity. Consumption is
 * supplied by Runtime telemetry (eating events and inventory deltas), never
 * inferred from harvest alone. A missing/short window is explicitly
 * unproven so a busy Bot cannot mark a farm healthy on one large harvest.
 */
export function foodDemandCoverage(
  samples: readonly FoodDemandSample[],
  nowMs: number,
  minimumWindowMs = 300_000,
): Readonly<{ covered: boolean; observedWindowMs: number; produced: number; consumed: number; surplus: number }> {
  const ordered = [...samples].filter((sample) => Number.isFinite(sample.atMs)).sort((a, b) => a.atMs - b.atMs);
  if (ordered.length === 0) return { covered: false, observedWindowMs: 0, produced: 0, consumed: 0, surplus: 0 };
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const observedWindowMs = Math.max(0, Math.min(nowMs, last.atMs) - first.atMs);
  const produced = ordered.reduce((sum, sample) => sum + Math.max(0, sample.deposited), 0);
  const consumed = ordered.reduce((sum, sample) => sum + Math.max(0, sample.consumedFood), 0);
  return { covered: observedWindowMs >= minimumWindowMs && produced > 0 && produced >= consumed, observedWindowMs, produced, consumed, surplus: produced - consumed };
}

/** Attach an authoritative eating delta to the matching production window. */
export function recordFoodConsumption(facility: Facility, consumedFood: number, atMs: number): boolean {
  const current = readFarmProduction(facility);
  if (!current || !Number.isSafeInteger(consumedFood) || consumedFood < 0 || !Number.isSafeInteger(atMs) || atMs < 0) return false;
  const samples = current.supplySamples;
  const index = samples.findIndex((sample) => sample.atMs === atMs);
  if (index < 0) return false;
  const nextSamples = samples.map((sample, i) => i === index ? { ...sample, consumedFood: consumedFood } : sample);
  facility.metadata.production = farmProductionSchema.parse({ ...current, supplySamples: nextSamples });
  return true;
}

export function readFarmProduction(facility: Facility): FarmProduction | null {
  const result = farmProductionSchema.safeParse(facility.metadata.production);
  if (!result.success || facility.facilityType !== "crop_farm" ||
    result.data.input.area.serverProfileId !== facility.serverProfileId ||
    result.data.input.area.dimension !== facility.dimension) return null;
  if (result.data.sustain && (result.data.sustain.serverProfileId !== facility.serverProfileId ||
    result.data.sustain.dimension !== facility.dimension ||
    JSON.stringify(foodFarmMaintenance(result.data.sustain).area) !== JSON.stringify(result.data.input.area))) return null;
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

export function registerFoodProduction(registry: FacilityRegistry, baseId: string, raw: FarmSustainInput): Facility {
  const sustain = farmSustainInputSchema.parse(raw);
  const facility = registerCropProduction(registry, baseId, foodFarmMaintenance(sustain));
  const production = readFarmProduction(facility)!;
  if (production.sustain && JSON.stringify(production.sustain) !== JSON.stringify(sustain)) throw new Error("FARM_CONFIGURATION_CONFLICT");
  facility.metadata.production = { ...production, sustain };
  return facility;
}

export function recordFarmProduction(facility: Facility, taskId: string, output: unknown, nowMs: number, errorCode?: string): void {
  const current = readFarmProduction(facility);
  if (!current || current.lastTaskId === taskId || current.recentTaskIds.includes(taskId)) return;
  const maintained = farmMaintainOutputSchema.safeParse(output);
  const sustained = farmSustainOutputSchema.safeParse(output);
  const supply = sustained.success ? sustained.data.supply : null;
  const invalidSupply = supply && (supply.seedReserved + supply.foodReserved > supply.inventoryFood ||
    (supply.storageBefore !== null && supply.storageAfter !== null && supply.storageAfter !== supply.storageBefore + supply.deposited - supply.withdrawn) ||
    (supply.storageBefore === null || supply.storageAfter === null) && (supply.deposited > 0 || supply.withdrawn > 0));
  const observedAt = current.sustain ? sustained.success ? sustained.data.observedAt : null : maintained.success ? maintained.data.observedAt : null;
  const next: FarmProduction = { ...current, lastTaskId: taskId, recentTaskIds: [...current.recentTaskIds, taskId].slice(-32), nextRunAtMs: nowMs + 30_000 };
  if (errorCode || invalidSupply || !observedAt || Date.parse(observedAt) > nowMs + 5_000 || Date.parse(observedAt) < nowMs - 120_000 ||
    (current.lastObservedAt && Date.parse(observedAt) <= Date.parse(current.lastObservedAt))) {
    next.status = "BLOCKED"; next.reason = errorCode ?? "FARM_RECEIPT_INVALID"; next.nextRunAtMs = nowMs + 60_000;
    next.supply = null; next.supplySamples = [];
  } else {
    const result = current.sustain && sustained.success ? sustained.data.maintenance : maintained.success ? maintained.data : null;
    const status = current.sustain && sustained.success ? sustained.data.status : result?.status;
    const netFood = result?.harvested ? result.inventoryDelta.filter((item) => SAFE_FOOD_ITEMS.has(item.itemName)).reduce((sum, item) => sum + item.delta, 0) : 0;
    next.cycles++; next.lastNetFood = netFood; next.lastObservedAt = observedAt;
    next.samples = current.samples.filter((sample) => sample.atMs >= nowMs - 3_600_000);
    if (netFood > 0) next.samples = [...next.samples, { atMs: nowMs, netFood }].slice(-16);
    next.status = status === "WAITING_SEEDS" || status === "WAITING_OBSERVATION" || status === "WAITING_GROWTH" ? status : netFood > 0 ? "PRODUCING" : "UNVERIFIED";
    next.reason = current.sustain && sustained.success ? sustained.data.reason : status === "PASS_COMPLETE" && result && result.harvested + result.planted + result.tilled === 0 ? "FARM_NO_PRODUCTIVE_CROPS" : null;
    if (status === "BATCH_LIMIT") next.nextRunAtMs = nowMs + 2_000;
    if (status === "WAITING_INFRASTRUCTURE" || status === "STORAGE_FULL") { next.status = "BLOCKED"; next.nextRunAtMs = nowMs + 60_000; }
    if (current.sustain && sustained.success) {
      const supply = sustained.data.supply;
      next.supply = supply; next.lastDeposited = supply.deposited;
      const ready = supply.waterReady && supply.lightingReady && supply.enclosureReady && supply.hydratedPlots === 24 &&
        supply.plantedPlots === 24 && supply.seedReserved >= current.sustain.seedReserve && supply.foodReserved >= current.sustain.foodReserve &&
        supply.storageAfter !== null && !["BLOCKED", "WAITING_OBSERVATION", "WAITING_SEEDS"].includes(next.status);
      next.supplySamples = ready ? [...current.supplySamples.filter((s) => s.atMs >= nowMs - 3_600_000 && s.harvested > 0), {
        atMs: Date.parse(observedAt), stock: supply.storageAfter! + supply.inventoryFood,
        harvested: result?.harvested ?? 0, netFood, deposited: supply.deposited,
        consumedFood: 0,
      }].slice(-32) : [];
    }
  }
  facility.metadata.production = farmProductionSchema.parse(next);
  facility.lastObservedAt = new Date(nowMs).toISOString();
}

/** A bounded evidence window, not a promise of unlimited production. */
export function farmProductionReady(production: FarmProduction, nowMs: number): boolean {
  if (!production.sustain || !production.lastObservedAt || production.status === "BLOCKED" || nowMs - Date.parse(production.lastObservedAt) > 120_000 || nowMs < Date.parse(production.lastObservedAt)) return false;
  const samples = production.supplySamples;
  const harvests = samples.filter((s) => s.harvested > 0 && s.netFood > 0 && s.deposited > 0);
  if (harvests.length < 3 || samples.length < 3) return false;
  const first = harvests[0]!, last = samples[samples.length - 1]!;
  return harvests[harvests.length - 1]!.atMs - first.atMs >= 300_000 && last.stock >= first.stock &&
    last.stock >= production.sustain.seedReserve + production.sustain.foodReserve * 2;
}
