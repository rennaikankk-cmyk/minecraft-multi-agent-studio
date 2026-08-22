/**
 * TotemManager —— 反射级（R，≤50ms）图腾补位。零 AI。**反射层最高抢占项。**
 *
 * tactics §1：不死图腾握在副手时致命伤会被免掉，图腾一旦被消耗必须在同帧或
 * 下一帧补回副手，否则连击直接致死。所以这里的输出优先级**高于一切**——攻击、
 * 走位、放水晶全部让路。
 *
 * 四条纪律：
 *   1. **时序未放行不得上真实对抗**（AGENTS.md §0.6）。`decide()` 允许在探针之前
 *      调用并单测，但 `decideForLiveCombat()` 会在未放行时抛
 *      CombatReflexNotClearedError，绝不静默降级成"先打着看"。
 *   2. **事件驱动，不轮询**。调用方在副手槽变化 / 生命骤降事件上调用本模块；
 *      本模块只做纯判定，不自己起定时器、不读时钟（`nowMs` 由调用方给）。
 *   3. **没图腾就撤，不硬撑**。背包也没有 → 返回 RETREAT 意图交给
 *      RetreatController / L0 存活逻辑，不返回"继续战斗"。**除非**该 bot 被显式
 *      配置成 `expendable`（见 survival-stance.ts）：服务器上确实存在从不带图腾、
 *      允许送死的 bot，对它们来说「没图腾」是常态而不是失败降级，硬判撤退会让
 *      它永远开不出第一枪。默认仍是 `preserve-life`。
 *   4. **预防性补位**。生命低于阈值时即便副手已有图腾也确认一次，避免刚被打空
 *      就吃第二次致命伤。
 */

import {
  CombatReflexNotClearedError,
  type CombatReflexDecision,
} from "./reflex-clearance.js";
import {
  DEFAULT_SURVIVAL_STANCE,
  totemAbsenceForcesRetreat,
  validateSurvivalStance,
  type CombatSurvivalStance,
} from "./survival-stance.js";

export type CombatTotemSnapshot = Readonly<{
  nowMs: number;
  /** 副手当前是否是图腾。 */
  offhandIsTotem: boolean;
  /** 背包中可用于补位的图腾数（不含副手那一个）。 */
  inventoryTotemCount: number;
  selfHealth: number;
  /** 是否正在交战；决定"没图腾"是撤退还是补货。 */
  engaged: boolean;
}>;

export type CombatTotemPolicy = Readonly<{
  /** 生命低于此值时做预防性确认。 */
  preemptiveHealthThreshold: number;
  /**
   * 两次补位之间的最小间隔（毫秒）。0 表示不节流。
   * 存在的意义是防止事件风暴把同一次消耗重复补位多次。
   */
  minimumReequipIntervalMs: number;
  /**
   * 存活立场。`expendable` 时「完全没有图腾」不再触发 RETREAT，而是当作常态
   * 放行。**只影响这一条**：有图腾时的补位与预防性确认逻辑完全不变。
   */
  stance: CombatSurvivalStance;
}>;

export const DEFAULT_TOTEM_POLICY: CombatTotemPolicy = {
  // 10 点 = 半血：tactics §1 给的预防性阈值。
  preemptiveHealthThreshold: 10,
  // 一个 tick：同一帧内的重复事件不应触发两次补位。
  minimumReequipIntervalMs: 50,
  // 保命是默认值，不是可选项。
  stance: DEFAULT_SURVIVAL_STANCE,
};

export type CombatTotemAction = "NONE" | "REEQUIP_OFFHAND" | "RETREAT";

export type CombatTotemReason =
  | "OFFHAND_EMPTY"
  | "PREEMPTIVE_CHECK"
  | "NO_TOTEM_AVAILABLE"
  | "FIGHTING_WITHOUT_TOTEM"
  | "ALREADY_HELD"
  | "THROTTLED";

export type CombatTotemDecision = Readonly<{
  action: CombatTotemAction;
  reason: CombatTotemReason;
  /**
   * 本决策是否抢占其他一切动作。补位时为 true —— 调用方必须先执行它。
   */
  preempts: boolean;
  /** 补位后剩余可用图腾数（含本次消耗后的背包余量）。 */
  totemsRemainingAfter: number;
}>;

export class TotemManager {
  private readonly policy: CombatTotemPolicy;
  private lastReequipAtMs: number | null = null;

  constructor(policy: CombatTotemPolicy = DEFAULT_TOTEM_POLICY) {
    if (
      !Number.isFinite(policy.preemptiveHealthThreshold) ||
      policy.preemptiveHealthThreshold < 0 ||
      !Number.isFinite(policy.minimumReequipIntervalMs) ||
      policy.minimumReequipIntervalMs < 0
    ) {
      throw new TypeError("图腾策略越界，拒绝使用该策略。");
    }
    validateSurvivalStance(policy.stance);
    this.policy = policy;
  }

  /** 换服或重连后必须清掉节流记忆，否则会拿上一场的时间戳压制补位。 */
  reset(): void {
    this.lastReequipAtMs = null;
  }

  /**
   * 纯判定，探针之前即可调用与单测。**不足以授权真实对抗**——真实对抗走
   * `decideForLiveCombat`。
   */
  decide(snapshot: CombatTotemSnapshot): CombatTotemDecision {
    validateTotemSnapshot(snapshot);

    const hasSpare = snapshot.inventoryTotemCount > 0;

    if (!snapshot.offhandIsTotem) {
      if (!hasSpare) {
        if (!totemAbsenceForcesRetreat(this.policy.stance)) {
          // 可弃 bot：没图腾是常态，不抢占、不撤退，让攻击链正常往下走。
          // 仍然如实报出原因码，运维能在遥测里看见"它现在裸着打"。
          return {
            action: "NONE",
            reason: "FIGHTING_WITHOUT_TOTEM",
            preempts: false,
            totemsRemainingAfter: 0,
          };
        }
        // 背包也空了：这是 §1 的失败降级，交给撤退/L0，不假装还能打。
        return {
          action: "RETREAT",
          reason: "NO_TOTEM_AVAILABLE",
          preempts: true,
          totemsRemainingAfter: 0,
        };
      }
      if (this.throttled(snapshot.nowMs)) {
        return {
          action: "NONE",
          reason: "THROTTLED",
          preempts: false,
          totemsRemainingAfter: snapshot.inventoryTotemCount,
        };
      }
      return {
        action: "REEQUIP_OFFHAND",
        reason: "OFFHAND_EMPTY",
        preempts: true,
        totemsRemainingAfter: snapshot.inventoryTotemCount - 1,
      };
    }

    // 副手已有图腾：低血时仍做一次预防性确认，但不消耗背包余量。
    if (
      snapshot.engaged &&
      snapshot.selfHealth <= this.policy.preemptiveHealthThreshold
    ) {
      return {
        action: "NONE",
        reason: "PREEMPTIVE_CHECK",
        preempts: false,
        totemsRemainingAfter: snapshot.inventoryTotemCount,
      };
    }

    return {
      action: "NONE",
      reason: "ALREADY_HELD",
      preempts: false,
      totemsRemainingAfter: snapshot.inventoryTotemCount,
    };
  }

  /**
   * 真实对抗入口：时序未放行直接抛，不返回一个"看起来可用"的决策。
   * 这是 AGENTS.md §0.6 那道闸门在代码里的落点。
   */
  decideForLiveCombat(
    snapshot: CombatTotemSnapshot,
    clearance: CombatReflexDecision,
  ): CombatTotemDecision {
    if (!clearance.cleared) {
      throw new CombatReflexNotClearedError(clearance.denial ?? "NO_PROBE_DATA");
    }
    return this.decide(snapshot);
  }

  /** 记录一次实际补位。只有真的换上去才调用，否则节流记账会失真。 */
  recordReequip(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("nowMs 必须是有限数。");
    }
    if (this.lastReequipAtMs !== null && nowMs < this.lastReequipAtMs) {
      // 时间倒流意味着调用方混用了两个时钟源，拒绝记账而不是静默接受。
      throw new RangeError("补位时间早于上一次补位，拒绝记账。");
    }
    this.lastReequipAtMs = nowMs;
  }

  private throttled(nowMs: number): boolean {
    if (this.lastReequipAtMs === null) return false;
    if (this.policy.minimumReequipIntervalMs === 0) return false;
    return nowMs - this.lastReequipAtMs < this.policy.minimumReequipIntervalMs;
  }
}

function validateTotemSnapshot(snapshot: CombatTotemSnapshot): void {
  if (!Number.isFinite(snapshot.nowMs)) {
    throw new TypeError("nowMs 必须是有限数。");
  }
  if (!Number.isFinite(snapshot.selfHealth) || snapshot.selfHealth < 0) {
    throw new TypeError("selfHealth 必须是非负有限数。");
  }
  if (
    !Number.isInteger(snapshot.inventoryTotemCount) ||
    snapshot.inventoryTotemCount < 0
  ) {
    throw new TypeError("inventoryTotemCount 必须是非负整数。");
  }
}
