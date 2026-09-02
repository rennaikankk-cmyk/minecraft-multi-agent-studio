// ---------------------------------------------------------------------------
// tactics/mechanics.ts —— 已证实的 Minecraft 1.9+ 战斗机制常量。
//
// 来源：docs/research/PVP_SYSTEM_RESEARCH.md §3（全部带 minecraft.wiki 引用，
// 访问 2026-09-02）。这里只放**游戏事实**，不放可调参数——可调权重在
// profile.ts（未校准中性先验，feature flag 关闭时零影响）。
// ---------------------------------------------------------------------------

/** 攻击速度（次/秒）。剑全系 1.6；下界合金斧 1.0；空手 4。〔wiki Attack speed〕 */
export const ATTACK_SPEED = {
  sword: 1.6,
  netheriteAxe: 1.0,
  fist: 4,
} as const;

/** 基础伤害（含玩家 +1）。〔wiki Attack speed / Sword / Axe〕 */
export const BASE_DAMAGE = {
  netheriteSword: 8,
  netheriteAxe: 10,
  ironSword: 6,
  fist: 1,
} as const;

/** 冷却伤害倍率 0.2 + 0.8·p²（p=冷却进度）。〔wiki Attack cooldown〕 */
export function cooldownDamageMultiplier(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return 0.2 + 0.8 * p * p;
}

/** 暴击/疾跑击退所需冷却进度阈值。〔wiki Attack cooldown〕 */
export const FULL_BENEFIT_PROGRESS = 0.848;

/** 暴击倍率（作用于附魔前）。〔wiki Critical hit〕 */
export const CRIT_MULTIPLIER = 1.5;

/** 无敌帧时长（ms）。〔wiki Damage〕 */
export const IFRAME_MS = 500;

/** 盾生效延迟与斧禁盾时长。〔wiki Shield〕 */
export const SHIELD_RAISE_MS = 250;
export const AXE_SHIELD_DISABLE_MS = 5_000;

/** 图腾触发后状态：1HP + 吸收 II（4HP）5s + 再生 II 45s。〔wiki Totem of Undying〕 */
export const TOTEM_POP = {
  healthAfter: 1,
  absorptionHp: 4,
  absorptionMs: 5_000,
  regenMs: 45_000,
} as const;

/** 金苹果：进食 1.6s；再生 II 5s（≈4HP）+ 吸收 4HP。〔wiki Golden Apple〕 */
export const GOLDEN_APPLE = {
  eatMs: 1_600,
  regenHp: 4,
  absorptionHp: 4,
} as const;

/** 护甲减伤公式（armor points + toughness，Protection 上限 80%）。〔wiki Armor/Protection〕 */
export function armorReduction(armorPoints: number, toughness: number, damage: number): number {
  const capped = Math.min(20, Math.max(armorPoints / 5, armorPoints - (4 * damage) / (Math.min(toughness, 20) + 8)));
  return capped / 25;
}

/** Protection 上限减伤（未知附魔时的保守上界）。 */
export const MAX_PROTECTION_REDUCTION = 0.8;

/** 玩家攻击距离（格）。〔wiki Attack range：entity_interaction_range=3.0〕 */
export const PLAYER_REACH_BLOCKS = 3.0;

/** 移动速度（m/s）：走 4.317 / 疾跑 5.612 / 疾跑跳 7.127。〔wiki Sprinting〕 */
export const MOVE_SPEED = {
  walk: 4.317,
  sprint: 5.612,
  sprintJump: 7.127,
} as const;

/** 服务器 tick。 */
export const TICK_MS = 50;

/** 服务器实体追踪半径默认值（Paper players=48）。〔docs papermc spigot.yml〕 */
export const DEFAULT_TRACKING_RANGE_BLOCKS = 48;
