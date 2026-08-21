import type { SkillPolicyView } from "../types.js";

// ---------------------------------------------------------------------------
// 方块交互距离的**唯一**判定入口。
//
// 此前四个技能各写一份 `MAX_DISTANCE = 4.5` 和一份 hypot 计算
// （craft-item / place-block / container-transfer / smelt-item）。两个后果：
//   1. 常量是死的。ServerPolicy 换成 STRICT（3.8 格）时技能行为完全不变，
//      策略层等于没接上（AGENTS.md §2）。
//   2. 方块中心偏移 +0.5 抄了四遍，改一处修不全。
//
// 所以距离怎么算放这里，能不能够得着交给 ServerPolicy 裁决。技能只说
// "这是目标方块、这是我站的地方"，不再自带一个上限数字。
// ---------------------------------------------------------------------------

export type BlockCoordinate = Readonly<{ x: number; y: number; z: number }>;
export type ObservedCoordinate = Readonly<{ x: number; y: number; z: number }>;

/**
 * Bot 眼下位置到方块**中心**的直线距离。
 *
 * 方块坐标是它的最小角，交互判定的参照点是中心，所以三轴各 +0.5。
 * 这与 Mineflayer 的 `block.position` 语义一致（整数最小角）。
 */
export function blockCenterDistance(
  block: BlockCoordinate,
  position: ObservedCoordinate,
): number {
  return Math.hypot(
    block.x + 0.5 - position.x,
    block.y + 0.5 - position.y,
    block.z + 0.5 - position.z,
  );
}

/**
 * 该方块是否在**当前策略**允许的交互距离内。
 *
 * 注意裁决权在 `policy`，不在这里：本函数不含任何上限常量，
 * 换档位（STRICT 3.8 / VANILLA_COMPATIBLE 4.5）会真的改变结果。
 */
export function blockWithinPolicyReach(
  block: BlockCoordinate,
  position: ObservedCoordinate,
  policy: SkillPolicyView,
): boolean {
  return policy.checkBlockReach(blockCenterDistance(block, position)).allowed;
}
