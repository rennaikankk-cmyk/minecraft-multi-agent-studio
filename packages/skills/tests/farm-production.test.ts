import { describe, expect, it } from "vitest";
import { FacilityRegistry } from "../src/facility-registry.js";
import { farmMaintainInputSchema } from "../src/farm-maintenance.js";
import { farmProductionReady, readFarmProduction, recordFarmProduction, registerCropProduction, registerFoodProduction } from "../src/farm-production.js";
import { farmSustainInputSchema } from "../src/farm-sustain.js";

const now = Date.parse("2026-09-06T00:00:00Z");
const input = farmMaintainInputSchema.parse({ area: { serverProfileId: "isolated", dimension: "minecraft:overworld",
  min: { x: 0, y: 63, z: 0 }, max: { x: 2, y: 64, z: 2 } }, crops: ["carrots"], plantEmpty: "carrots", prepareSoil: true });
const receipt = { status: "BATCH_LIMIT", scannedCells: 4, unknownCells: 0, harvested: 2, planted: 2, tilled: 0, bonemealUsed: 0,
  inventoryDelta: [{ itemName: "carrot", delta: 3 }], observedAt: new Date(now).toISOString() };

describe("persistent crop production", () => {
  const garden = () => registerFoodProduction(new FacilityRegistry(), "base", farmSustainInputSchema.parse({
    serverProfileId: "isolated", dimension: "minecraft:overworld", center: { x: 0, y: 64, z: 0 } }));
  const productive = (atMs: number, before: number, harvested = 2) => ({
    status: "WAITING_GROWTH", reason: null, observedAt: new Date(atMs).toISOString(),
    maintenance: { ...receipt, status: "WAITING_GROWTH", observedAt: new Date(atMs).toISOString(), harvested,
      inventoryDelta: harvested ? [{ itemName: "carrot", delta: 3 }] : [] },
    supply: { waterReady: true, lightingReady: true, enclosureReady: true, hydratedPlots: 24, plantedPlots: 24, repairs: 0,
      seedReserved: 8, foodReserved: 8, inventoryFood: 16, deposited: harvested ? 3 : 0, withdrawn: 0,
      storageBefore: before, storageAfter: before + (harvested ? 3 : 0) },
  });
  it("requires spaced productive cycles, preserves them across growth polls, and expires evidence", () => {
    const f = garden();
    recordFarmProduction(f, "first", productive(now, 32), now);
    for (let i = 1; i <= 12; i++) recordFarmProduction(f, `poll-${i}`, productive(now + i * 30_000, 35, 0), now + i * 30_000);
    expect(farmProductionReady(readFarmProduction(f)!, now + 360_000)).toBe(false);
    recordFarmProduction(f, "second", productive(now + 390_000, 35), now + 390_000);
    recordFarmProduction(f, "third", productive(now + 420_000, 38), now + 420_000);
    expect(farmProductionReady(readFarmProduction(f)!, now + 420_000)).toBe(true);
    expect(farmProductionReady(readFarmProduction(f)!, now + 541_000)).toBe(false);
    recordFarmProduction(f, "failure", null, now + 430_000, "SKILL_CANCELLED");
    expect(farmProductionReady(readFarmProduction(f)!, now + 430_000)).toBe(false);
  });
  it("invalidates inconsistent balances and cannot use a legacy receipt as supply evidence", () => {
    const f = garden();
    const bad = productive(now, 32); bad.supply.storageAfter = 90;
    recordFarmProduction(f, "bad", bad, now);
    expect(readFarmProduction(f)).toMatchObject({ status: "BLOCKED", reason: "FARM_RECEIPT_INVALID", supplySamples: [] });
    recordFarmProduction(f, "legacy", receipt, now);
    expect(readFarmProduction(f)?.status).toBe("BLOCKED");
  });
  it("resumes a registered farm after restoration, without inventing production", () => {
    const registry = new FacilityRegistry();
    const facility = registerCropProduction(registry, "base", input);
    expect(readFarmProduction(facility)?.status).toBe("UNVERIFIED");
    recordFarmProduction(facility, "task-1", receipt, now);
    const restored = FacilityRegistry.restore(registry.serialize());
    expect(readFarmProduction(restored.get(facility.id)!)?.nextRunAtMs).toBe(now + 2_000);
    recordFarmProduction(facility, "task-1", receipt, now);
    expect(readFarmProduction(facility)?.samples).toHaveLength(1);
  });
  it("backs off waiting and failure states without counting planting as food", () => {
    const f = registerCropProduction(new FacilityRegistry(), "base", input);
    recordFarmProduction(f, "wait", { ...receipt, status: "WAITING_GROWTH", harvested: 0 }, now);
    expect(readFarmProduction(f)).toMatchObject({ status: "WAITING_GROWTH", samples: [], nextRunAtMs: now + 30_000 });
    recordFarmProduction(f, "failure", null, now, "FARM_HOE_REQUIRED");
    expect(readFarmProduction(f)).toMatchObject({ status: "BLOCKED", reason: "FARM_HOE_REQUIRED", nextRunAtMs: now + 60_000 });
  });
  it("rejects stale receipts and conflicting base ownership", () => {
    const registry = new FacilityRegistry();
    const f = registerCropProduction(registry, "base", input);
    expect(() => registerCropProduction(registry, "other-base", input)).toThrow("FARM_BASE_SCOPE_MISMATCH");
    recordFarmProduction(f, "old", receipt, now + 300_000);
    expect(readFarmProduction(f)?.status).toBe("BLOCKED");
    expect(readFarmProduction(f)?.samples).toEqual([]);
  });
});
