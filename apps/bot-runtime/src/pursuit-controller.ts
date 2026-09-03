// ---------------------------------------------------------------------------
// pursuit-controller.ts —— 持续追击（目标锁定 + GoalFollow + 攻击节奏）。
//
// 设计参考：PrismarineJS/mineflayer-pvp（MIT）的成熟战斗循环——动态
// GoalFollow 追实体、物理 tick 攻击判定（进 range 立即挥击+冷却）、
// entityGone/超视距 停止条件。clean-room：只取行为设计，实现独立。
//
// 与现有架构的关系：
//   - 战斗反应窗（8s/32 步）负责"被打的第一口"——本控制器在其后接管，
//     把"反应"升级为"追击"：目标锁定承诺窗内持续追踪（目标跑就追，
//     进 range 就打），直到目标死亡/超出脱离距离/承诺窗过期/L0 抢占。
//   - 运动租约：COMBAT 优先级（10）——压过 ESCAPE(20)/TASK(40)，让位
//     EMERGENCY(0)。脱离时释放，任务链由中断-恢复语义立即接管。
//   - L0 安全层仍在更上层（crit → 断线保号不受影响）。
// ---------------------------------------------------------------------------

/** 追击所需的最小 bot 面（测试替身同构）。 */
export interface PursuitBot {
  /** 目标实体视图（位置与有效性）。 */
  entityView(entityId: number): { x: number; y: number; z: number; alive: boolean } | null;
  /** 到目标的直线距离（格）。 */
  distanceTo(entityId: number): number | null;
  /** 对目标挥击（含攻击冷却判定由调用方或此函数内部处理）。 */
  attack(entityId: number): Promise<void> | void;
  /** 动态追踪寻路（GoalFollow 语义：目标移动自动重规划）。 */
  followTarget(entityId: number, range: number): void;
  stopFollowing(): void;
}

export interface PursuitDeps {
  readonly now: () => number;
  readonly log: (event: string, fields: Record<string, unknown>) => void;
  /** 获取 COMBAT 运动租约；被更高优先级持有时返回 null（追击让位）。 */
  readonly acquireLease: () => { release: (reason: string) => void } | null;
}

export interface PursuitOptions {
  /** 近战挥击距离（格）。mineflayer-pvp 默认 3.0。 */
  readonly attackRange?: number;
  /** 追击寻路的目标跟随距离（格，GoalFollow range）。 */
  readonly followRange?: number;
  /** 承诺窗（ms）：互相交火后锁定目标的时长；窗内目标跑了也追。 */
  readonly commitmentMs?: number;
  /** 脱离距离（格）：超过即放弃（服务端实体跟踪上限 128，取保守值）。 */
  readonly disengageDistance?: number;
  /** 攻击冷却下限（ms）——挥击间隔不小于此值（原版 1.9+ 攻击冷却节奏）。 */
  readonly attackCooldownMs?: number;
}

export type PursuitState =
  | "idle"
  | "pursuing"
  | "stopped_target_gone"
  | "stopped_too_far"
  | "stopped_commitment_expired"
  | "stopped_no_lease"
  | "stopped_external";

const DEFAULT_ATTACK_RANGE = 3.0;
const DEFAULT_FOLLOW_RANGE = 2;
const DEFAULT_COMMITMENT_MS = 25_000;
const DEFAULT_DISENGAGE_DISTANCE = 64;
const DEFAULT_ATTACK_COOLDOWN_MS = 625; // 1.9+ 满蓄力节奏

export class PursuitController {
  private state: PursuitState = "idle";
  private targetId: number | null = null;
  private lease: { release: (reason: string) => void } | null = null;
  private lastContactAtMs = 0;
  private lastSwingAtMs = 0;
  private readonly opts: Required<PursuitOptions>;

  constructor(
    private readonly bot: PursuitBot,
    private readonly deps: PursuitDeps,
    options: PursuitOptions = {},
  ) {
    this.opts = {
      attackRange: options.attackRange ?? DEFAULT_ATTACK_RANGE,
      followRange: options.followRange ?? DEFAULT_FOLLOW_RANGE,
      commitmentMs: options.commitmentMs ?? DEFAULT_COMMITMENT_MS,
      disengageDistance: options.disengageDistance ?? DEFAULT_DISENGAGE_DISTANCE,
      attackCooldownMs: options.attackCooldownMs ?? DEFAULT_ATTACK_COOLDOWN_MS,
    };
  }

  get currentState(): PursuitState {
    return this.state;
  }

  get currentTarget(): number | null {
    return this.targetId;
  }

  /** 进入追击：锁定目标并占用 COMBAT 运动租约。 */
  engage(targetId: number): boolean {
    if (this.state === "pursuing") return this.targetId === targetId;
    // 终态（stopped_*/idle）可重新进入（新一轮交火）。
    this.state = "idle";
    const lease = this.deps.acquireLease();
    if (lease === null) {
      this.state = "stopped_no_lease";
      this.deps.log("bot_runtime_pursuit_no_lease", { targetId });
      return false;
    }
    this.lease = lease;
    this.targetId = targetId;
    this.lastContactAtMs = this.deps.now();
    this.lastSwingAtMs = 0;
    this.state = "pursuing";
    this.bot.followTarget(targetId, this.opts.followRange);
    this.deps.log("bot_runtime_pursuit_engaged", {
      targetId,
      commitmentMs: this.opts.commitmentMs,
    });
    return true;
  }

  /**
   * 物理节奏驱动（调用方按战斗 tick 频率调用）：
   * 追踪中——进 range 挥击（冷却节奏）；出 range 由 GoalFollow 持续追；
   * 停止条件随时判定。返回 true = 仍在追击。
   */
  tick(): boolean {
    if (this.state !== "pursuing" || this.targetId === null) return false;
    const now = this.deps.now();
    const view = this.bot.entityView(this.targetId);
    if (view === null || !view.alive) {
      this.stop("stopped_target_gone");
      return false;
    }
    const distance = this.bot.distanceTo(this.targetId);
    if (distance === null) {
      this.stop("stopped_target_gone");
      return false;
    }
    if (distance > this.opts.disengageDistance) {
      this.stop("stopped_too_far");
      return false;
    }
    if (now - this.lastContactAtMs > this.opts.commitmentMs) {
      this.stop("stopped_commitment_expired");
      return false;
    }
    // 承诺窗刷新条件：贴身（还在缠斗）——跑了不刷新，追不上到时窗就收。
    if (distance <= this.opts.attackRange + 2) {
      this.lastContactAtMs = now;
    }
    if (distance <= this.opts.attackRange) {
      if (now - this.lastSwingAtMs >= this.opts.attackCooldownMs) {
        this.lastSwingAtMs = now;
        void this.bot.attack(this.targetId);
      }
      return true;
    }
    // 出 range：GoalFollow 已在追（engage 时设定），无需额外动作。
    return true;
  }

  /** 目标打了我们（无论距离）——刷新承诺窗（互火=继续锁）。 */
  onMutualContact(): void {
    if (this.state === "pursuing") this.lastContactAtMs = this.deps.now();
  }

  /** 外部停止（L0 抢占/断线/手动）。终态保留（stopped_*）供观测。 */
  stop(reason: string): void {
    if (this.state === "idle") return;
    try {
      this.bot.stopFollowing();
    } catch {
      /* 尽力而为 */
    }
    this.lease?.release(reason);
    this.lease = null;
    this.deps.log("bot_runtime_pursuit_stopped", {
      targetId: this.targetId,
      state: this.state,
      reason,
    });
    this.targetId = null;
    if (this.state === "pursuing") {
      this.state = reason.startsWith("stopped_") ? (reason as PursuitState) : "stopped_external";
    }
  }
}
