import { describe, expect, it } from "vitest";
import {
  FacilityRegistry,
  canTransitionFacilityOperationalState,
  readFacilityProductionLedger,
  recordFacilityProduction,
  transitionFacilityOperationalState,
} from "../src/index.js";

describe("facility operational lifecycle", () => {
  it("keeps commissioning separate from active production", () => {
    const registry = new FacilityRegistry({ now: () => 1_000 });
    const facility = registry.create({
      facilityType: "iron_farm",
      baseId: "base-1",
      serverProfileId: "isolated",
      dimension: "minecraft:overworld",
      anchor: { x: 0, y: 64, z: 0 },
      orientation: "north",
      layoutVersion: "iron-v1",
      patternSlots: [],
    });
    expect(readFacilityProductionLedger(facility).state).toBe("PLANNED");
    transitionFacilityOperationalState(facility, "BUILDING", 1_000, "materials-ready");
    transitionFacilityOperationalState(facility, "COMMISSIONING", 2_000, "blocks-verified");
    expect(readFacilityProductionLedger(facility).state).toBe("COMMISSIONING");
    expect(() => transitionFacilityOperationalState(facility, "ACTIVE", 3_000, "no-output-test" )).not.toThrow();
    expect(readFacilityProductionLedger(facility).state).toBe("ACTIVE");
  });

  it("rejects invalid transitions and keeps production accounting explicit", () => {
    expect(canTransitionFacilityOperationalState("PLANNED", "ACTIVE")).toBe(false);
    const registry = new FacilityRegistry({ now: () => 1_000 });
    const facility = registry.create({
      facilityType: "mob_farm", baseId: null, serverProfileId: "isolated", dimension: "minecraft:overworld",
      anchor: { x: 0, y: 64, z: 0 }, orientation: "north", layoutVersion: "mob-v1", patternSlots: [],
    });
    expect(() => transitionFacilityOperationalState(facility, "ACTIVE", 1_000)).toThrow("FACILITY_INVALID_OPERATIONAL_TRANSITION");
    recordFacilityProduction(facility, "gunpowder", 3, 2_000, "produced");
    recordFacilityProduction(facility, "gunpowder", 1, 2_100, "consumed");
    expect(readFacilityProductionLedger(facility)).toMatchObject({ produced: { gunpowder: 3 }, consumed: { gunpowder: 1 } });
  });
});
