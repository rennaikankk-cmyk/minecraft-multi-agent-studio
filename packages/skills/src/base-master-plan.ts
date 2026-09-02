// ---------------------------------------------------------------------------
// base-master-plan.ts —— 基地主计划：分区/设施依赖/干扰矩阵（BASE-AUTO §四）。
//
// 纪律：基地不是一个巨大自由文本蓝图，而是 Facility Dependency Graph +
// 分区 + 干扰矩阵 + 阶段建设计划。
// ---------------------------------------------------------------------------

import { z } from "zod";
import { automatedFacilityKindSchema, type AutomatedFacilityKind } from "./facility-platform.js";

// ---------------------------------------------------------------------------
// Base zones
// ---------------------------------------------------------------------------

export const baseZoneKinds = [
  "core_storage",
  "bot_spawn",
  "food_zone",
  "building_materials_zone",
  "smelting_zone",
  "villager_zone",
  "mob_farm_zone",
  "fluid_hazard_zone",
  "maintenance_corridor",
  "expansion_reserve",
  "defense_perimeter",
  "construction_staging",
] as const;
export const baseZoneKindSchema = z.enum(baseZoneKinds);
export type BaseZoneKind = z.infer<typeof baseZoneKindSchema>;

export const baseZoneSchema = z
  .object({
    zoneId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    kind: baseZoneKindSchema,
    /** 相对基地区域中心的边界框。 */
    bounds: z.object({
      minX: z.number().int(), maxX: z.number().int(),
      minY: z.number().int(), maxY: z.number().int(),
      minZ: z.number().int(), maxZ: z.number().int(),
    }).strict(),
    /** 该区允许的设施类型。 */
    allowedFacilityKinds: z.array(automatedFacilityKindSchema).max(11),
  })
  .strict();
export type BaseZone = z.infer<typeof baseZoneSchema>;

// ---------------------------------------------------------------------------
// Facility dependency edges
// ---------------------------------------------------------------------------

export const facilityDependencySchema = z
  .object({
    /** 依赖设施类型（必须先 operational）。 */
    dependsOnKind: automatedFacilityKindSchema,
    /** 依赖强度：hard=不建成就不能开始；soft=建议但有 workaround。 */
    strength: z.enum(["hard", "soft"]),
    reason: z.string().max(200),
  })
  .strict();
export type FacilityDependency = z.infer<typeof facilityDependencySchema>;

/** 默认依赖图（BASE-AUTO §四建议）。LLM 只能在 soft 边上做选择。 */
export const DEFAULT_FACILITY_DEPENDENCIES: Readonly<
  Record<AutomatedFacilityKind, readonly FacilityDependency[]>
> = Object.freeze({
  crop_farm: [
    { dependsOnKind: "storage_system", strength: "soft", reason: "食物产出需要收集点（初期可 Bot 直接收）" },
  ],
  villager_crop_farm: [
    { dependsOnKind: "crop_farm", strength: "soft", reason: "先验证作物农场再升级村民版" },
    { dependsOnKind: "storage_system", strength: "hard", reason: "村民农场产量高必须有收集" },
  ],
  cobblestone_generator: [], // 无前置——最简设施
  stone_processing: [
    { dependsOnKind: "cobblestone_generator", strength: "hard", reason: "需要圆石输入" },
    { dependsOnKind: "smelting_array", strength: "hard", reason: "需要熔炉" },
  ],
  bamboo_farm: [
    { dependsOnKind: "storage_system", strength: "soft", reason: "竹子量大需要存储" },
  ],
  sugar_cane_farm: [
    { dependsOnKind: "storage_system", strength: "soft", reason: "甘蔗量大需要存储" },
  ],
  iron_farm: [
    { dependsOnKind: "crop_farm", strength: "hard", reason: "Bot 没食物时不能冒险建铁机" },
    { dependsOnKind: "storage_system", strength: "hard", reason: "铁产出需要收集/存储" },
    { dependsOnKind: "cobblestone_generator", strength: "hard", reason: "施工材料需要可再生来源" },
  ],
  gunpowder_farm: [
    { dependsOnKind: "iron_farm", strength: "hard", reason: "需要铁工具/装备才能安全运营火药塔" },
    { dependsOnKind: "crop_farm", strength: "hard", reason: "运营期消耗食物" },
  ],
  mob_drop_farm: [
    { dependsOnKind: "crop_farm", strength: "hard", reason: "运营期消耗食物" },
  ],
  storage_system: [], // 基础设施，无前置
  smelting_array: [
    { dependsOnKind: "storage_system", strength: "soft", reason: "燃料/原料需要存放点" },
  ],
});

// ---------------------------------------------------------------------------
// Interference matrix
// ---------------------------------------------------------------------------

export const interferenceKinds = [
  "shared_entities",
  "mob_cap_competition",
  "chunk_loading_overlap",
  "redstone_hopper_load",
  "water_lava_risk",
  "pathway_conflict",
  "simulation_distance",
  "player_activity_requirement",
  "transport_distance",
  "protected_region_overlap",
] as const;
export const interferenceKindSchema = z.enum(interferenceKinds);

export const facilityInterferenceSchema = z
  .object({
    kindA: automatedFacilityKindSchema,
    kindB: automatedFacilityKindSchema,
    interferenceType: interferenceKindSchema,
    severity: z.enum(["none", "low", "medium", "high"]),
    mitigation: z.string().max(300),
  })
  .strict();
export type FacilityInterference = z.infer<typeof facilityInterferenceSchema>;

// ---------------------------------------------------------------------------
// Build priority order（依赖拓扑排序的结果）
// ---------------------------------------------------------------------------

/** 按依赖拓扑排序的建设顺序（hard 依赖）。 */
export function facilityBuildOrder(
  kinds: readonly AutomatedFacilityKind[],
): readonly AutomatedFacilityKind[] {
  const visited = new Set<AutomatedFacilityKind>();
  const order: AutomatedFacilityKind[] = [];

  function visit(kind: AutomatedFacilityKind): void {
    if (visited.has(kind)) return;
    visited.add(kind);
    for (const dep of DEFAULT_FACILITY_DEPENDENCIES[kind] ?? []) {
      if (dep.strength === "hard" && kinds.includes(dep.dependsOnKind)) {
        visit(dep.dependsOnKind);
      }
    }
    order.push(kind);
  }

  for (const kind of kinds) visit(kind);
  return order;
}

/** 检查设施列表是否满足 hard 依赖（返回缺失的 hard 依赖）。 */
export function missingHardDependencies(
  kind: AutomatedFacilityKind,
  operationalKinds: ReadonlySet<AutomatedFacilityKind>,
): readonly FacilityDependency[] {
  const deps = DEFAULT_FACILITY_DEPENDENCIES[kind] ?? [];
  return deps.filter(
    (dep) => dep.strength === "hard" && !operationalKinds.has(dep.dependsOnKind),
  );
}

/** 检测循环依赖。 */
export function detectDependencyCycle(
  kinds: readonly AutomatedFacilityKind[],
): readonly string[] {
  const visiting = new Set<AutomatedFacilityKind>();
  const visited = new Set<AutomatedFacilityKind>();
  const cycles: string[] = [];

  function dfs(kind: AutomatedFacilityKind, path: AutomatedFacilityKind[]): void {
    if (visited.has(kind)) return;
    if (visiting.has(kind)) {
      cycles.push([...path, kind].map(String).join("→"));
      return;
    }
    visiting.add(kind);
    for (const dep of DEFAULT_FACILITY_DEPENDENCIES[kind] ?? []) {
      if (dep.strength === "hard" && kinds.includes(dep.dependsOnKind)) {
        dfs(dep.dependsOnKind, [...path, kind]);
      }
    }
    visiting.delete(kind);
    visited.add(kind);
  }

  for (const kind of kinds) dfs(kind, []);
  return cycles;
}
