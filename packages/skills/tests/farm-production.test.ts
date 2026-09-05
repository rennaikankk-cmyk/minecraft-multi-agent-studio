import { describe, expect, it } from "vitest";
import { FacilityRegistry } from "../src/facility-registry.js";
import { farmMaintainInputSchema } from "../src/farm-maintenance.js";
import { readFarmProduction, recordFarmProduction, registerCropProduction } from "../src/farm-production.js";

const now = Date.parse("2026-09-06T00:00:00Z");
const input = farmMaintainInputSchema.parse({ area: { serverProfileId: "isolated", dimension: "minecraft:overworld",
  min: { x: 0, y: 63, z: 0 }, max: { x: 2, y: 64, z: 2 } }, crops: ["carrots"], plantEmpty: "carrots", prepareSoil: true });
const receipt = { status: "BATCH_LIMIT", scannedCells: 4, unknownCells: 0, harvested: 2, planted: 2, tilled: 0, bonemealUsed: 0,
  inventoryDelta: [{ itemName: "carrot", delta: 3 }], observedAt: new Date(now).toISOString() };

describe("persistent crop production", () => {
  it("resumes a registered farm after restoration, without inventing production", () => {
    const registry = new FacilityRegistry();
    const facility = registerCropProduction(registry, "base", input);
    expect(readFarmProduction(facility)?.status).toBe("UNVERIFIED");
    recordFarmProduction(facility, "task-1", receipt, now);
    const restored = FacilityRegistry.restore(registry.serialize());
    expect(readFarmProduction(restored.get(facility.id)!)?.nextRunAtMs).toBe(now + 1_000);
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
