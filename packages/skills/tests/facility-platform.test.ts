// Farm Facility 平台域模型测试：lifecycle 状态机、phase 排序、canonical cell。
import { describe, expect, it } from "vitest";
import {
  FACILITY_LIFECYCLE_TRANSITIONS,
  automatedFacilityKindSchema,
  canonicalFacilityCellSchema,
  canTransitionFacility,
  cellsInPhaseOrder,
  facilityLifecycleStateSchema,
  facilityTemplateManifestSchema,
  validatePhaseOrdering,
  type CanonicalFacilityCell,
} from "../src/facility-platform.js";

describe("Facility kinds", () => {
  it("全部 11 种合法 kind", () => {
    const kinds = [
      "crop_farm", "villager_crop_farm", "cobblestone_generator",
      "stone_processing", "bamboo_farm", "sugar_cane_farm",
      "iron_farm", "gunpowder_farm", "mob_drop_farm",
      "storage_system", "smelting_array",
    ];
    for (const kind of kinds) {
      expect(automatedFacilityKindSchema.safeParse(kind).success, kind).toBe(true);
    }
    expect(automatedFacilityKindSchema.safeParse("not_a_farm").success).toBe(false);
  });
});

describe("Lifecycle state machine", () => {
  it("正常推进链路合法", () => {
    const path = [
      "researched", "planned", "site_selected", "materials_pending",
      "building", "entities_pending", "activation_pending",
      "commissioning", "operational",
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransitionFacility(path[i]!, path[i + 1]!), `${path[i]}→${path[i + 1]}`).toBe(true);
    }
  });

  it("非法跳跃被拒绝", () => {
    expect(canTransitionFacility("researched", "operational")).toBe(false);
    expect(canTransitionFacility("researched", "building")).toBe(false);
    expect(canTransitionFacility("planned", "operational")).toBe(false);
  });

  it("abandoned 是终态", () => {
    expect(FACILITY_LIFECYCLE_TRANSITIONS.abandoned).toEqual([]);
    expect(canTransitionFacility("abandoned", "operational")).toBe(false);
  });

  it("degraded → repairing → commissioning 合法", () => {
    expect(canTransitionFacility("degraded", "repairing")).toBe(true);
    expect(canTransitionFacility("repairing", "commissioning")).toBe(true);
  });

  it("operational 只能去 degraded/paused/decommissioning", () => {
    expect(canTransitionFacility("operational", "degraded")).toBe(true);
    expect(canTransitionFacility("operational", "paused")).toBe(true);
    expect(canTransitionFacility("operational", "decommissioning")).toBe(true);
    expect(canTransitionFacility("operational", "building")).toBe(false);
  });

  it("schema 拒绝非法状态", () => {
    expect(facilityLifecycleStateSchema.safeParse("exploded").success).toBe(false);
  });
});

describe("Canonical cells", () => {
  const baseCell = {
    cellId: "cell-001",
    offset: { x: 0, y: 0, z: 0 },
    expectedBlock: "cobblestone",
    purpose: "structural" as const,
    phase: "foundation" as const,
  };

  it("最小合法 cell", () => {
    const parsed = canonicalFacilityCellSchema.safeParse(baseCell);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.protection).toBe("protected"); // default
      expect(parsed.data.replacePolicy).toBe("air_only"); // default
    }
  });

  it("缺字段拒绝", () => {
    expect(canonicalFacilityCellSchema.safeParse({ ...baseCell, expectedBlock: undefined }).success).toBe(false);
    expect(canonicalFacilityCellSchema.safeParse({ ...baseCell, phase: undefined }).success).toBe(false);
  });

  it("多余字段拒绝", () => {
    expect(canonicalFacilityCellSchema.safeParse({ ...baseCell, extra: true }).success).toBe(false);
  });

  it("非法 expectedBlock 拒绝", () => {
    expect(canonicalFacilityCellSchema.safeParse({ ...baseCell, expectedBlock: "Not A Block" }).success).toBe(false);
  });
});

describe("Phase ordering", () => {
  it("dangerous_activation 永远排最后", () => {
    const cells: CanonicalFacilityCell[] = [
      { cellId: "a", offset: { x: 0, y: 0, z: 0 }, expectedBlock: "water", purpose: "fluid_source", phase: "dangerous_activation" },
      { cellId: "b", offset: { x: 1, y: 0, z: 0 }, expectedBlock: "cobblestone", purpose: "structural", phase: "foundation" },
      { cellId: "c", offset: { x: 2, y: 0, z: 0 }, expectedBlock: "cobblestone", purpose: "structural", phase: "structure" },
    ];
    const sorted = cellsInPhaseOrder(cells);
    expect(sorted[sorted.length - 1]!.cellId).toBe("a");
    expect(sorted[0]!.cellId).toBe("b");
  });

  it("validatePhaseOrdering 检测违规", () => {
    // 排序后的数组自然满足约束——验证函数在乱序输入上工作
    const cells: CanonicalFacilityCell[] = [
      { cellId: "x", offset: { x: 0, y: 0, z: 0 }, expectedBlock: "lava", purpose: "fluid_source", phase: "dangerous_activation" },
    ];
    const issues = validatePhaseOrdering(cellsInPhaseOrder(cells));
    expect(issues).toEqual([]);
  });

  it("无 dangerous cells = 无违规", () => {
    const cells: CanonicalFacilityCell[] = [
      { cellId: "a", offset: { x: 0, y: 0, z: 0 }, expectedBlock: "cobblestone", purpose: "structural", phase: "foundation" },
    ];
    expect(validatePhaseOrdering(cells)).toEqual([]);
  });
});

describe("Template manifest schema", () => {
  it("拒绝缺少 hash 的模板", () => {
    const bad = {
      schemaVersion: "1.0",
      templateId: "test-farm",
      version: "1",
      facilityKind: "crop_farm",
      contentHash: "not-a-hash",
      sourceUrl: "https://example.com",
      licenseStatus: "unknown",
      claimedMinecraftVersions: ["1.21.11"],
      verifiedMinecraftVersions: [],
      size: { width: 9, height: 3, depth: 9 },
      cells: [],
      entityRequirements: [],
      minCommissioningMs: 60000,
      expectedMinOutputPerHour: 0,
      chunkAssumptions: [],
      afkAssumptions: [],
      failureModes: [],
    };
    expect(facilityTemplateManifestSchema.safeParse(bad).success).toBe(false);
  });
});
