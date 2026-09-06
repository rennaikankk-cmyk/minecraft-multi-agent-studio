import { describe, expect, it } from "vitest";
import { FacilityExecutor } from "../src/facility-executor.js";
import { FacilityRegistry } from "../src/facility-registry.js";

function makeRegistry() {
  const registry = new FacilityRegistry();
  const facility = registry.create({ facilityType: "iron_farm", serverProfileId: "server", dimension: "overworld", anchor: { x: 0, y: 64, z: 0 }, orientation: "north", layoutVersion: "1", patternSlots: [{ localOffset: { x: 0, y: 0, z: 0 }, workstationType: "chest" as never }] });
  return { registry, facility };
}

describe("FacilityExecutor", () => {
  it("requires server readback and drives the production ledger", async () => {
    const { registry, facility } = makeRegistry();
    const executor = new FacilityExecutor(registry, {
      invoke: async ({ phase }) => ({ ok: true, consumed: phase === "entities" ? { iron_ingot: 1 } : undefined }),
      readback: async () => ({ cells: [{ slotIndex: 0, blockPresent: true, blockName: "chest" }], output: { iron_ingot: 12 } }),
    });
    const result = await executor.run(facility.id);
    expect(result.ok).toBe(true);
    expect((facility.metadata.productionLedger as { state: string }).state).toBe("ACTIVE");
    expect((facility.metadata.productionLedger as { produced: Record<string, number> }).produced.iron_ingot).toBe(12);
  });

  it("marks blocked collectors degraded and can restart through repair", async () => {
    const { registry, facility } = makeRegistry();
    let blocked = true;
    const executor = new FacilityExecutor(registry, {
      invoke: async () => ({ ok: true }),
      readback: async () => ({ cells: [{ slotIndex: 0, blockPresent: true, blockName: "chest" }], collectorFull: blocked, output: blocked ? {} : { iron_ingot: 1 } }),
    });
    expect((await executor.run(facility.id)).ok).toBe(false);
    expect((facility.metadata.productionLedger as { state: string }).state).toBe("DEGRADED");
    blocked = false;
    expect((await executor.repair(facility.id)).ok).toBe(true);
    expect((facility.metadata.productionLedger as { state: string }).state).toBe("ACTIVE");
  });
});
