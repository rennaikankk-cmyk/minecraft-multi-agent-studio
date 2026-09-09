import { describe, expect, it } from "vitest";
import { BaseRegistry } from "@minecraft-studio/base-management";
import { ResourceLedger } from "@minecraft-studio/resource-management";
describe("domain compatibility barrel", () => {
  it("uses split authoritative registries", () => {
    const bases = new BaseRegistry();
    const base = bases.create({ name: "A", serverProfileId: "srv", worldId: "w", dimension: "minecraft:overworld", anchor: { x: 0, y: 64, z: 0 }, blueprintId: "bp" });
    expect(base.id).toContain("base-");
    const resources = new ResourceLedger();
    expect(resources.snapshot({ serverProfileId: "srv", worldId: "w", dimension: "minecraft:overworld" }).transfers).toEqual([]);
  });
});
