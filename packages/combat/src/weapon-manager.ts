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
 * **远程与近战按距离分工**（tactics §5）。原来这里只有近战模型，弓弩在射程外
 * 完全无法表达，够不到就只剩 OUT_OF_RANGE。现在按目标距离分档选武器：
 *   - 近战窗口内优先近战：DPS 更高，且拉弓期间移速被拖慢，贴身拉弓是白给。
 *   - 近战窗口外用远程：弓需要蓄力到阈值才放（未满蓄力伤害与精度都差，且
 *     "一按就放"是很明显的 bot 特征）；弩可以预上弦，装填完成即可即时射出。
 * 弹药耗尽的远程武器不参与选择 —— 和耐久保护同一个道理，不返回一个放不出去的
 * 武器让调用方自己发现。
 *
 * 抛射物需要提前量，但**提前量不在这里算**：本模块只回答"用哪把、现在能不能
 * 放"，落点预测是 PredictionEngine 的事，由调用方把两者接起来。
 *
 * 所有时间都由调用方以 `nowMs` 传入：本模块从不读时钟，方便单测逐帧推进。
 */

export type CombatWeaponKind =
  | "sword"
  | "axe"
  | "trident"
  | "bow"
  | "crossbow"
  | "other";

/** 需要弹药与蓄力/装填的远程武器。 */
const RANGED_KINDS: ReadonlySet<CombatWeaponKind> = new Set([
  "bow",
  "crossbow",
]);

export function isRangedWeapon(kind: CombatWeaponKind): boolean {
  return RANGED_KINDS.has(kind);
}

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
  /**
   * 远程武器的可用弹药数；近战武器为 null。0 表示放不出去，会被排除。
   * 由调用方点算背包，本模块不猜。
   */
  ammoRemaining?: number | null;
  /**
   * 蓄满弓 / 装填弩所需毫秒。远程武器必填，近战忽略。
   * 原版满蓄力约 1000ms、快速装填前的弩约 1250ms，具体由调用方按附魔给。
   */
  drawTimeMs?: number;
  /** 该武器的有效射程（格）。远程武器必填，近战忽略。 */
  effectiveRange?: number;
}>;

export type CombatWeaponPolicy = Readonly<{
  /** 耐久低于此值的武器不再参战，保护附魔装备。 */
  minimumDurability: number;
  /**
   * 冷却恢复度达到此比例才认为这一刀值得挥。1 表示只在满冷却时攻击。
   * 低于 0.85 会明显降低 DPS，所以下限锁在 0.85。
   */
  minimumCooldownRatio: number;
  /**
   * 近战优先窗口（格）。目标在此距离内一律用近战 —— 贴身拉弓移速被拖慢，
   * 是纯亏。稍大于原版 3 格攻击距离，留一点接近的余量。
   */
  meleePreferredRange: number;
  /**
   * 弓的最小蓄力比例，[0.3, 1]。未满蓄力伤害与精度都差，且"一按就放"是明显的
   * bot 特征。1 表示只在满蓄力时松手。
   */
  minimumDrawRatio: number;
}>;

export const DEFAULT_WEAPON_POLICY: CombatWeaponPolicy = {
  minimumDurability: 30,
  minimumCooldownRatio: 0.9,
  // 4 格：原版近战 3 格加一点接近余量。
  meleePreferredRange: 4,
  // 0.85 蓄力已接近满伤，再等下去容易错过窗口。
  minimumDrawRatio: 0.85,
};

/** 弓蓄力比例的下限：再低就是白放一箭。 */
const MIN_ALLOWED_DRAW_RATIO = 0.3;

export type CombatWeaponSelection = Readonly<{
  /** 选中的武器；全部被耐久排除时为 null。 */
  weapon: CombatWeaponCandidate | null;
  /** 有效伤害 = 基础 + 附魔。用于排序，也便于遥测。 */
  effectiveDamage: number;
  /** 因耐久保护被排除的槽位。 */
  excludedSlots: readonly number[];
  /** 因弹药耗尽被排除的槽位；与耐久分开报，便于诊断"为什么不用弓"。 */
  outOfAmmoSlots: readonly number[];
  /** 本次选择走的是近战还是远程；无武器时为 null。 */
  mode: "melee" | "ranged" | null;
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

export type CombatRangedAction = "DRAW" | "HOLD" | "RELEASE" | "NONE";

export type CombatRangedDecision = Readonly<{
  action: CombatRangedAction;
  /** 蓄力/装填完成度，[0, 1]。 */
  drawRatio: number;
  /** 距可以松手还差多少毫秒；可放时为 0。 */
  waitMs: number;
  reason:
    | "RELEASE_READY"
    | "DRAWING"
    | "NOT_DRAWING"
    | "NO_WEAPON"
    | "NOT_RANGED"
    | "OUT_OF_AMMO"
    | "OUT_OF_RANGE"
    | "TOO_CLOSE";
}>;

/** 冷却比例的下限：再低就是主动放弃伤害。 */
const MIN_ALLOWED_COOLDOWN_RATIO = 0.85;

export class WeaponManager {
  private readonly policy: CombatWeaponPolicy;
  private lastSwingAtMs: number | null = null;
  private lastSwingCooldownMs = 0;
  private drawStartedAtMs: number | null = null;

  constructor(policy: CombatWeaponPolicy = DEFAULT_WEAPON_POLICY) {
    if (
      !Number.isFinite(policy.minimumDurability) ||
      policy.minimumDurability < 0 ||
      !Number.isFinite(policy.minimumCooldownRatio) ||
      policy.minimumCooldownRatio < MIN_ALLOWED_COOLDOWN_RATIO ||
      policy.minimumCooldownRatio > 1 ||
      !Number.isFinite(policy.meleePreferredRange) ||
      policy.meleePreferredRange <= 0 ||
      !Number.isFinite(policy.minimumDrawRatio) ||
      policy.minimumDrawRatio < MIN_ALLOWED_DRAW_RATIO ||
      policy.minimumDrawRatio > 1
    ) {
      throw new TypeError("武器策略越界，拒绝使用该策略。");
    }
    this.policy = policy;
  }

  /** 换服或重连后必须清空冷却与蓄力记忆，否则会拿上一场的时间戳判定。 */
  reset(): void {
    this.lastSwingAtMs = null;
    this.lastSwingCooldownMs = 0;
    this.drawStartedAtMs = null;
  }

  /**
   * 纯函数：按有效伤害选最优武器，先过耐久与弹药保护。
   * 同伤害时取槽位号小的，保证结果稳定可测。
   *
   * `targetDistance` 决定近战/远程分工：不传（或传 null）时按纯近战选择，
   * 保持与只有近战模型时的旧行为一致。近战窗口内只考虑近战武器；窗口外先试
   * 射程够得到的远程武器，都够不到再退回近战（好过完全不选）。
   */
  select(
    candidates: readonly CombatWeaponCandidate[],
    targetDistance: number | null = null,
  ): CombatWeaponSelection {
    if (targetDistance !== null) {
      if (!Number.isFinite(targetDistance) || targetDistance < 0) {
        throw new TypeError("targetDistance 必须是非负有限数或 null。");
      }
    }

    const excludedSlots: number[] = [];
    const outOfAmmoSlots: number[] = [];
    const melee: CombatWeaponCandidate[] = [];
    const ranged: CombatWeaponCandidate[] = [];

    for (const candidate of candidates) {
      validateCandidate(candidate);
      if (
        candidate.durabilityRemaining !== null &&
        candidate.durabilityRemaining < this.policy.minimumDurability
      ) {
        excludedSlots.push(candidate.slot);
        continue;
      }
      if (isRangedWeapon(candidate.kind)) {
        // 没箭的弓和碎掉的剑一样：不返回一个放不出去的武器。
        if ((candidate.ammoRemaining ?? 0) <= 0) {
          outOfAmmoSlots.push(candidate.slot);
          continue;
        }
        if (
          targetDistance !== null &&
          targetDistance > (candidate.effectiveRange ?? 0)
        ) {
          continue;
        }
        ranged.push(candidate);
        continue;
      }
      melee.push(candidate);
    }

    // 距离未知时按纯近战处理；远程武器需要距离才能判断该不该用。
    const preferMelee =
      targetDistance === null ||
      targetDistance <= this.policy.meleePreferredRange;
    const order = preferMelee ? [melee, ranged] : [ranged, melee];

    let best: CombatWeaponCandidate | null = null;
    let bestDamage = 0;
    for (const pool of order) {
      const picked = pickHighestDamage(pool);
      if (picked) {
        best = picked.weapon;
        bestDamage = picked.damage;
        break;
      }
    }

    return {
      weapon: best,
      effectiveDamage: best ? bestDamage : 0,
      excludedSlots,
      outOfAmmoSlots,
      mode: best === null ? null : isRangedWeapon(best.kind) ? "ranged" : "melee",
    };
  }

  /**
   * 远程武器的蓄力/装填判定。近战走 `evaluateSwing`，两者互不复用状态。
   *
   * `drawing` 由调用方给出当前是否正按住右键 —— 本模块不猜客户端状态。
   * 目标进入近战窗口时返回 TOO_CLOSE 让调用方切近战，而不是硬放一箭。
   */
  evaluateRanged(
    weapon: CombatWeaponCandidate | null,
    nowMs: number,
    targetDistance: number,
    drawing: boolean,
  ): CombatRangedDecision {
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("nowMs 必须是有限数。");
    }
    if (!Number.isFinite(targetDistance) || targetDistance < 0) {
      throw new TypeError("targetDistance 必须是非负有限数。");
    }
    const refuse = (
      reason: CombatRangedDecision["reason"],
    ): CombatRangedDecision => ({
      action: "NONE",
      drawRatio: 0,
      waitMs: 0,
      reason,
    });

    if (!weapon) return refuse("NO_WEAPON");
    if (!isRangedWeapon(weapon.kind)) return refuse("NOT_RANGED");
    if ((weapon.ammoRemaining ?? 0) <= 0) return refuse("OUT_OF_AMMO");
    if (targetDistance > (weapon.effectiveRange ?? 0)) {
      return refuse("OUT_OF_RANGE");
    }
    if (targetDistance <= this.policy.meleePreferredRange) {
      return refuse("TOO_CLOSE");
    }

    const drawTimeMs = weapon.drawTimeMs ?? 0;
    if (drawTimeMs <= 0) {
      throw new TypeError("远程武器必须给出正的 drawTimeMs。");
    }
    if (!drawing || this.drawStartedAtMs === null) {
      return { action: "DRAW", drawRatio: 0, waitMs: drawTimeMs, reason: "NOT_DRAWING" };
    }

    const elapsed = Math.max(0, nowMs - this.drawStartedAtMs);
    const ratio = Math.min(1, elapsed / drawTimeMs);
    if (ratio < this.policy.minimumDrawRatio) {
      return {
        action: "HOLD",
        drawRatio: ratio,
        waitMs: Math.max(
          0,
          Math.ceil(drawTimeMs * this.policy.minimumDrawRatio - elapsed),
        ),
        reason: "DRAWING",
      };
    }
    return { action: "RELEASE", drawRatio: ratio, waitMs: 0, reason: "RELEASE_READY" };
  }

  /** 记录开始拉弓/装填。只有真的按下去才调用。 */
  recordDrawStart(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("nowMs 必须是有限数。");
    }
    if (this.drawStartedAtMs !== null && nowMs < this.drawStartedAtMs) {
      throw new RangeError("蓄力时间早于上一次蓄力，拒绝记账。");
    }
    this.drawStartedAtMs = nowMs;
  }

  /** 记录松手放箭 —— 蓄力归零，下一箭必须重新拉。 */
  recordRelease(): void {
    this.drawStartedAtMs = null;
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

/** 池内按有效伤害取最优；同伤害取槽位小的，保证顺序无关。 */
function pickHighestDamage(
  pool: readonly CombatWeaponCandidate[],
): { weapon: CombatWeaponCandidate; damage: number } | null {
  let best: CombatWeaponCandidate | null = null;
  let bestDamage = -1;
  for (const candidate of pool) {
    const damage = candidate.baseDamage + candidate.enchantmentDamageBonus;
    if (
      damage > bestDamage ||
      (damage === bestDamage && best !== null && candidate.slot < best.slot)
    ) {
      best = candidate;
      bestDamage = damage;
    }
  }
  return best === null ? null : { weapon: best, damage: bestDamage };
}

function validateCandidate(candidate: CombatWeaponCandidate): void {
  if (
    !Number.isFinite(candidate.baseDamage) ||
    candidate.baseDamage < 0 ||
    !Number.isFinite(candidate.fullCooldownMs) ||
    candidate.fullCooldownMs <= 0
  ) {
    throw new TypeError("武器候选的伤害或冷却数据非法。");
  }
  if (!isRangedWeapon(candidate.kind)) return;
  if (
    candidate.effectiveRange === undefined ||
    !Number.isFinite(candidate.effectiveRange) ||
    candidate.effectiveRange <= 0
  ) {
    throw new TypeError("远程武器必须给出正的 effectiveRange。");
  }
  if (
    candidate.drawTimeMs === undefined ||
    !Number.isFinite(candidate.drawTimeMs) ||
    candidate.drawTimeMs <= 0
  ) {
    throw new TypeError("远程武器必须给出正的 drawTimeMs。");
  }
  if (
    candidate.ammoRemaining !== null &&
    candidate.ammoRemaining !== undefined &&
    (!Number.isInteger(candidate.ammoRemaining) || candidate.ammoRemaining < 0)
  ) {
    throw new TypeError("ammoRemaining 必须是非负整数或 null。");
  }
}
