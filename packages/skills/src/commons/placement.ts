// ---------------------------------------------------------------------------
// Minecraft 常识：交互距离、光照间距、农田水化、站点摆放要求。
//
// 四组事实，都是"动手前必须先算一遍"的硬约束：
//   1. 触及距离：生存模式 4.5 格——但真正的裁决权在 ServerPolicy
//      （STRICT 档 3.8），所以这里只给原版基准值与距离算法，上限由策略给。
//   2. 火把与光照：火把光照等级 14，每远离一格衰减 1；方块光照 0 才会刷怪。
//      于是"两支火把之间"的最大安全间距可以精确算出来，不靠感觉。
//   3. 农田水化：水源方块水化半径 4 的 9×9 区域（中心是水，四周各 4 格）。
//   4. 站点：工作台/熔炉/箱子/床必须"够得着 + 落点合法"。
//
// 纯知识层：位置是调用方传进来的坐标事实，这里不做任何世界查询。
//
// 距离**数学**不在这里实现：`builtin/reach.ts` 是"方块中心偏移 +0.5 + hypot"的
// 唯一入口（它存在的原因就是这份算法曾被四个技能各抄一遍）。本模块只提供原版
// 基准常量，并在需要时复用它，避免第二份实现随世界规则漂移。
// ---------------------------------------------------------------------------

import { z } from "zod";

import { blockCenterDistance } from "../builtin/reach.js";

/** 原版生存模式方块交互距离上限（格）。策略档位可能更严（STRICT 3.8）。 */
export const VANILLA_BLOCK_REACH = 4.5;

/** 2×2 手持合成的"够得着"下限：贴着背包操作，与方块无关。 */
export const INVENTORY_GRID_SIZE = 2;
/** 工作台 3×3 网格。 */
export const CRAFTING_TABLE_GRID_SIZE = 3;

/**
 * Bot 到方块**中心**的直线距离。
 * 方块坐标是最小角，交互参照点是中心，所以三轴各 +0.5（与 builtin/reach.ts 同一语义）。
 */
/**
 * 方块中心到观测位置的距离。
 *
 * 复用 `builtin/reach.ts` 的 `blockCenterDistance`——距离算法只有那一个实现。
 * 本函数只是给知识层一个同名入口，不重新推导公式。
 */
export function blockReachDistance(
  block: Readonly<{ x: number; y: number; z: number }>,
  position: Readonly<{ x: number; y: number; z: number }>,
): number {
  return blockCenterDistance(block, position);
}

/** 该方块是否在原版 4.5 格以内（**不是**策略裁决，仅供知识层自检与测试）。 */
export function withinVanillaReach(
  block: Readonly<{ x: number; y: number; z: number }>,
  position: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  return blockReachDistance(block, position) <= VANILLA_BLOCK_REACH;
}

/** 火把发出的方块光照等级。 */
export const TORCH_LIGHT_LEVEL = 14;

/** 方块光照衰减：每远离光源 1 格掉 1 级。 */
export const LIGHT_FALLOFF_PER_BLOCK = 1;

/** 敌对生物自然生成需要方块光照 0（1.18+ 只看向方块光照；光照 ≥1 即安全）。 */
export const HOSTILE_SPAWN_BLOCK_LIGHT = 0;

/** 受光半径：从光源起，光照仍 > HOSTILE_SPAWN_BLOCK_LIGHT 的最大格距。 */
export const TORCH_LIT_RADIUS = TORCH_LIGHT_LEVEL - HOSTILE_SPAWN_BLOCK_LIGHT;

/**
 * 两支火把之间的最大间距（格）——**取安全上限并留 1 格余量**。
 *
 * 推导：两支火把相距 d，中点距各 d/2，光照取两盏的较大值 = 14 - floor(d/2)。
 * 要求 14 - floor(d/2) > 0 ⇒ floor(d/2) ≤ 13 ⇒ d ≤ 27 时中点光照为 1（安全）；
 * d = 28 时 floor(d/2) = 14 → 中点光照 0 → **会刷怪**。
 * 所以理论安全上限是 27，本表取 26（每 13 格一支）留 1 格余量，
 * 因为实际布置里火把往往要贴墙，落点不会精确落在算出来的中点上。
 */
export const MAX_TORCH_SPACING = 26;

/**
 * 给定"最低可接受方块光照"，返回该光照下的最大**安全**间距（即中点在
 * 该光照下仍不刷怪的最远距离）：14 - floor(d/2) ≥ level ⇒ d ≤ 2*(14-level)+1。
 */
export function maxTorchSpacingFor(minimumBlockLight: number): number {
  const level = Number.isFinite(minimumBlockLight) ? Math.max(0, Math.floor(minimumBlockLight)) : 0;
  if (level > TORCH_LIGHT_LEVEL) return 0;
  return 2 * (TORCH_LIGHT_LEVEL - level) + 1;
}

/**
 * 沿一条直线按火把间距铺点，返回每支火把相对起点的偏移（含起点 0）。
 * 纯算术：不做世界查询、不决定火把放哪一面。
 */
export function torchOffsets(length: number): readonly number[] {
  if (!Number.isFinite(length) || length <= 0) return Object.freeze([0]);
  const offsets: number[] = [];
  for (let offset = 0; offset <= Math.floor(length); offset += MAX_TORCH_SPACING) {
    offsets.push(offset);
  }
  return Object.freeze(offsets);
}

/** 农田水化半径：水源方块四周各 4 格 → 9×9 的可耕作区域（中心为水）。 */
export const FARMLAND_HYDRATION_RADIUS = 4;

/** 一格水能水化的农田总数：9×9 - 1（中心是水本身）。 */
export const FARMLAND_TILES_PER_WATER = (FARMLAND_HYDRATION_RADIUS * 2 + 1) ** 2 - 1;

/** 农田到最近水源是否在水化半径内（切比雪夫距离：水化是方形范围，不是圆形）。 */
export function isHydrated(
  farmland: Readonly<{ x: number; z: number }>,
  water: Readonly<{ x: number; z: number }>,
): boolean {
  return (
    Math.abs(farmland.x - water.x) <= FARMLAND_HYDRATION_RADIUS &&
    Math.abs(farmland.z - water.z) <= FARMLAND_HYDRATION_RADIUS
  );
}

/** 站点种类。床、箱子、工作台、熔炉是四种最小必需站点。 */
export const stationKinds = [
  "crafting_table",
  "furnace",
  "chest",
  "bed",
  "torch",
  "water_source",
  "farmland",
] as const;
export const stationKindSchema = z.enum(stationKinds);
export type StationKind = (typeof stationKinds)[number];

export interface StationRequirement {
  readonly station: StationKind;
  /** 占用高度（格）：工作台/熔炉/箱子/火把各 1，床 0.5625 → 记为 1。 */
  readonly heightBlocks: number;
  /** 站点**上方**必须空出的格数：工作台/熔炉/箱子 1，床 2（头和脚），火把 1。 */
  readonly headroomBlocks: number;
  /** 下方是否需要实心支撑面。 */
  readonly needsSolidFloor: boolean;
  /** 是否需要相邻的可放置面（火把要贴墙/贴地，水要挖坑）。 */
  readonly placementSurface: "floor" | "wall-or-floor" | "liquid" | "soil";
  /** 交互距离上限（原版格）。 */
  readonly reachBlocks: number;
  /** 功能所需的最小水平占地（床 1×2）。 */
  readonly footprint: Readonly<{ width: number; depth: number }>;
}

/**
 * 站点摆放要求表。出处：原版方块机制——
 *   - 工作台/熔炉/箱子：落地 1 格高，上方至少 1 格空气（否则放不下/打不开）；
 *     箱子若要做成大箱子需要两格相邻，这里按单箱记 1×1。
 *   - 床：占 1×2，使用需要脚部上方 2 格空气（否则"上方有方块"拒绝入睡），
 *     下方必须是实心方块。
 *   - 火把：可贴地或贴墙，占 1 格、上方不需要空间（贴墙时上下无所谓）。
 *   - 水：需要挖一个坑（下方实心、四周挡水）。
 */
export const stationRequirements: Readonly<Record<StationKind, StationRequirement>> = Object.freeze({
  crafting_table: Object.freeze({
    station: "crafting_table",
    heightBlocks: 1,
    headroomBlocks: 1,
    needsSolidFloor: true,
    placementSurface: "floor",
    reachBlocks: VANILLA_BLOCK_REACH,
    footprint: Object.freeze({ width: 1, depth: 1 }),
  }),
  furnace: Object.freeze({
    station: "furnace",
    heightBlocks: 1,
    headroomBlocks: 1,
    needsSolidFloor: true,
    placementSurface: "floor",
    reachBlocks: VANILLA_BLOCK_REACH,
    footprint: Object.freeze({ width: 1, depth: 1 }),
  }),
  chest: Object.freeze({
    station: "chest",
    heightBlocks: 1,
    headroomBlocks: 1,
    needsSolidFloor: true,
    placementSurface: "floor",
    reachBlocks: VANILLA_BLOCK_REACH,
    footprint: Object.freeze({ width: 1, depth: 1 }),
  }),
  bed: Object.freeze({
    station: "bed",
    heightBlocks: 1,
    headroomBlocks: 2,
    needsSolidFloor: true,
    placementSurface: "floor",
    reachBlocks: VANILLA_BLOCK_REACH,
    footprint: Object.freeze({ width: 1, depth: 2 }),
  }),
  torch: Object.freeze({
    station: "torch",
    heightBlocks: 1,
    headroomBlocks: 1,
    needsSolidFloor: false,
    placementSurface: "wall-or-floor",
    reachBlocks: VANILLA_BLOCK_REACH,
    footprint: Object.freeze({ width: 1, depth: 1 }),
  }),
  water_source: Object.freeze({
    station: "water_source",
    heightBlocks: 1,
    headroomBlocks: 1,
    needsSolidFloor: true,
    placementSurface: "liquid",
    reachBlocks: VANILLA_BLOCK_REACH,
    footprint: Object.freeze({ width: 1, depth: 1 }),
  }),
  farmland: Object.freeze({
    station: "farmland",
    heightBlocks: 1,
    headroomBlocks: 1,
    needsSolidFloor: true,
    placementSurface: "soil",
    reachBlocks: VANILLA_BLOCK_REACH,
    footprint: Object.freeze({ width: 1, depth: 1 }),
  }),
});

/** 需要工作台（3×3）才能完成的任务：合成台本身之外的 3×3 配方都需要它。 */
export function requiresCraftingTable(gridSize: number): boolean {
  return gridSize > INVENTORY_GRID_SIZE;
}
