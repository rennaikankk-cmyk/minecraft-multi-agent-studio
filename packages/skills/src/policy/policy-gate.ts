import {
  MINECRAFT_TICK_MS,
  type ServerPolicy,
  type ServerPolicyLimits,
} from "./server-policy.js";

// ---------------------------------------------------------------------------
// ServerPolicyGate —— 一切受限动作的确定性闸门。
//
// 反射层（战斗/放置/挖掘）不直接决定"能不能这么做"，而是先问这个闸门。
// 闸门是纯确定性的：同样的输入 + 同样的时钟读数 → 同样的裁决，可离线单测，
// 不含随机、不含 IO、不调用模型。
//
// 设计要点：
//   - 拒绝时给稳定错误码，便于日志判定与失败分类，不返回自由文本。
//   - 频率限制用滑动窗口计数（每类动作独立窗口），而不是"上次调用至今"，
//     否则 8 CPS 限额会被"每次都刚好卡在间隔上"绕过。
//   - `minActionIntervalMs` 是跨类别的全局间隔，专门抹掉亚 tick 完美连招。
//   - 旋转限额按 tick 折算：调用方给出上次朝向、目标朝向和经过的毫秒数，
//     闸门算出这段时间**允许**的最大角度，超出则给出被夹取后的安全朝向，
//     而不是简单拒绝——转头本身不该失败，该被限速。
// ---------------------------------------------------------------------------

export const policyActionKinds = [
  "attack",
  "place",
  "dig-start",
  "hotbar-switch",
] as const;

export type PolicyActionKind = (typeof policyActionKinds)[number];

export type PolicyDenialCode =
  | "POLICY_REACH_EXCEEDED"
  | "POLICY_ATTACK_REACH_EXCEEDED"
  | "POLICY_RATE_EXCEEDED"
  | "POLICY_ACTION_INTERVAL_TOO_SHORT"
  | "POLICY_SPRINT_FORBIDDEN"
  | "POLICY_JUMP_FORBIDDEN"
  | "POLICY_SPRINT_JUMP_FORBIDDEN"
  | "POLICY_AIR_STRAFE_FORBIDDEN"
  | "POLICY_FALL_TOO_FAR";

export type PolicyDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; errorCode: PolicyDenialCode }>;

const ALLOWED: PolicyDecision = Object.freeze({ allowed: true as const });

function deny(errorCode: PolicyDenialCode): PolicyDecision {
  return Object.freeze({ allowed: false as const, errorCode });
}

function rateLimitFor(
  limits: ServerPolicyLimits,
  kind: PolicyActionKind,
): number {
  switch (kind) {
    case "attack":
      return limits.maxAttacksPerSecond;
    case "place":
      return limits.maxPlacementsPerSecond;
    case "dig-start":
      return limits.maxDigStartsPerSecond;
    case "hotbar-switch":
      return limits.maxHotbarSwitchesPerSecond;
  }
}

/** 目标朝向被策略夹取后的实际可用朝向。 */
export type ClampedRotation = Readonly<{
  yaw: number;
  pitch: number;
  /** true 表示目标朝向超过了本段时间的允许角度，已被限速。 */
  clamped: boolean;
}>;

/** 把角度差归一到 (-180, 180]，避免 359°→1° 被算成转了 358°。 */
function normalizeDegrees(delta: number): number {
  const wrapped = ((delta + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

function clampMagnitude(delta: number, limit: number): number {
  if (delta > limit) return limit;
  if (delta < -limit) return -limit;
  return delta;
}

export class ServerPolicyGate {
  /** 每类动作各自的时间戳窗口（毫秒），只保留最近 1 秒内的记录。 */
  private readonly windows = new Map<PolicyActionKind, number[]>();
  private lastActionAtMs: number | null = null;

  constructor(private readonly policy: ServerPolicy) {}

  get serverProfileId(): string {
    return this.policy.serverProfileId;
  }

  get limits(): ServerPolicyLimits {
    return this.policy.limits;
  }

  /** 方块交互（放置/挖掘/开箱）距离检查。 */
  checkBlockReach(distance: number): PolicyDecision {
    if (!Number.isFinite(distance) || distance < 0) {
      return deny("POLICY_REACH_EXCEEDED");
    }
    return distance <= this.policy.limits.blockInteractionReach
      ? ALLOWED
      : deny("POLICY_REACH_EXCEEDED");
  }

  /** 实体攻击距离检查。 */
  checkAttackReach(distance: number): PolicyDecision {
    if (!Number.isFinite(distance) || distance < 0) {
      return deny("POLICY_ATTACK_REACH_EXCEEDED");
    }
    return distance <= this.policy.limits.entityAttackReach
      ? ALLOWED
      : deny("POLICY_ATTACK_REACH_EXCEEDED");
  }

  /**
   * 频率与全局间隔检查。**只检查不记账**，便于"先问能不能做、真做了再记"，
   * 避免被拒绝的尝试也占用配额。
   */
  checkActionRate(kind: PolicyActionKind, nowMs: number): PolicyDecision {
    if (!Number.isFinite(nowMs)) return deny("POLICY_RATE_EXCEEDED");
    if (
      this.lastActionAtMs !== null &&
      nowMs - this.lastActionAtMs < this.policy.limits.minActionIntervalMs
    ) {
      return deny("POLICY_ACTION_INTERVAL_TOO_SHORT");
    }
    const window = this.windows.get(kind) ?? [];
    const recent = window.filter((timestamp) => nowMs - timestamp < 1_000);
    return recent.length < rateLimitFor(this.policy.limits, kind)
      ? ALLOWED
      : deny("POLICY_RATE_EXCEEDED");
  }

  /** 记录一次**实际执行**的动作，占用其配额。 */
  recordAction(kind: PolicyActionKind, nowMs: number): void {
    if (!Number.isFinite(nowMs)) return;
    const window = this.windows.get(kind) ?? [];
    const recent = window.filter((timestamp) => nowMs - timestamp < 1_000);
    recent.push(nowMs);
    this.windows.set(kind, recent);
    this.lastActionAtMs =
      this.lastActionAtMs === null ? nowMs : Math.max(this.lastActionAtMs, nowMs);
  }

  /**
   * 把目标朝向夹取到本段时间允许的角速度以内。`elapsedMs` 是距上一次
   * 朝向更新的实际间隔；不足一 tick 时按一 tick 计（不给亚 tick 加速）。
   */
  clampRotation(
    current: Readonly<{ yaw: number; pitch: number }>,
    target: Readonly<{ yaw: number; pitch: number }>,
    elapsedMs: number,
  ): ClampedRotation {
    const ticks = Math.max(
      1,
      Number.isFinite(elapsedMs) && elapsedMs > 0
        ? Math.floor(elapsedMs / MINECRAFT_TICK_MS) || 1
        : 1,
    );
    const yawBudget = this.policy.limits.maxYawDeltaPerTick * ticks;
    const pitchBudget = this.policy.limits.maxPitchDeltaPerTick * ticks;
    const yawDelta = normalizeDegrees(target.yaw - current.yaw);
    const pitchDelta = target.pitch - current.pitch;
    const clampedYawDelta = clampMagnitude(yawDelta, yawBudget);
    const clampedPitchDelta = clampMagnitude(pitchDelta, pitchBudget);
    return Object.freeze({
      yaw: normalizeDegrees(current.yaw + clampedYawDelta),
      pitch: Math.max(-90, Math.min(90, current.pitch + clampedPitchDelta)),
      clamped:
        clampedYawDelta !== yawDelta || clampedPitchDelta !== pitchDelta,
    });
  }

  /** 移动约束检查。 */
  checkMovement(
    request: Readonly<{
      sprint: boolean;
      jump: boolean;
      airStrafe: boolean;
      fallBlocks: number;
    }>,
  ): PolicyDecision {
    if (request.sprint && !this.policy.limits.allowSprint) {
      return deny("POLICY_SPRINT_FORBIDDEN");
    }
    if (request.jump && !this.policy.limits.allowJump) {
      return deny("POLICY_JUMP_FORBIDDEN");
    }
    if (
      request.sprint &&
      request.jump &&
      !this.policy.limits.allowSprintJumpCombo
    ) {
      return deny("POLICY_SPRINT_JUMP_FORBIDDEN");
    }
    if (request.airStrafe && !this.policy.limits.allowAirStrafe) {
      return deny("POLICY_AIR_STRAFE_FORBIDDEN");
    }
    if (
      !Number.isFinite(request.fallBlocks) ||
      request.fallBlocks > this.policy.limits.maxFallBlocks
    ) {
      return deny("POLICY_FALL_TOO_FAR");
    }
    return ALLOWED;
  }
}
