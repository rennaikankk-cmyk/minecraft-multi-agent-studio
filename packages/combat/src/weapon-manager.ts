/**
 * WeaponManager —— 战术级（T，≤200ms）确定性武器选择与挥击时机。零 AI。
 *
 * docs/combat-tactics-reference.md §5：**必须尊重攻击冷却**。1.9+ 的伤害随冷却
 * 恢复度缩放，冷却没满就砍等于主动降低 DPS，同时"每 tick 一刀"是最明显的
 * bot 特征之一。所以这里的输出不是"能不能打"，而是"现在这一刀值不值得"。
 *
 * 选武器只看确定性数据：伤害、耐久、附魔加成。**耐久保护**是硬规则——低于阈值
 * 的装备不参与选择，避免把附魔武器打碎在一场普通遭遇里。全部候选都被耐久排除
 * 时如实返回 null，不偷偷降级用手打。
 *
 * 所有时间都由调用方以 `nowMs` 传入：本模块从不读时钟，方便单测逐帧推进。
 */

export type CombatWeaponKind = "sword" | "axe" | "trident" | "other";

export type CombatWeaponCandidate = Readonly<{
  /** 背包槽位号，用于回传给 equip 动作。 */
  slot: number;
  itemName: string;
  kind: CombatWeaponKind;
  /** 基础攻击伤害（半心为 1）。 */
  baseDamage: number;
  /** 冷却完全恢复所需毫秒。由物品属性决定，调用方给。 */
  fullCooldownMs: number;
  /** 剩余耐久；null 表示不可损耗。 */
  durabilityRemaining: number | null;
  /** 锋利/致伤等直接加伤附魔的等效额外伤害。 */
  enchantmentDamageBonus: number;
}>;

export type CombatWeaponPolicy = Readonly<{
  /** 耐久低于此值的武器不再参战，保护附魔装备。 */
  minimumDurability: number;
  /**
   * 冷却恢复度达到此比例才认为这一刀值得挥。1 表示只在满冷却时攻击。
   * 低于 0.85 会明显降低 DPS，所以下限锁在 0.85。
   */
  minimumCooldownRatio: number;
}>;

export const DEFAULT_WEAPON_POLICY: CombatWeaponPolicy = {
  minimumDurability: 30,
  minimumCooldownRatio: 0.9,
};

export type CombatWeaponSelection = Readonly<{
  /** 选中的武器；全部被耐久排除时为 null。 */
  weapon: CombatWeaponCandidate | null;
  /** 有效伤害 = 基础 + 附魔。用于排序，也便于遥测。 */
  effectiveDamage: number;
  /** 因耐久保护被排除的槽位。 */
  excludedSlots: readonly number[];
}>;

export type CombatSwingDecision = Readonly<{
  /** 本次判定是否应该挥击。 */
  shouldAttack: boolean;
  /** 冷却恢复度，[0, 1]。 */
  cooldownRatio: number;
  /** 不打时距下一次可打还差多少毫秒；可打时为 0。 */
  waitMs: number;
  reason: "READY" | "COOLDOWN" | "NO_WEAPON" | "OUT_OF_RANGE";
}>;

/** 冷却比例的下限：再低就是主动放弃伤害。 */
const MIN_ALLOWED_COOLDOWN_RATIO = 0.85;

export class WeaponManager {
  private readonly policy: CombatWeaponPolicy;
  private lastSwingAtMs: number | null = null;
  private lastSwingCooldownMs = 0;

  constructor(policy: CombatWeaponPolicy = DEFAULT_WEAPON_POLICY) {
    if (
      !Number.isFinite(policy.minimumDurability) ||
      policy.minimumDurability < 0 ||
      !Number.isFinite(policy.minimumCooldownRatio) ||
      policy.minimumCooldownRatio < MIN_ALLOWED_COOLDOWN_RATIO ||
      policy.minimumCooldownRatio > 1
    ) {
      throw new TypeError("武器策略越界，拒绝使用该策略。");
    }
    this.policy = policy;
  }

  /** 换服或重连后必须清空冷却记忆，否则会拿上一场的时间戳判定。 */
  reset(): void {
    this.lastSwingAtMs = null;
    this.lastSwingCooldownMs = 0;
  }

  /**
   * 纯函数：按有效伤害选最优武器，先过耐久保护。
   * 同伤害时取槽位号小的，保证结果稳定可测。
   */
  select(
    candidates: readonly CombatWeaponCandidate[],
  ): CombatWeaponSelection {
    const excludedSlots: number[] = [];
    let best: CombatWeaponCandidate | null = null;
    let bestDamage = -1;

    for (const candidate of candidates) {
      if (
        !Number.isFinite(candidate.baseDamage) ||
        candidate.baseDamage < 0 ||
        !Number.isFinite(candidate.fullCooldownMs) ||
        candidate.fullCooldownMs <= 0
      ) {
        throw new TypeError("武器候选的伤害或冷却数据非法。");
      }
      if (
        candidate.durabilityRemaining !== null &&
        candidate.durabilityRemaining < this.policy.minimumDurability
      ) {
        excludedSlots.push(candidate.slot);
        continue;
      }
      const damage = candidate.baseDamage + candidate.enchantmentDamageBonus;
      if (damage > bestDamage || (damage === bestDamage && best !== null && candidate.slot < best.slot)) {
        best = candidate;
        bestDamage = damage;
      }
    }

    return {
      weapon: best,
      effectiveDamage: best ? bestDamage : 0,
      excludedSlots,
    };
  }

  /**
   * 判断此刻该不该挥。`targetInReach` 由调用方按当前 ServerPolicy 的 reach
   * 算好传入——本模块不内置 4.5 格常量，策略档位变了行为必须跟着变。
   */
  evaluateSwing(
    weapon: CombatWeaponCandidate | null,
    nowMs: number,
    targetInReach: boolean,
  ): CombatSwingDecision {
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("nowMs 必须是有限数。");
    }
    if (!weapon) {
      return {
        shouldAttack: false,
        cooldownRatio: 0,
        waitMs: 0,
        reason: "NO_WEAPON",
      };
    }

    const ratio = this.cooldownRatio(nowMs);
    if (!targetInReach) {
      // 先报 reach 失败：够不到时冷却多少都无意义。
      return {
        shouldAttack: false,
        cooldownRatio: ratio,
        waitMs: 0,
        reason: "OUT_OF_RANGE",
      };
    }
    if (ratio < this.policy.minimumCooldownRatio) {
      const needMs = this.lastSwingCooldownMs * this.policy.minimumCooldownRatio;
      const elapsed = nowMs - (this.lastSwingAtMs ?? nowMs);
      return {
        shouldAttack: false,
        cooldownRatio: ratio,
        waitMs: Math.max(0, Math.ceil(needMs - elapsed)),
        reason: "COOLDOWN",
      };
    }
    return {
      shouldAttack: true,
      cooldownRatio: ratio,
      waitMs: 0,
      reason: "READY",
    };
  }

  /** 记录一次实际挥击。只有真的打出去才调用，否则冷却记账会失真。 */
  recordSwing(weapon: CombatWeaponCandidate, nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("nowMs 必须是有限数。");
    }
    if (this.lastSwingAtMs !== null && nowMs < this.lastSwingAtMs) {
      // 时间倒流意味着调用方混用了两个时钟源，拒绝记账而不是静默接受。
      throw new RangeError("挥击时间早于上一次挥击，拒绝记账。");
    }
    this.lastSwingAtMs = nowMs;
    this.lastSwingCooldownMs = weapon.fullCooldownMs;
  }

  /** 冷却恢复度，[0, 1]。没打过则视为完全恢复。 */
  cooldownRatio(nowMs: number): number {
    if (this.lastSwingAtMs === null || this.lastSwingCooldownMs <= 0) return 1;
    const elapsed = nowMs - this.lastSwingAtMs;
    if (elapsed <= 0) return 0;
    return Math.min(1, elapsed / this.lastSwingCooldownMs);
  }
}
