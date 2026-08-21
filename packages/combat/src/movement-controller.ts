/**
 * MovementController —— 规划级（P，≤1000ms）确定性战斗走位。零 AI。
 *
 * 只管一件事：**在交战中把自己放在正确的距离带上**。它不寻路、不跨区块导航
 * ——那是 §6 Baritone 参考的范畴，本模块只输出"这一刻该往哪个水平方向走"。
 * 垂直分量恒为 0：跳跃/爬升/落地缓冲是独立力学问题，硬塞进来只会得到一个
 * 什么都做不好的模块。
 *
 * 四条自我约束：
 *   1. **撤退优先于走位**（§4）。调用方给了撤退方向就照走，本模块不讨价还价，
 *      也不做"边打边退"这种含糊状态。
 *   2. **距离带是硬边界**。比内圈近就退（贴脸等于把自己送进敌方水晶范围），
 *      比外圈远就贴，带内只环绕。
 *   3. **危险方块一律不踩**。沿候选方向探一步，落点靠近注入的 hazard 就换向；
 *      两个环绕方向都不安全时如实返回 HOLD + blockedByHazard，绝不硬走。
 *   4. **环绕换向周期带抖动**（§7）。固定周期绕圈是明显机器特征；换向间隔由
 *      注入种子的确定性 PRNG 决定，可复现、可单测。
 *
 * **诚实边界**：抖动与换向只降低明显破绽，**不等于免疫封号**，残余风险由使用者
 * 承担（AGENTS.md §0.4 / tactics §7）。
 *
 * 时间与世界状态全部由调用方注入（`nowMs`、快照自带坐标），本模块从不读时钟。
 */

import { DeterministicJitter } from "./deterministic-jitter.js";
import type { CombatVector3 } from "./threat-analyzer.js";

export type CombatMovementIntent =
  | "HOLD"
  | "CLOSE_IN"
  | "BACK_OFF"
  | "STRAFE"
  | "DISENGAGE";

export type CombatMovementSnapshot = Readonly<{
  nowMs: number;
  selfPosition: CombatVector3;
  /** 目标脚位；观测不到时为 null，本模块随即返回 HOLD 而不是乱走。 */
  targetPosition: CombatVector3 | null;
  /** 已知危险方块（岩浆、虚空边缘、掉落坑）的坐标。空数组表示无已知危险。 */
  hazards: readonly CombatVector3[];
  /**
   * RetreatController 给出的撤离方向；非 null 时一切走位让位于它（§4）。
   * 为 null 表示当前不撤退。
   */
  retreatDirection: CombatVector3 | null;
}>;

export type CombatMovementPolicy = Readonly<{
  /** 内圈：比这更近就后退，避免贴脸吃水晶。 */
  minimumDistance: number;
  /** 外圈：比这更远就贴上去。 */
  maximumDistance: number;
  /** 探测落点用的步长（格）。 */
  stepProbeDistance: number;
  /** 落点距 hazard 小于此值视为不安全。 */
  hazardClearance: number;
  /** 距离超过此值才疾跑；贴脸疾跑会冲过头。 */
  sprintAboveDistance: number;
  /** 环绕换向的最小间隔（毫秒）。 */
  strafeFlipMinMs: number;
  /** 环绕换向的最大间隔（毫秒）；与最小值之间由确定性抖动取值。 */
  strafeFlipMaxMs: number;
}>;

export const DEFAULT_MOVEMENT_POLICY: CombatMovementPolicy = {
  // 3 格是近战可达距离，6 格是水晶有效半径：带内既能打到人，又不至于贴脸。
  minimumDistance: 3,
  maximumDistance: 5,
  stepProbeDistance: 1,
  hazardClearance: 1.5,
  sprintAboveDistance: 6,
  strafeFlipMinMs: 700,
  strafeFlipMaxMs: 1_800,
};

export type CombatMovementPlan = Readonly<{
  intent: CombatMovementIntent;
  /** 单位水平方向；无可行动作时为 null。y 恒为 0。 */
  direction: CombatVector3 | null;
  sprint: boolean;
  /** 与目标的当前距离；目标未知时为 null。 */
  distance: number | null;
  /** 本帧环绕方向：+1 / -1，非环绕时为 0。 */
  strafeSign: -1 | 0 | 1;
  /** 两个候选方向都撞 hazard，本帧放弃移动。 */
  blockedByHazard: boolean;
}>;

const HORIZONTAL_EPSILON = 1e-9;

function horizontalUnit(
  from: CombatVector3,
  to: CombatVector3,
): CombatVector3 | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const magnitude = Math.hypot(dx, dz);
  if (magnitude < HORIZONTAL_EPSILON) return null;
  return { x: dx / magnitude, y: 0, z: dz / magnitude };
}

function normalizeHorizontal(vector: CombatVector3): CombatVector3 | null {
  const magnitude = Math.hypot(vector.x, vector.z);
  if (magnitude < HORIZONTAL_EPSILON) return null;
  return { x: vector.x / magnitude, y: 0, z: vector.z / magnitude };
}

/** 水平右手法向：把朝向绕 Y 轴转 90°，用于环绕。 */
function perpendicular(direction: CombatVector3, sign: 1 | -1): CombatVector3 {
  return { x: -direction.z * sign, y: 0, z: direction.x * sign };
}

export class MovementController {
  private readonly policy: CombatMovementPolicy;
  private readonly jitter: DeterministicJitter;
  private strafeSign: 1 | -1 = 1;
  private nextFlipAtMs: number | null = null;

  constructor(
    policy: CombatMovementPolicy = DEFAULT_MOVEMENT_POLICY,
    jitterSeed = 0x2c1f_9a45,
  ) {
    if (
      !Number.isFinite(policy.minimumDistance) ||
      policy.minimumDistance <= 0 ||
      !Number.isFinite(policy.maximumDistance) ||
      policy.maximumDistance <= policy.minimumDistance ||
      !Number.isFinite(policy.stepProbeDistance) ||
      policy.stepProbeDistance <= 0 ||
      !Number.isFinite(policy.hazardClearance) ||
      policy.hazardClearance < 0 ||
      !Number.isFinite(policy.sprintAboveDistance) ||
      policy.sprintAboveDistance <= 0 ||
      !Number.isFinite(policy.strafeFlipMinMs) ||
      policy.strafeFlipMinMs <= 0 ||
      !Number.isFinite(policy.strafeFlipMaxMs) ||
      policy.strafeFlipMaxMs < policy.strafeFlipMinMs
    ) {
      throw new TypeError("走位策略越界，拒绝使用该策略。");
    }
    this.policy = policy;
    this.jitter = new DeterministicJitter(jitterSeed);
  }

  /** 换服或重连后必须清掉环绕相位，否则会拿上一场的时间戳判换向。 */
  reset(): void {
    this.strafeSign = 1;
    this.nextFlipAtMs = null;
  }

  /**
   * 计算本帧走位。有内部相位状态（环绕方向 + 换向计时），所以同一 controller
   * 从同一种子重放同一序列会得到同一串结果。
   */
  plan(snapshot: CombatMovementSnapshot): CombatMovementPlan {
    validateMovementSnapshot(snapshot);

    // §4：撤退压倒一切走位，不存在"边打边退"的中间态。
    if (snapshot.retreatDirection !== null) {
      const direction = normalizeHorizontal(snapshot.retreatDirection);
      const distance =
        snapshot.targetPosition === null
          ? null
          : Math.hypot(
              snapshot.targetPosition.x - snapshot.selfPosition.x,
              snapshot.targetPosition.z - snapshot.selfPosition.z,
            );
      return {
        intent: direction === null ? "HOLD" : "DISENGAGE",
        direction,
        // 撤退时永远疾跑：这是唯一不在乎冲过头的场景。
        sprint: direction !== null,
        distance,
        strafeSign: 0,
        blockedByHazard: false,
      };
    }

    if (snapshot.targetPosition === null) {
      return {
        intent: "HOLD",
        direction: null,
        sprint: false,
        distance: null,
        strafeSign: 0,
        blockedByHazard: false,
      };
    }

    const toTarget = horizontalUnit(
      snapshot.selfPosition,
      snapshot.targetPosition,
    );
    const distance = Math.hypot(
      snapshot.targetPosition.x - snapshot.selfPosition.x,
      snapshot.targetPosition.z - snapshot.selfPosition.z,
    );

    // 水平重合：方向未定义，宁可不动也不瞎选一个方向。
    if (toTarget === null) {
      return {
        intent: "HOLD",
        direction: null,
        sprint: false,
        distance,
        strafeSign: 0,
        blockedByHazard: false,
      };
    }

    if (distance < this.policy.minimumDistance) {
      return this.withHazardCheck(
        "BACK_OFF",
        { x: -toTarget.x, y: 0, z: -toTarget.z },
        null,
        snapshot,
        distance,
        0,
      );
    }
    if (distance > this.policy.maximumDistance) {
      return this.withHazardCheck(
        "CLOSE_IN",
        toTarget,
        null,
        snapshot,
        distance,
        distance > this.policy.sprintAboveDistance ? 1 : 0,
      );
    }

    // 带内：环绕。两个方向都试，先试当前相位。
    const sign = this.advanceStrafeSign(snapshot.nowMs);
    return this.withHazardCheck(
      "STRAFE",
      perpendicular(toTarget, sign),
      perpendicular(toTarget, sign === 1 ? -1 : 1),
      snapshot,
      distance,
      0,
      sign,
    );
  }

  /**
   * 环绕相位推进。到点才换向，换向间隔在 [min, max] 之间由确定性抖动取值
   * ——固定周期绕圈是最好认的机器特征之一（§7）。
   */
  private advanceStrafeSign(nowMs: number): 1 | -1 {
    if (this.nextFlipAtMs === null) {
      this.nextFlipAtMs = nowMs + this.flipIntervalMs();
      return this.strafeSign;
    }
    if (nowMs >= this.nextFlipAtMs) {
      this.strafeSign = this.strafeSign === 1 ? -1 : 1;
      this.nextFlipAtMs = nowMs + this.flipIntervalMs();
    }
    return this.strafeSign;
  }

  private flipIntervalMs(): number {
    const span = this.policy.strafeFlipMaxMs - this.policy.strafeFlipMinMs;
    // next() 落在 [-1, 1)，折成 [0, 1) 再线性映射。
    const unit = (this.jitter.next() + 1) / 2;
    return this.policy.strafeFlipMinMs + span * unit;
  }

  /**
   * 沿候选方向探一步，落点撞 hazard 就换 `fallback`。两个都不安全时返回
   * HOLD + blockedByHazard——如实说走不了，不硬走进岩浆。
   */
  private withHazardCheck(
    intent: CombatMovementIntent,
    primary: CombatVector3,
    fallback: CombatVector3 | null,
    snapshot: CombatMovementSnapshot,
    distance: number,
    sprint: 0 | 1,
    strafeSign: -1 | 0 | 1 = 0,
  ): CombatMovementPlan {
    if (this.isStepSafe(primary, snapshot)) {
      return {
        intent,
        direction: primary,
        sprint: sprint === 1,
        distance,
        strafeSign,
        blockedByHazard: false,
      };
    }
    if (fallback !== null && this.isStepSafe(fallback, snapshot)) {
      // 环绕撞墙就反向绕，同时把相位记住，别下一帧又撞回去。
      const flipped: -1 | 0 | 1 =
        strafeSign === 0 ? 0 : strafeSign === 1 ? -1 : 1;
      if (flipped === 1 || flipped === -1) this.strafeSign = flipped;
      return {
        intent,
        direction: fallback,
        sprint: sprint === 1,
        distance,
        strafeSign: flipped,
        blockedByHazard: false,
      };
    }
    return {
      intent: "HOLD",
      direction: null,
      sprint: false,
      distance,
      strafeSign: 0,
      blockedByHazard: true,
    };
  }

  private isStepSafe(
    direction: CombatVector3,
    snapshot: CombatMovementSnapshot,
  ): boolean {
    if (snapshot.hazards.length === 0) return true;
    const step = {
      x: snapshot.selfPosition.x + direction.x * this.policy.stepProbeDistance,
      y: snapshot.selfPosition.y,
      z: snapshot.selfPosition.z + direction.z * this.policy.stepProbeDistance,
    };
    for (const hazard of snapshot.hazards) {
      // 只比水平距离：脚下岩浆和头顶岩浆的处置不同，垂直判定不属于本模块。
      const gap = Math.hypot(step.x - hazard.x, step.z - hazard.z);
      if (gap < this.policy.hazardClearance) return false;
    }
    return true;
  }
}

function validateMovementSnapshot(snapshot: CombatMovementSnapshot): void {
  if (!Number.isFinite(snapshot.nowMs)) {
    throw new TypeError("nowMs 必须是有限数。");
  }
  validateVector(snapshot.selfPosition, "selfPosition");
  if (snapshot.targetPosition !== null) {
    validateVector(snapshot.targetPosition, "targetPosition");
  }
  if (snapshot.retreatDirection !== null) {
    validateVector(snapshot.retreatDirection, "retreatDirection");
  }
  for (const hazard of snapshot.hazards) {
    validateVector(hazard, "hazard");
  }
}

function validateVector(vector: CombatVector3, name: string): void {
  if (
    !Number.isFinite(vector.x) ||
    !Number.isFinite(vector.y) ||
    !Number.isFinite(vector.z)
  ) {
    throw new TypeError(`${name} 必须是有限向量。`);
  }
}
