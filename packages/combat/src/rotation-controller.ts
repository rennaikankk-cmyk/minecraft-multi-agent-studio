/**
 * RotationController —— 战术级（T，≤200ms）确定性朝向控制。零 AI。
 *
 * docs/combat-tactics-reference.md §5/§7 的两条要求在这里落地：
 *   - 瞄准"够用即可"：进入容差角内就不再转头，避免持续微调这种非人特征。
 *   - 转速上限 + 微噪声：单帧最大转角受限，绝不瞬间 180°。
 *
 * **诚实边界（§7 红线）**：这些手段只降低明显的机器破绽，**不等于免疫封号**。
 * 残余风险由使用者承担。本文件不声称、也不得被引用为"反封号已解决"。
 *
 * 噪声必须确定性可测，所以用注入的种子跑一个纯整数 PRNG，而不是 Math.random。
 * 同一种子 + 同一输入 = 同一输出，单测可以逐帧断言。
 */

import { DeterministicJitter } from "./deterministic-jitter.js";
import type { CombatVector3 } from "./threat-analyzer.js";

export type CombatOrientation = Readonly<{
  /** 偏航角，度。范围规范化到 (-180, 180]。 */
  yaw: number;
  /** 俯仰角，度。范围钳制到 [-90, 90]。 */
  pitch: number;
}>;

export type CombatRotationPolicy = Readonly<{
  /** 单帧最大转角（度）。上限存在本身就是反检测措施。 */
  maxDegreesPerTick: number;
  /** 进入此容差内视为已瞄准，停止转头（"够用即可"）。 */
  aimToleranceDegrees: number;
  /** 每帧叠加的噪声幅度（度），0 表示关闭噪声。 */
  jitterDegrees: number;
}>;

export const DEFAULT_ROTATION_POLICY: CombatRotationPolicy = {
  maxDegreesPerTick: 35,
  aimToleranceDegrees: 3,
  jitterDegrees: 0.6,
};

export type CombatRotationStep = Readonly<{
  /** 本帧应当采用的朝向。 */
  orientation: CombatOrientation;
  /** 距目标朝向的剩余角度（度），已含本帧转动。 */
  remainingDegrees: number;
  /** 是否已在容差内。true 时 orientation 与输入当前朝向相同。 */
  aimed: boolean;
  /** 本帧是否被转速上限截断。 */
  clamped: boolean;
}>;

/** 眼高：站立玩家眼睛比脚位高约 1.62 格，瞄准要用眼位而不是脚位。 */
const EYE_HEIGHT = 1.62;

function normalizeYaw(yaw: number): number {
  const wrapped = ((yaw + 180) % 360 + 360) % 360 - 180;
  // ((-180 + 180) % 360) 归到 -180，统一成 180 让区间为 (-180, 180]。
  return wrapped === -180 ? 180 : wrapped;
}

function clampPitch(pitch: number): number {
  return Math.min(90, Math.max(-90, pitch));
}

/** 两个偏航角之间的最短带符号差，落在 (-180, 180]。 */
function yawDelta(from: number, to: number): number {
  return normalizeYaw(to - from);
}

/**
 * 从眼位指向目标点的朝向。原版 yaw 以 +Z（南）为 0，向 -X（西）为正，
 * 对应 atan2(-dx, dz)。pitch 向下为正。
 */
export function orientationToward(
  eyePosition: CombatVector3,
  targetPosition: CombatVector3,
): CombatOrientation {
  const dx = targetPosition.x - eyePosition.x;
  const dy = targetPosition.y - eyePosition.y;
  const dz = targetPosition.z - eyePosition.z;
  const horizontal = Math.hypot(dx, dz);
  const yaw = normalizeYaw((Math.atan2(-dx, dz) * 180) / Math.PI);
  const pitch = clampPitch((-Math.atan2(dy, horizontal) * 180) / Math.PI);
  return { yaw, pitch };
}

/** 站立实体的眼位。 */
export function eyePosition(footPosition: CombatVector3): CombatVector3 {
  return {
    x: footPosition.x,
    y: footPosition.y + EYE_HEIGHT,
    z: footPosition.z,
  };
}

export class RotationController {
  private readonly policy: CombatRotationPolicy;
  private readonly jitter: DeterministicJitter;

  constructor(
    policy: CombatRotationPolicy = DEFAULT_ROTATION_POLICY,
    jitterSeed = 0x5f3a_1c2d,
  ) {
    if (
      !Number.isFinite(policy.maxDegreesPerTick) ||
      policy.maxDegreesPerTick <= 0 ||
      policy.maxDegreesPerTick > 180 ||
      !Number.isFinite(policy.aimToleranceDegrees) ||
      policy.aimToleranceDegrees < 0 ||
      !Number.isFinite(policy.jitterDegrees) ||
      policy.jitterDegrees < 0 ||
      // 噪声不得大于容差，否则会自己把朝向抖出容差外来回摆动。
      policy.jitterDegrees > policy.aimToleranceDegrees
    ) {
      throw new TypeError("朝向策略越界，拒绝使用该策略。");
    }
    this.policy = policy;
    this.jitter = new DeterministicJitter(jitterSeed);
  }

  /**
   * 计算本帧朝向。有内部 PRNG 状态，所以逐帧调用序列是确定但有状态的
   * ——同一个 controller 从同一种子出发重放会得到同一串结果。
   */
  step(
    current: CombatOrientation,
    desired: CombatOrientation,
  ): CombatRotationStep {
    const currentYaw = normalizeYaw(current.yaw);
    const currentPitch = clampPitch(current.pitch);
    const deltaYaw = yawDelta(currentYaw, normalizeYaw(desired.yaw));
    const deltaPitch = clampPitch(desired.pitch) - currentPitch;
    const distance = Math.hypot(deltaYaw, deltaPitch);

    if (distance <= this.policy.aimToleranceDegrees) {
      // 已经够准：不再微调，这本身就是反检测措施。
      return {
        orientation: { yaw: currentYaw, pitch: currentPitch },
        remainingDegrees: distance,
        aimed: true,
        clamped: false,
      };
    }

    const clamped = distance > this.policy.maxDegreesPerTick;
    const scale = clamped ? this.policy.maxDegreesPerTick / distance : 1;
    const jitterYaw = this.policy.jitterDegrees * this.jitter.next();
    const jitterPitch = this.policy.jitterDegrees * this.jitter.next();
    const yaw = normalizeYaw(currentYaw + deltaYaw * scale + jitterYaw);
    const pitch = clampPitch(currentPitch + deltaPitch * scale + jitterPitch);
    const remaining = Math.hypot(
      yawDelta(yaw, normalizeYaw(desired.yaw)),
      clampPitch(desired.pitch) - pitch,
    );

    return {
      orientation: { yaw, pitch },
      remainingDegrees: remaining,
      aimed: remaining <= this.policy.aimToleranceDegrees,
      clamped,
    };
  }
}
