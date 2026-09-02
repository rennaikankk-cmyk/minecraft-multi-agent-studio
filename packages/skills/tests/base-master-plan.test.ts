// Base Master Plan 测试：依赖拓扑、hard 依赖检查、循环检测。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FACILITY_DEPENDENCIES,
  detectDependencyCycle,
  facilityBuildOrder,
  missingHardDependencies,
} from "../src/base-master-plan.js";
import type { AutomatedFacilityKind } from "../src/facility-platform.js";

describe("DEFAULT_FACILITY_DEPENDENCIES", () => {
  it("每种 kind 都有条目（空数组也行）", () => {
    const kinds = [
      "crop_farm", "villager_crop_farm", "cobblestone_generator",
      "stone_processing", "bamboo_farm", "sugar_cane_farm",
      "iron_farm", "gunpowder_farm", "mob_drop_farm",
      "storage_system", "smelting_array",
    ];
    for (const kind of kinds) {
      expect(DEFAULT_FACILITY_DEPENDENCIES[kind as AutomatedFacilityKind]).toBeDefined();
    }
  });

  it("刷铁机有 3 个 hard 依赖", () => {
    const deps = DEFAULT_FACILITY_DEPENDENCIES.iron_farm;
    expect(deps.filter((d) => d.strength === "hard")).toHaveLength(3);
  });
});

describe("facilityBuildOrder", () => {
  it("拓扑排序：storage 在 iron_farm 之前", () => {
    const order = facilityBuildOrder(["iron_farm", "crop_farm", "storage_system", "cobblestone_generator"]);
    const storageIdx = order.indexOf("storage_system");
    const cropIdx = order.indexOf("crop_farm");
    const cobbleIdx = order.indexOf("cobblestone_generator");
    const ironIdx = order.indexOf("iron_farm");
    expect(storageIdx).toBeLessThan(ironIdx);
    expect(cropIdx).toBeLessThan(ironIdx);
    expect(cobbleIdx).toBeLessThan(ironIdx);
  });

  it("火药塔在铁机之后", () => {
    const order = facilityBuildOrder(["gunpowder_farm", "iron_farm", "crop_farm", "storage_system", "cobblestone_generator"]);
    expect(order.indexOf("iron_farm")).toBeLessThan(order.indexOf("gunpowder_farm"));
  });

  it("空列表返回空", () => {
    expect(facilityBuildOrder([])).toEqual([]);
  });
});

describe("missingHardDependencies", () => {
  it("无前置时返回空", () => {
    const ops = new Set<AutomatedFacilityKind>(["storage_system", "crop_farm", "cobblestone_generator"]);
    expect(missingHardDependencies("iron_farm", ops)).toEqual([]);
  });

  it("缺 storage/crop/cobble 时返回 3 条", () => {
    expect(missingHardDependencies("iron_farm", new Set())).toHaveLength(3);
  });

  it("cobblestone_generator 无 hard 依赖", () => {
    expect(missingHardDependencies("cobblestone_generator", new Set())).toEqual([]);
  });
});

describe("detectDependencyCycle", () => {
  it("默认依赖无循环", () => {
    const kinds: AutomatedFacilityKind[] = [
      "crop_farm", "cobblestone_generator", "stone_processing",
      "smelting_array", "storage_system", "iron_farm", "gunpowder_farm",
    ];
    expect(detectDependencyCycle(kinds)).toEqual([]);
  });
});
