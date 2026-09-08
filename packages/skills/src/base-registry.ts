// ---------------------------------------------------------------------------
// BaseRegistry + starter_base_v1 + MaterialResolver + BlueprintReconciler
//
// Phase 9-12 垂直切片：命名基地（Base）是 Facility 之上的最高层组织单位。
//
//   starterBaseV1()   确定性生成 starter_base_v1 蓝图（5x5 生存小屋）
//   resolveMaterials()  蓝图 → 材料需求 / 缺口（MaterialResolver）
//   BaseRegistry      基地生命周期 + 多 Bot cell 级施工预约（稳定 id）
//   reconcileBlueprint() 观测 vs 蓝图 → placed/missing/wrong + 修复顺序
//
// 契约：
//   1. baseId 确定性（server+dimension+anchor），create 幂等——同 Facility
//   2. 生命周期 planned→building→operational→(damaged⇄operational)→abandoned，
//      非法跳变拒绝；abandoned 终态
//   3. cell 预约有 TTL 防呆（bot 崩溃不永久卡死施工位）
//   4. 状态机与时钟可注入；serialize/restore 支持跨进程
//
// starter_base_v1 布局（local 坐标，x∈[0,4] z∈[0,4]，y 0=地板 1/2=墙 3=顶）：
//   - 地板 5x5 cobblestone（foundation）
//   - 周墙 oak_planks（structural），南墙中 (2,4) y1..2 留 2 高门洞
//   - 顶 5x5 oak_planks（shell）
//   - 室内工作站（utility）：furnace(1,1) crafting_table(3,1) chest(1,3)
//   - 火把（decoration）：室内 (3,3)、(2,2)
//   限制（v1 已知，不做虚假承诺）：bed 需要 2 格对齐放置，v1 不含床；
//   顶板中心 3x3 需要脚手架或逐圈向内放置（order 字段已按外圈→内圈排序）。
// ---------------------------------------------------------------------------

import {
  blueprintCellSchema,
  blueprintSchema,
  orderBlueprintCells,
  type Blueprint,
  type BlueprintCell,
} from "@minecraft-studio/base-management/blueprint-contracts";
import type { BlockPosition } from "./workstation-registry.js";
import { baseLayoutSchema, planBaseLayout, type BaseLayout } from "./base-layout.js";

// ---------------------------------------------------------------------------
// starter_base_v1
// ---------------------------------------------------------------------------

export const STARTER_BASE_V1_ID = "starter_base_v1";
export const STARTER_BASE_V1_VERSION = 1;

export interface StarterBaseParams {
  readonly serverProfileId: string;
  readonly dimension: string;
  readonly anchor: BlockPosition;
}

/** 5x5 生存小屋蓝图（确定性：同参数同输出）。 */
export function starterBaseV1(params: StarterBaseParams): Blueprint {
  const cells: BlueprintCell[] = [];
  const WALL = "oak_planks";
  const FLOOR = "cobblestone";

  // 地板（foundation, order 0）——先于一切
  for (let x = 0; x <= 4; x += 1) {
    for (let z = 0; z <= 4; z += 1) {
      cells.push(cell({ x, y: 0, z }, FLOOR, "foundation", x * 5 + z));
    }
  }

  // 墙（structural, order 100+）：周界 y=1..2，南墙中心 (2,4) 留门
  let wallOrder = 100;
  for (let y = 1; y <= 2; y += 1) {
    for (let x = 0; x <= 4; x += 1) {
      for (let z = 0; z <= 4; z += 1) {
        const onPerimeter = x === 0 || x === 4 || z === 0 || z === 4;
        if (!onPerimeter) continue;
        const isDoorway = x === 2 && z === 4 && (y === 1 || y === 2);
        if (isDoorway) continue;
        cells.push(cell({ x, y, z }, WALL, "structural", wallOrder));
        wallOrder += 1;
      }
    }
  }

  // 顶（shell, order 300+）：外圈 → 内圈（向心放置，保持可依附）
  for (let ring = 0; ring <= 2; ring += 1) {
    for (let x = ring; x <= 4 - ring; x += 1) {
      for (let z = ring; z <= 4 - ring; z += 1) {
        const onRing =
          (x === ring || x === 4 - ring || z === ring || z === 4 - ring) &&
          !(x > ring && x < 4 - ring && z > ring && z < 4 - ring);
        if (!onRing) continue;
        cells.push(cell({ x, y: 3, z }, WALL, "shell", 300 + ring * 30 + x * 5 + z));
      }
    }
  }

  // 工作站（utility, order 500+）：室内角落
  cells.push(cell({ x: 1, y: 1, z: 1 }, "furnace", "utility", 500));
  cells.push(cell({ x: 3, y: 1, z: 1 }, "crafting_table", "utility", 501));
  cells.push(cell({ x: 1, y: 1, z: 3 }, "chest", "utility", 502));

  // 火把（decoration, order 900+）
  cells.push(cell({ x: 3, y: 1, z: 3 }, "torch", "decoration", 900));
  cells.push(cell({ x: 2, y: 1, z: 2 }, "torch", "decoration", 901));

  return blueprintSchema.parse({
    anchor: params.anchor,
    dimension: params.dimension,
    serverProfileId: params.serverProfileId,
    cells,
  });
}

function cell(
  offset: { x: number; y: number; z: number },
  itemName: string,
  blockClass: BlueprintCell["blockClass"],
  order: number,
): BlueprintCell {
  return blueprintCellSchema.parse({ offset, itemName, blockClass, order });
}

// ---------------------------------------------------------------------------
// MaterialResolver
// ---------------------------------------------------------------------------

/** 蓝图 → 每种物品需要数量；给定 available 时返回缺口（需要但不足的部分）。 */
export function resolveMaterials(
  blueprint: Blueprint,
  available?: ReadonlyMap<string, number>,
): Map<string, number> {
  const required = new Map<string, number>();
  for (const c of blueprint.cells) {
    required.set(c.itemName, (required.get(c.itemName) ?? 0) + 1);
  }
  if (!available) return required;
  const shortfall = new Map<string, number>();
  for (const [itemName, need] of required) {
    const have = available.get(itemName) ?? 0;
    if (have < need) shortfall.set(itemName, need - have);
  }
  return shortfall;
}

// ---------------------------------------------------------------------------
// BaseRegistry
// ---------------------------------------------------------------------------

export * from '@minecraft-studio/base-management/base-registry';
export interface ReconciledCell {
  readonly cell: BlueprintCell;
  readonly observedItemName: string | null;
  readonly expectedItemName: string;
  readonly blockClass: BlueprintCell["blockClass"];
}

export interface ReconcileResult {
  /** 已放置且方块正确。 */
  readonly placed: readonly ReconciledCell[];
  /** 位置为空（air）。 */
  readonly missing: readonly ReconciledCell[];
  /** 位置有方块但不是蓝图方块（需要先拆再放）。 */
  readonly wrong: readonly ReconciledCell[];
  /** 完整性 0..1 = placed / total。 */
  readonly integrity01: number;
  /** 修复顺序（wrong + missing，按建造 class rank 排序）。 */
  readonly repairOrder: readonly BlueprintCell[];
  /** 未观测 cell 数（不在 observations 里的不参与判定）。 */
  readonly unobserved: number;
}

/**
 * 观测 vs 蓝图。
 * observations: key = JSON.stringify(offset), value = 方块名（null = 空气）。
 */
export function reconcileBlueprint(
  blueprint: Blueprint,
  observations: ReadonlyMap<string, string | null>,
  propertyDifferences: ReadonlySet<string> = new Set(),
): ReconcileResult {
  const placed: ReconciledCell[] = [];
  const missing: ReconciledCell[] = [];
  const wrong: ReconciledCell[] = [];
  let unobserved = 0;

  for (const c of blueprint.cells) {
    const key = JSON.stringify(c.offset);
    if (!observations.has(key)) {
      unobserved += 1;
      continue;
    }
    const observed = observations.get(key)!;
    const entry: ReconciledCell = {
      cell: c,
      observedItemName: observed,
      expectedItemName: c.itemName,
      blockClass: c.blockClass,
    };
    if (observed === null) missing.push(entry);
    else if (observed === c.itemName && !propertyDifferences.has(key)) placed.push(entry);
    else wrong.push(entry);
  }

  const total = blueprint.cells.length;
  const repairCells = [...wrong.map((w) => w.cell), ...missing.map((m) => m.cell)];
  const repairOrder = orderBlueprintCells({
    ...blueprint,
    cells: repairCells,
  } as Blueprint);

  return Object.freeze({
    placed,
    missing,
    wrong,
    // 完整性按整个蓝图计算（未观测的部分不算已建）
    integrity01: placed.length / total,
    repairOrder,
    unobserved,
  });
}
