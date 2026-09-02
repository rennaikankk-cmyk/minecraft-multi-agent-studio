// ---------------------------------------------------------------------------
// facility-platform.ts —— 统一 Farm Facility 平台域模型。
//
// 纪律（BASE-AUTO 提示词 §三/§五）：
//   1. 禁止每种农场各自实现蓝图解析/Build Journal/产量验证/健康检查/Incident/
//      材料计划/实体运输——一切走本平台。
//   2. 扩展现有 FacilityRegistry（packages/skills/src/facility-registry.ts），
//      不造第二套注册表。
//   3. Lifecycle 状态机是确定性的：每个转换有前置条件与证据要求。
//   4. canonical blueprint cell 是唯一结构真值（对齐已有 build.blueprint 的
//      BlueprintCell 但增加 phase/purpose/protection/rollback）。
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// Facility kinds（BASE-AUTO §三）
// ---------------------------------------------------------------------------

export const automatedFacilityKinds = [
  "crop_farm",
  "villager_crop_farm",
  "cobblestone_generator",
  "stone_processing",
  "bamboo_farm",
  "sugar_cane_farm",
  "iron_farm",
  "gunpowder_farm",
  "mob_drop_farm",
  "storage_system",
  "smelting_array",
] as const;
export const automatedFacilityKindSchema = z.enum(automatedFacilityKinds);
export type AutomatedFacilityKind = z.infer<typeof automatedFacilityKindSchema>;

// ---------------------------------------------------------------------------
// Lifecycle states（BASE-AUTO §三）——确定性状态机，禁止跳跃
// ---------------------------------------------------------------------------

export const facilityLifecycleStates = [
  "researched",
  "planned",
  "site_selected",
  "materials_pending",
  "building",
  "entities_pending",
  "activation_pending",
  "commissioning",
  "operational",
  "degraded",
  "repairing",
  "paused",
  "decommissioning",
  "abandoned",
] as const;
export const facilityLifecycleStateSchema = z.enum(facilityLifecycleStates);
export type FacilityLifecycleState = z.infer<typeof facilityLifecycleStateSchema>;

/** 合法转换表（from → to[]）。不在表内 = 非法跳跃，注册表拒绝。 */
export const FACILITY_LIFECYCLE_TRANSITIONS: Readonly<
  Record<FacilityLifecycleState, readonly FacilityLifecycleState[]>
> = Object.freeze({
  researched: ["planned", "abandoned"],
  planned: ["site_selected", "abandoned"],
  site_selected: ["materials_pending", "planned", "abandoned"],
  materials_pending: ["building", "paused", "abandoned"],
  building: ["entities_pending", "activation_pending", "commissioning", "paused", "abandoned", "degraded"],
  entities_pending: ["activation_pending", "commissioning", "paused", "abandoned", "degraded"],
  activation_pending: ["commissioning", "paused", "abandoned", "degraded"],
  commissioning: ["operational", "degraded", "paused", "abandoned"],
  operational: ["degraded", "paused", "decommissioning"],
  degraded: ["repairing", "paused", "decommissioning", "abandoned"],
  repairing: ["commissioning", "degraded", "paused", "abandoned"],
  paused: ["building", "commissioning", "operational", "decommissioning", "abandoned"],
  decommissioning: ["abandoned"],
  abandoned: [],
});

// ---------------------------------------------------------------------------
// Canonical blueprint cell（BASE-AUTO §五）——对齐 build.blueprint 并扩展
// ---------------------------------------------------------------------------

const coordinateSchema = z
  .object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
  .strict();

export const facilityProtectionLevels = ["none", "protected", "critical"] as const;
export const facilityProtectionLevelSchema = z.enum(facilityProtectionLevels);

export const facilityCellPurposeSchema = z.enum([
  "structural",
  "fluid_source",
  "fluid_channel",
  "farmland",
  "spawn_surface",
  "kill_chamber",
  "collection",
  "villager_cell",
  "control_entity_cell",
  "bed",
  "workstation",
  "barrier",
  "decoration",
  "transport_path",
]);
export type FacilityCellPurpose = z.infer<typeof facilityCellPurposeSchema>;

export const facilityPhaseSchema = z.enum([
  "foundation",
  "structure",
  "villager_cells",
  "beds_workstations",
  "spawn_platform",
  "water_collection",
  "kill_chamber_shell",
  "dangerous_activation",
  "seal_escape",
]);
export type FacilityPhase = z.infer<typeof facilityPhaseSchema>;

/** 危险阶段排序：dangerous_activation 永远最后（BASE-AUTO §7.5）。 */
export const PHASE_ORDER: readonly FacilityPhase[] = Object.freeze([
  "foundation",
  "structure",
  "villager_cells",
  "beds_workstations",
  "spawn_platform",
  "water_collection",
  "kill_chamber_shell",
  "seal_escape",
  "dangerous_activation", // 最后
] as FacilityPhase[]);

export const canonicalFacilityCellSchema = z
  .object({
    cellId: z.string().min(1).max(128),
    offset: coordinateSchema,
    /** 预期方块 registry 名（snake_case）。 */
    expectedBlock: z.string().regex(/^[a-z0-9_]+$/u).max(64),
    purpose: facilityCellPurposeSchema,
    phase: facilityPhaseSchema,
    /** 放置支撑面；默认正下方。 */
    referenceOffset: coordinateSchema.optional(),
    face: coordinateSchema.optional(),
    /** 已验证 cell 的保护级别（provenance 联动）。 */
    protection: facilityProtectionLevelSchema.default("protected"),
    /** replace policy：是否允许覆盖已有非 air 方块。 */
    replacePolicy: z.enum(["never", "air_only", "any"]).default("air_only"),
  })
  .strict();
export type CanonicalFacilityCell = z.infer<typeof canonicalFacilityCellSchema>;

// ---------------------------------------------------------------------------
// Entity requirement（BASE-AUTO §7.4）
// ---------------------------------------------------------------------------

export const facilityEntityRequirementSchema = z
  .object({
    role: z.enum(["villager", "zombie", "cat", "other"]),
    count: z.number().int().min(1).max(64),
    /** 实体必须被运到的 cell（相对锚点偏移）。 */
    targetOffset: coordinateSchema,
    /** 运输 deadline（parking 后超时视为失败）。 */
    transportTimeoutMs: z.number().int().min(1_000).max(600_000),
    /** 是否需要持久化（防 despawn）。 */
    requiresPersistence: z.boolean().default(true),
  })
  .strict();
export type FacilityEntityRequirement = z.infer<typeof facilityEntityRequirementSchema>;

// ---------------------------------------------------------------------------
// Template manifest（BASE-AUTO §7.2）
// ---------------------------------------------------------------------------

export const facilityTemplateManifestSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    templateId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    version: z.string().min(1).max(32),
    facilityKind: automatedFacilityKindSchema,
    /** 模板内容的 SHA-256（canonical cells 序列化后）。 */
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceUrl: z.string().url().max(500),
    licenseStatus: z.enum(["approved", "restricted", "unknown"]),
    /** 声称的 MC 版本（未验证）。 */
    claimedMinecraftVersions: z.array(z.string().max(32)).max(16),
    /** 实测通过的版本。 */
    verifiedMinecraftVersions: z.array(z.string().max(32)).max(16),
    /** 尺寸。 */
    size: z.object({
      width: z.number().int().min(1).max(256),
      height: z.number().int().min(1).max(128),
      depth: z.number().int().min(1).max(256),
    }).strict(),
    /** 细胞总数（上限 2048）。 */
    cells: z.array(canonicalFacilityCellSchema).min(1).max(2048),
    /** 实体需求。 */
    entityRequirements: z.array(facilityEntityRequirementSchema).max(32),
    /** commissioning 观察窗口下限。 */
    minCommissioningMs: z.number().int().min(60_000).max(3_600_000),
    /** 预期产量下限（items/hr；OPERATIONAL 前提）。 */
    expectedMinOutputPerHour: z.number().min(0),
    /** AFK/区块要求。 */
    chunkAssumptions: z.array(z.string().max(200)).max(16),
    afkAssumptions: z.array(z.string().max(200)).max(16),
    /** 已知失败模式。 */
    failureModes: z.array(z.string().max(200)).max(32),
  })
  .strict();
export type FacilityTemplateManifest = z.infer<typeof facilityTemplateManifestSchema>;

// ---------------------------------------------------------------------------
// Facility record（BASE-AUTO §三）——FacilityRegistry 的扩展条目
// ---------------------------------------------------------------------------

export const facilityRecordSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    facilityId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    kind: automatedFacilityKindSchema,
    templateId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    templateVersion: z.string().max(32),
    templateHash: z.string().regex(/^[a-f0-9]{64}$/u),
    /** 服务器/维度/锚点。 */
    serverProfileId: z.string().max(128),
    minecraftVersion: z.string().max(32),
    dimension: z.string().max(128),
    anchor: coordinateSchema,
    /** 生命周期。 */
    lifecycle: facilityLifecycleStateSchema,
    lifecycleSince: z.number().int(),
    /** 建造进度。 */
    completedCells: z.number().int().min(0).max(2048),
    totalCells: z.number().int().min(1).max(2048),
    /** 最后验证/产量时间。 */
    lastVerifiedAt: z.number().int(),
    lastOutputAt: z.number().int().nullable(),
    /** 产量窗口。 */
    outputItemsPerHour: z.number().min(0).nullable(),
    outputConfidence: z.enum(["none", "low", "medium", "high"]),
    /** 收集器状态。 */
    collectorFull: z.boolean(),
    /** 退化原因。 */
    degradationReasons: z.array(z.string().max(200)).max(16),
    /** 所属。 */
    ownerBotId: z.string().max(128).nullable(),
    baseId: z.string().max(128).nullable(),
  })
  .strict();
export type FacilityRecord = z.infer<typeof facilityRecordSchema>;

// ---------------------------------------------------------------------------
// 验证工具
// ---------------------------------------------------------------------------

/** 检查 lifecycle 转换合法性。 */
export function canTransitionFacility(
  from: FacilityLifecycleState,
  to: FacilityLifecycleState,
): boolean {
  return FACILITY_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** canonical cells 按 phase 排序（dangerous_activation 最后）。 */
export function cellsInPhaseOrder(
  cells: readonly CanonicalFacilityCell[],
): readonly CanonicalFacilityCell[] {
  const phaseRank = new Map(PHASE_ORDER.map((phase, index) => [phase, index]));
  return [...cells].sort((a, b) => {
    const rankA = phaseRank.get(a.phase) ?? PHASE_ORDER.length;
    const rankB = phaseRank.get(b.phase) ?? PHASE_ORDER.length;
    if (rankA !== rankB) return rankA - rankB;
    return a.cellId.localeCompare(b.cellId);
  });
}

/** 验证模板的 dangerous_activation 阶段确实排在最后。 */
export function validatePhaseOrdering(
  cells: readonly CanonicalFacilityCell[],
): readonly string[] {
  const issues: string[] = [];
  const ordered = cellsInPhaseOrder(cells);
  const dangerous = cells.filter((cell) => cell.phase === "dangerous_activation");
  if (dangerous.length > 0) {
    const lastCell = ordered[ordered.length - 1];
    if (lastCell === undefined || lastCell.phase !== "dangerous_activation") {
      issues.push("dangerous_activation cells must be the last phase");
    }
  }
  return issues;
}
