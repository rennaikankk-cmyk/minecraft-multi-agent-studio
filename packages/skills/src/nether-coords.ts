// ---------------------------------------------------------------------------
// nether-coords.ts —— 下界坐标域单源：dimension 常量 + 1:8 换算 + 候选区。
//
// 纪律（R5-RECON Phase 1.1）：
//   1. 主世界↔下界换算只允许经过本模块——禁止任何散落的手写 x8。
//   2. 换算是纯函数（无 IO、无时钟），同输入同输出，可回放。
//   3. 门户关联搜索半径是 vanilla 语义的**工作假设**：R5c offset 门协议
//      实现时必须按 minecraft-data / fixture 实测复核，不得把这里的默认
//      值当成服务器真值（UNKNOWN 纪律）。
// ---------------------------------------------------------------------------

import { z } from "zod";

export const OVERWORLD_DIMENSION = "minecraft:overworld";
export const NETHER_DIMENSION = "minecraft:the_nether";
export const END_DIMENSION = "minecraft:the_end";

/** 下界:主世界 水平坐标比例（1:8）。y 不参与换算。 */
export const NETHER_COORDINATE_RATIO = 8;

/** vanilla 1.16+ 下界高度 256；基岩顶面为 y=127 的上表面（roof 站立面=128）。 */
export const NETHER_ROOF_STAND_Y = 128;
export const NETHER_BEDROCK_CEILING_Y = 127;

export const dimensionIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

export const worldPositionSchema = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2_048).max(2_048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  })
  .strict();
export type WorldPosition = z.infer<typeof worldPositionSchema>;

export function isNetherDimension(dimension: string): boolean {
  return dimension === NETHER_DIMENSION;
}

export function isOverworldDimension(dimension: string): boolean {
  return dimension === OVERWORLD_DIMENSION;
}

/**
 * 下界坐标 → 对应主世界坐标（门户关联的理想落点）。
 * 水平 x/z 乘 8；y 原样带出（调用方按目标维度世界高度自行处理落点搜索，
 * 换算层不捏造 y）。
 */
export function netherToOverworld(position: WorldPosition): WorldPosition {
  return {
    x: position.x * NETHER_COORDINATE_RATIO,
    y: position.y,
    z: position.z * NETHER_COORDINATE_RATIO,
  };
}

/**
 * 主世界坐标 → 对应下界坐标。除法用 floor：MC 门户搜索的等价点是
 * 按块对齐的（-1/8 必须落 -1 而不是向零取整的 0）。
 */
export function overworldToNether(position: WorldPosition): WorldPosition {
  return {
    x: Math.floor(position.x / NETHER_COORDINATE_RATIO),
    y: position.y,
    z: Math.floor(position.z / NETHER_COORDINATE_RATIO),
  };
}

export interface OverworldCandidateRegion {
  readonly centerX: number;
  readonly centerZ: number;
  /** 候选区半径（格）。真实基地可能出现在这个圆内任何位置——只给候选不给实锤。 */
  readonly radiusBlocks: number;
}

/**
 * 下界门标记 → 主世界侧排查候选区。
 *
 * 语义：下界门 (x,z) 的主世界对应门理想落点在 (8x, 8z)；由于门户搜索
 * 半径与地形修正，真实落点会偏离理想点。本函数把"搜索半径 + 允许的
 * 偏移余量"合成一个保守候选半径（默认 128+32=160 格）。
 *
 * searchRadiusBlocks 的 vanilla 值待 R5c 实测复核（见文件头纪律 3）。
 */
export function overworldCandidateRegion(
  netherPosition: WorldPosition,
  searchRadiusBlocks = 128,
  slackBlocks = 32,
): OverworldCandidateRegion {
  const ideal = netherToOverworld(netherPosition);
  return {
    centerX: ideal.x,
    centerZ: ideal.z,
    radiusBlocks: searchRadiusBlocks + slackBlocks,
  };
}

/** 候选区包含判定（水平距离，y 不参与——排查方自行处理高度差）。 */
export function regionContains(
  region: OverworldCandidateRegion,
  position: { x: number; z: number },
): boolean {
  const dx = position.x - region.centerX;
  const dz = position.z - region.centerZ;
  return dx * dx + dz * dz <= region.radiusBlocks * region.radiusBlocks;
}
