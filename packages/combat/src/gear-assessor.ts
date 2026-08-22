/**
 * GearAssessor —— 战术级（T，≤200ms）确定性装备差评估。零 AI。
 *
 * 回答一个问题：**对面的装备是不是好到不该打。** 铁甲石剑打钻甲附魔斧是白送，
 * 这种局面应该在开打之前就认出来，而不是打到半血再靠 RetreatController 抢救。
 *
 * 三条纪律：
 *   1. **未知装备一律 fail-closed**。看不见对面穿什么就是 `unknown`，绝不当成
 *      "大概打得过"。保命立场下 unknown 与 outclassed 同等对待——这与
 *      capability `unknown` 的处理方式一致：不从缺失数据推断有利结论。
 *   2. **评分是自研近似，不是原版精确减伤公式**（AGENTS.md §0.6 只学打法不搬
 *      代码）。只保证单调性：护甲点越高越耐打、附魔越高越耐打、武器伤害越高越
 *      能打。**不声称等于服务器实际伤害**，调用方不得当作伤害保证。
 *   3. **只做比较，不做决策**。撤不撤、打不打由 RetreatController 与
 *      TargetSelector 按各自策略决定，本模块只给一个可复现的比值。
 */

export type CombatArmorMaterial =
  | "none"
  | "leather"
  | "golden"
  | "chainmail"
  | "iron"
  | "diamond"
  | "netherite";

/**
 * 各材质整套护甲的护甲点近似值（公开游戏数值，用于相对评分）。
 * 下界（netherite 与 diamond 同为 20 点）是原版设定，netherite 的额外优势由
 * 击退抗性体现，这里以 toughness 项单独加权。
 */
const ARMOR_POINTS: Readonly<Record<CombatArmorMaterial, number>> = {
  none: 0,
  leather: 7,
  golden: 11,
  chainmail: 12,
  iron: 15,
  diamond: 20,
  netherite: 20,
};

/** netherite 的额外韧性权重；只影响相对分，不是原版 toughness 数值。 */
const TOUGHNESS_BONUS: Readonly<Record<CombatArmorMaterial, number>> = {
  none: 0,
  leather: 0,
  golden: 0,
  chainmail: 0,
  iron: 0,
  diamond: 2,
  netherite: 5,
};

export type CombatGearSnapshot = Readonly<{
  /** 整套护甲的主体材质；混搭时由调用方按最低件给，保守估计自己。 */
  armorMaterial: CombatArmorMaterial;
  /** 保护类附魔的等效等级，[0, 4]。混搭时取平均，由调用方折算。 */
  protectionLevel: number;
  /** 手持武器的有效伤害（基础 + 附魔），与 WeaponManager 同一口径。 */
  weaponDamage: number;
  /** 当前生命，[0, 20]。 */
  health: number;
  /** 是否持有图腾。持有相当于多一条命，计入耐久度。 */
  hasTotem: boolean;
}>;

export type CombatGearVerdict =
  | "favorable"
  | "even"
  | "outclassed"
  | "unknown";

export type CombatGearPolicy = Readonly<{
  /**
   * 对面战力 / 自己战力 高于此值即判 outclassed。
   * 1.5 表示"对面强出五成就不打"。
   */
  outclassedRatio: number;
  /** 自己战力 / 对面战力 高于此值即判 favorable。 */
  favorableRatio: number;
  /**
   * 未知装备是否按 outclassed 处理。保命立场应为 true（fail-closed）；
   * 可弃 bot 可以设 false，反正它本来就允许死。
   */
  treatUnknownAsOutclassed: boolean;
}>;

export const DEFAULT_GEAR_POLICY: CombatGearPolicy = {
  outclassedRatio: 1.5,
  favorableRatio: 1.5,
  treatUnknownAsOutclassed: true,
};

export type CombatGearAssessment = Readonly<{
  verdict: CombatGearVerdict;
  /** 自己的战力评分。 */
  selfPower: number;
  /** 对面的战力评分；未知时为 null。 */
  opponentPower: number | null;
  /** 对面 / 自己 的战力比；未知时为 null。 */
  opponentAdvantage: number | null;
  /** 该结论是否应当阻止交战。调用方直接消费这个布尔，不必重算比值。 */
  shouldAvoid: boolean;
}>;

/**
 * 战力评分：耐久度 × 输出。两者都乘进去，因为只有一项高不构成优势——
 * 钻甲空手打不死人，满附魔斧穿皮甲也站不住。
 */
export function gearPower(gear: CombatGearSnapshot): number {
  validateGear(gear);
  const armor = ARMOR_POINTS[gear.armorMaterial];
  const toughness = TOUGHNESS_BONUS[gear.armorMaterial];
  // 护甲点与保护附魔都折成"有效血量倍率"，单调递增即可。
  const mitigation = 1 + (armor + toughness) / 20 + gear.protectionLevel / 8;
  const effectiveHealth = gear.health * mitigation * (gear.hasTotem ? 2 : 1);
  // 输出下界 1：空手也能打，只是很慢，不该让整个评分塌成 0。
  return effectiveHealth * Math.max(1, gear.weaponDamage);
}

export function assessGearMatchup(
  self: CombatGearSnapshot,
  opponent: CombatGearSnapshot | null,
  policy: CombatGearPolicy = DEFAULT_GEAR_POLICY,
): CombatGearAssessment {
  validateGearPolicy(policy);
  const selfPower = gearPower(self);

  if (opponent === null) {
    // 看不见就是看不见：不从缺失数据推出"打得过"。
    return {
      verdict: "unknown",
      selfPower,
      opponentPower: null,
      opponentAdvantage: null,
      shouldAvoid: policy.treatUnknownAsOutclassed,
    };
  }

  const opponentPower = gearPower(opponent);
  // 自己战力为 0（血量为 0）时对面无条件占优，避免除零。
  const advantage =
    selfPower === 0 ? Number.POSITIVE_INFINITY : opponentPower / selfPower;

  let verdict: CombatGearVerdict = "even";
  if (advantage >= policy.outclassedRatio) verdict = "outclassed";
  else if (
    opponentPower === 0 ||
    selfPower / opponentPower >= policy.favorableRatio
  ) {
    verdict = "favorable";
  }

  return {
    verdict,
    selfPower,
    opponentPower,
    opponentAdvantage: advantage,
    shouldAvoid: verdict === "outclassed",
  };
}

/** 多个敌人时取最强的那个比：打不过里面最猛的就是打不过。 */
export function assessWorstMatchup(
  self: CombatGearSnapshot,
  opponents: readonly (CombatGearSnapshot | null)[],
  policy: CombatGearPolicy = DEFAULT_GEAR_POLICY,
): CombatGearAssessment {
  if (opponents.length === 0) {
    return assessGearMatchup(self, null, policy);
  }
  let worst: CombatGearAssessment | null = null;
  for (const opponent of opponents) {
    const assessment = assessGearMatchup(self, opponent, policy);
    if (worst === null || rank(assessment) > rank(worst)) worst = assessment;
  }
  // opponents 非空，循环必然赋值；这里只为满足类型收窄。
  return worst ?? assessGearMatchup(self, null, policy);
}

/** 严重度排序：outclassed > unknown > even > favorable。 */
function rank(assessment: CombatGearAssessment): number {
  switch (assessment.verdict) {
    case "outclassed":
      return 3;
    case "unknown":
      return 2;
    case "even":
      return 1;
    case "favorable":
      return 0;
  }
}

function validateGear(gear: CombatGearSnapshot): void {
  if (!(gear.armorMaterial in ARMOR_POINTS)) {
    throw new TypeError("armorMaterial 不是已知材质，拒绝评分。");
  }
  if (
    !Number.isFinite(gear.protectionLevel) ||
    gear.protectionLevel < 0 ||
    gear.protectionLevel > 4
  ) {
    throw new TypeError("protectionLevel 必须落在 [0, 4]。");
  }
  if (!Number.isFinite(gear.weaponDamage) || gear.weaponDamage < 0) {
    throw new TypeError("weaponDamage 必须是非负有限数。");
  }
  if (!Number.isFinite(gear.health) || gear.health < 0 || gear.health > 20) {
    throw new TypeError("health 必须落在 [0, 20]。");
  }
}

export function validateGearPolicy(policy: CombatGearPolicy): void {
  if (
    !Number.isFinite(policy.outclassedRatio) ||
    policy.outclassedRatio <= 1 ||
    !Number.isFinite(policy.favorableRatio) ||
    policy.favorableRatio <= 1
  ) {
    throw new TypeError("装备评估策略越界，拒绝使用该策略。");
  }
}
