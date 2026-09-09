import { describe, expect, it } from "vitest";
import { BaseRegistry } from '@minecraft-studio/base-management';
import { FacilityRegistry } from '@minecraft-studio/asset-policy';
import { applyOperatorBaseAssignments } from "../src/operator-base-assignments.js";

const assignment = { name: "Operator base", serverProfileId: "isolated", dimension: "minecraft:overworld",
  anchor: { x: 100, y: 64, z: 100 }, bounds: { min: { x: 95, y: 63, z: 95 }, max: { x: 105, y: 70, z: 105 } },
  memberBotIds: ["bot-1"], farms: [{ min: { x: 96, y: 63, z: 96 }, max: { x: 98, y: 64, z: 98 }, crop: "carrots" }] };
describe("operator base membership", () => {
  it("persists adoption, relocates membership and does not assert structure or food readiness", () => {
    const bases = new BaseRegistry();
    const facilities = new FacilityRegistry();
    bases.create({ ...assignment, anchor: { x: 0, y: 64, z: 0 }, blueprintId: "starter", createdByBotId: "bot-1" });
    applyOperatorBaseAssignments({ schemaVersion: "1.0", assignments: [assignment] }, bases, facilities);
    const base = bases.forMember("bot-1", "isolated", "minecraft:overworld")!;
    expect(base.source).toBe("operator_adopted");
    expect(base.anchor.x).toBe(100);
    expect(base.phaseFacts?.STARTER_BASE_ACTIVE).toBeUndefined();
    expect(base.phaseFacts?.FOOD_FACILITY_ACTIVE).toBeUndefined();
    expect(facilities.findByBase(base.id)).toHaveLength(1);
    applyOperatorBaseAssignments({ schemaVersion: "1.0", assignments: [assignment] }, bases, facilities);
    expect(facilities.findByBase(base.id)).toHaveLength(1);
  });
  it("rejects conflicting or out-of-base assignments atomically", () => {
    const bases = new BaseRegistry();
    const facilities = new FacilityRegistry();
    expect(() => applyOperatorBaseAssignments({ schemaVersion: "1.0", assignments: [assignment, assignment] }, bases, facilities)).toThrow("BASE_ASSIGNMENT_DUPLICATE");
    expect(bases.serialize().bases).toEqual([]);
    expect(() => applyOperatorBaseAssignments({ schemaVersion: "1.0", assignments: [{ ...assignment,
      farms: [{ ...assignment.farms[0], min: { x: 0, y: 64, z: 0 } }] }] }, bases, facilities)).toThrow();
    expect(facilities.size).toBe(0);
  });
  it("preserves existing protected structures when assignment bounds shrink", () => {
    const bases = new BaseRegistry();
    const facilities = new FacilityRegistry();
    applyOperatorBaseAssignments({ schemaVersion: "1.0", assignments: [assignment] }, bases, facilities);
    applyOperatorBaseAssignments({ schemaVersion: "1.0", assignments: [{ ...assignment,
      bounds: { min: { x: 99, y: 64, z: 99 }, max: { x: 101, y: 66, z: 101 } }, farms: [],
    }] }, bases, facilities);
    expect(bases.forMember("bot-1", "isolated", "minecraft:overworld")!.protectedBounds).toEqual(assignment.bounds);
  });
});
