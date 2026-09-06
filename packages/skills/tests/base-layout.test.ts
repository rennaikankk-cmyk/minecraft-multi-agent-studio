import { describe, expect, it } from "vitest";
import { baseLayoutSchema, planBaseLayout, plannedBlueprintAnchor } from "../src/base-layout.js";
import { BaseRegistry } from "../src/base-registry.js";
import { foodFarmLayout } from "../src/farm-sustain.js";
import { withinWorkArea } from "../src/work-area.js";

const scope = { serverProfileId: "isolated", dimension: "minecraft:overworld", anchor: { x: 12017, y: 64, z: -13461 } };

describe("base spatial layout", () => {
  it("fits food infrastructure and keeps trading away from satellite farms", () => {
    const plan = planBaseLayout(scope);
    const food = plan.plots.find((p) => p.id === "food")!;
    const farm = foodFarmLayout(food.workAnchor);
    expect(withinWorkArea(food.area, farm.min)).toBe(true);
    expect(withinWorkArea(food.area, farm.max)).toBe(true);
    const trading = plan.plots.find((p) => p.id === "trading")!;
    const iron = plan.plots.find((p) => p.id === "iron-satellite")!;
    expect(iron.area.min.x - trading.area.max.x).toBeGreaterThan(96);
    expect(plan.mainArea.max.x - plan.mainArea.min.x + 1).toBe(96);
    expect(plannedBlueprintAnchor(plan, "starter-base-v1")).toEqual(scope.anchor);
  });
  it("rejects overlap, scope corruption and world-border overflow", () => {
    const plan = planBaseLayout(scope);
    const overlap = structuredClone(plan);
    overlap.plots[1]!.area = overlap.plots[0]!.area;
    expect(baseLayoutSchema.safeParse(overlap).success).toBe(false);
    const wrong = structuredClone(plan);
    wrong.plots[0]!.area.serverProfileId = "other";
    expect(baseLayoutSchema.safeParse(wrong).success).toBe(false);
    expect(() => planBaseLayout({ ...scope, anchor: { x: 29_999_999, y: 64, z: 0 } })).toThrow();
  });
  it("preserves assigned anchors after restart without declaring facilities available", () => {
    const registry = new BaseRegistry();
    const base = registry.create({ ...scope, name: "test", blueprintId: "starter-base-v1", createdByBotId: "builder" });
    const before = registry.ensureLayout(base.id);
    const restored = BaseRegistry.restore(JSON.parse(JSON.stringify(registry.serialize())));
    expect(restored.ensureLayout(base.id)).toEqual(before);
    expect(restored.get(base.id)?.status).toBe("planned");
    expect(restored.get(base.id)?.phaseFacts).toEqual({});
    restored.get(base.id)!.source = "operator_adopted";
    expect(() => restored.ensureLayout(base.id)).toThrow("BASE_LAYOUT_NOT_AUTONOMOUS");
  });
});
