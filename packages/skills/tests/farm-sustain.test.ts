import { describe, expect, it } from "vitest";
import { farmSustainInputSchema, foodFarmLayout, foodFarmMaintenance, farmSustainSkill } from "../src/farm-sustain.js";

const scope = { serverProfileId: "isolated", dimension: "minecraft:overworld" };
describe("sustainable food garden contract", () => {
  it("derives a bounded irrigated garden and reserves seed inventory", () => {
    const input = farmSustainInputSchema.parse({ ...scope, center: { x: 0, y: 64, z: 0 } });
    const layout = foodFarmLayout(input.center);
    expect(layout.fences).toHaveLength(23);
    expect(foodFarmMaintenance(input).seedReserve).toBe(8);
    expect(layout.min.x).toBe(-4);
    expect(farmSustainSkill.preconditions.every((p) => p.failureCode.length > 0)).toBe(true);
  });
  it("rejects nether farms and out-of-area water sources", () => {
    expect(farmSustainInputSchema.safeParse({ ...scope, dimension: "minecraft:the_nether", center: { x: 0, y: 64, z: 0 } }).success).toBe(false);
    expect(farmSustainInputSchema.safeParse({ ...scope, center: { x: 0, y: 64, z: 0 }, waterSource: { x: 100, y: 64, z: 0 } }).success).toBe(false);
  });
});
