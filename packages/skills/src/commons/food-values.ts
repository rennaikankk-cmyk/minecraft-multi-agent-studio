// ---------------------------------------------------------------------------
// Minecraft 常识：食物（饥饿值与饱和度）。
//
// 机制（出处：原版 Hunger 机制）：
//   - 饥饿条 0..20；食物 -1 或 -0.5 时**不能疾跑**（6 点起不能自然回血）。
//   - 饱和度（saturation）上限 = 当前饥饿值。吃东西先加饥饿再加饱和度，
//     但饱和度被夹到新饥饿值上——所以**饥饿值高的时候吃高饱和度食物会溢出浪费**。
//   - 消耗顺序：先烧饱和度，饱和度见底后才开始掉饥饿值。因此同等"回血量"下，
//     饱和度高的食物撑得久得多——**看饱和度，不要只看饥饿点**。
//   - 生食风险：生鸡肉 30% 概率饥饿；生牛肉/猪排/羊肉/兔肉/鱼生吃安全（但回得少）；
//     河豚会中毒+反胃+饥饿 III；腐肉/毒马铃薯/蜘蛛眼是明确的负面食物。
//
// 纯知识层：一张表 + 几个纯函数（选食物、算浪费）。没有 I/O 和随机数——
// "30% 概率"只作为知识写进说明，判定时不掷骰子。
// ---------------------------------------------------------------------------

import { z } from "zod";

const itemNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u);

export const foodEntrySchema = z
  .object({
    itemName: itemNameSchema,
    /** 恢复的饥饿点（0.5 = 半个鸡腿）。 */
    hunger: z.number().min(0).max(20),
    /** 恢复的饱和度。高饱和度/饥饿比 = 撑得久。 */
    saturation: z.number().min(0).max(20),
    /** 生食（有食物中毒风险或明显低效）。 */
    raw: z.boolean(),
    /** 熟食（与同名生食配对，用于"优先吃熟食"规则）。 */
    cooked: z.boolean(),
    /** 熟食对应的生食 id；非熟食为 null。 */
    cookedFrom: z.string().min(1).max(64).nullable(),
    /** 是否属于"有害食物"（吃了会中毒/加负面效果），永不用来填饥饿。 */
    harmful: z.boolean(),
  })
  .strict();
export type FoodEntry = z.infer<typeof foodEntrySchema>;

/**
 * 食物表。出处：原版饥饿/饱和度数值（Java 版）。
 * 少见的几项（甜浆果、发光浆果、干海带、蜂蜜瓶）按社区整理的常见数据录入，
 * 精度足够做"选哪个更划算"的比较，不用于任何精确模拟。
 */
const rawFoodTable: readonly FoodEntry[] = [
  // --- 常见主食 ---
  { itemName: "apple", hunger: 4, saturation: 2.4, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "bread", hunger: 5, saturation: 6, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "carrot", hunger: 3, saturation: 3.6, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "golden_carrot", hunger: 6, saturation: 14.4, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "baked_potato", hunger: 5, saturation: 6, raw: false, cooked: true, cookedFrom: "potato", harmful: false },
  { itemName: "potato", hunger: 1, saturation: 0.6, raw: true, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "beetroot", hunger: 1, saturation: 1.2, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "beetroot_soup", hunger: 6, saturation: 7.2, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "mushroom_stew", hunger: 6, saturation: 7.2, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "rabbit_stew", hunger: 10, saturation: 12, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "suspicious_stew", hunger: 6, saturation: 7.2, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "pumpkin_pie", hunger: 8, saturation: 4.8, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "cookie", hunger: 2, saturation: 0.4, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "cake", hunger: 2, saturation: 0.4, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "dried_kelp", hunger: 1, saturation: 0.6, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "sweet_berries", hunger: 2, saturation: 0.4, raw: true, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "glow_berries", hunger: 2, saturation: 0.4, raw: true, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "melon_slice", hunger: 2, saturation: 1.2, raw: true, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "honey_bottle", hunger: 6, saturation: 1.2, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "chorus_fruit", hunger: 4, saturation: 2.4, raw: true, cooked: false, cookedFrom: null, harmful: false },
  // --- 熟肉/熟鱼（优于生食） ---
  { itemName: "cooked_beef", hunger: 8, saturation: 12.8, raw: false, cooked: true, cookedFrom: "beef", harmful: false },
  { itemName: "cooked_porkchop", hunger: 8, saturation: 12.8, raw: false, cooked: true, cookedFrom: "porkchop", harmful: false },
  { itemName: "cooked_mutton", hunger: 6, saturation: 9.6, raw: false, cooked: true, cookedFrom: "mutton", harmful: false },
  { itemName: "cooked_chicken", hunger: 6, saturation: 7.2, raw: false, cooked: true, cookedFrom: "chicken", harmful: false },
  { itemName: "cooked_rabbit", hunger: 5, saturation: 6, raw: false, cooked: true, cookedFrom: "rabbit", harmful: false },
  { itemName: "cooked_cod", hunger: 5, saturation: 6, raw: false, cooked: true, cookedFrom: "cod", harmful: false },
  { itemName: "cooked_salmon", hunger: 6, saturation: 9.6, raw: false, cooked: true, cookedFrom: "salmon", harmful: false },
  // --- 生食（生吃安全但低效；生鸡肉有饥饿风险） ---
  { itemName: "beef", hunger: 3, saturation: 1.8, raw: true, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "porkchop", hunger: 3, saturation: 1.8, raw: true, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "mutton", hunger: 2, saturation: 1.2, raw: true, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "chicken", hunger: 2, saturation: 1.2, raw: true, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "rabbit", hunger: 3, saturation: 1.8, raw: true, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "cod", hunger: 2, saturation: 0.4, raw: true, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "salmon", hunger: 2, saturation: 0.4, raw: true, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "tropical_fish", hunger: 1, saturation: 0.2, raw: true, cooked: false, cookedFrom: null, harmful: false },
  // --- 明确有害：填了饥饿但付出生病/中毒代价，永不用来填饥饿 ---
  { itemName: "rotten_flesh", hunger: 4, saturation: 0.8, raw: true, cooked: false, cookedFrom: null, harmful: true },
  { itemName: "poisonous_potato", hunger: 2, saturation: 1.2, raw: true, cooked: false, cookedFrom: null, harmful: true },
  { itemName: "spider_eye", hunger: 2, saturation: 3.2, raw: true, cooked: false, cookedFrom: null, harmful: true },
  { itemName: "pufferfish", hunger: 1, saturation: 0.2, raw: true, cooked: false, cookedFrom: null, harmful: true },
  // --- 特殊效果食物：能吃，但不是"填饥饿"用的（金苹果用于治疗/战斗） ---
  { itemName: "golden_apple", hunger: 4, saturation: 9.6, raw: false, cooked: false, cookedFrom: null, harmful: false },
  { itemName: "enchanted_golden_apple", hunger: 4, saturation: 9.6, raw: false, cooked: false, cookedFrom: null, harmful: false },
];

/** 食物表索引（去掉 minecraft: 前缀）。 */
export const foodTable: ReadonlyMap<string, FoodEntry> = new Map(
  rawFoodTable.map((entry) => [entry.itemName, foodEntrySchema.parse(entry)]),
);

/** 去掉 minecraft: 命名空间前缀，统一小写。 */
export function normalizeFoodName(itemName: string): string {
  const trimmed = itemName.trim().toLowerCase();
  return trimmed.startsWith("minecraft:") ? trimmed.slice("minecraft:".length) : trimmed;
}

/** 查食物条目；未知物品返回 null。 */
export function foodEntryFor(itemName: string): FoodEntry | null {
  return foodTable.get(normalizeFoodName(itemName)) ?? null;
}

/** 有害食物 id 集合（表里 harmful=true 的派生视图，避免两处维护）。 */
export const harmfulFoodItemNames: readonly string[] = Object.freeze(
  [...foodTable.values()].filter((entry) => entry.harmful).map((entry) => entry.itemName).sort(),
);

/** 生食风险说明。**知识**，不是判定：判定不掷骰子，只把风险告知调用方。 */
export const rawFoodRiskNotes: Readonly<Record<string, string>> = Object.freeze({
  chicken: "生鸡肉有 30% 概率获得饥饿效果（Hunger），熟鸡肉无风险。",
  beef: "生牛肉无中毒风险，但饥饿/饱和度都远低于牛排，能烧就烧。",
  porkchop: "生猪排无中毒风险，但饥饿/饱和度都远低于熟猪排，能烧就烧。",
  mutton: "生羊肉无中毒风险，但饥饿/饱和度都远低于熟羊肉，能烧就烧。",
  rabbit: "生兔肉无中毒风险，但饥饿/饱和度都远低于熟兔肉，能烧就烧。",
  cod: "生鳕鱼无中毒风险，熟鳕鱼饥饿+3、饱和度从 0.4 升到 6，差距很大。",
  salmon: "生鲑鱼无中毒风险，熟鲑鱼饥饿+4、饱和度从 0.4 升到 9.6。",
  tropical_fish: "热带鱼几乎不回饥饿，只值得拿来做药水/驯猫。",
  pufferfish: "河豚会中毒、反胃并触发饥饿 III，除了做水下呼吸药水没有食用价值。",
  rotten_flesh: "腐肉 80% 概率触发饥饿效果；只有在饿死边缘且没有别的选择时才吃。",
  poisonous_potato: "毒马铃薯 60% 概率中毒，永远不要为了填饥饿吃它。",
  spider_eye: "蜘蛛眼直接造成中毒，只在做药水时有用。",
  sweet_berries: "甜浆果可食用，但饱和度只有 0.4，靠它撑不了多久。",
});

/**
 * 饱和度/饥饿比。原版里这个比值决定"一口顶多久"：
 * 熟牛肉 12.8/8 = 1.6，面包 6/5 = 1.2，曲奇 0.4/2 = 0.2。
 * 大于等于 1 的食物属于"高密度"，低于 0.5 属于"填肚子但不顶用"。
 */
export function saturationRatio(entry: FoodEntry): number {
  if (entry.hunger <= 0) return 0;
  return entry.saturation / entry.hunger;
}

/** 高密度阈值：饱和度/饥饿 ≥ 1.0。 */
export const HIGH_SATURATION_RATIO = 1;

export const MAX_HUNGER = 20;
export const MAX_SATURATION = 20;

export interface EatProjection {
  readonly itemName: string;
  readonly hungerBefore: number;
  readonly saturationBefore: number;
  readonly hungerAfter: number;
  readonly saturationAfter: number;
  /** 因饥饿已满而**完全浪费**的饥饿点。 */
  readonly wastedHunger: number;
  /** 因饱和度上限（= 新饥饿值）而溢出的饱和点数。 */
  readonly wastedSaturation: number;
  /** 实际吃进肚子的饱和点数。 */
  readonly effectiveSaturation: number;
}

/**
 * 吃一口之后的投影。纯算术，不掷骰子、不看时钟。
 *
 * 算法照原版顺序：先加饥饿（夹到 20），饱和度上限 = 加完之后的饥饿值，
 * 所以饥饿高时吃高饱和度食物必然溢出——这就是"吃饱了别吃"和
 * "饱和度高比饥饿点更值钱"两条常识的算术来源。
 */
export function projectEat(
  itemName: string,
  hunger: number,
  saturation: number,
  count = 1,
): EatProjection | null {
  const entry = foodEntryFor(itemName);
  if (entry === null) return null;
  const hungerBefore = clamp(hunger, 0, MAX_HUNGER);
  const saturationBefore = clamp(saturation, 0, MAX_SATURATION);
  let currentHunger = hungerBefore;
  let currentSaturation = saturationBefore;
  let wastedHunger = 0;
  let wastedSaturation = 0;
  for (let index = 0; index < count; index += 1) {
    const requestedHunger = currentHunger + entry.hunger;
    currentHunger = Math.min(MAX_HUNGER, requestedHunger);
    wastedHunger += Math.max(0, requestedHunger - MAX_HUNGER);
    const saturationCeiling = currentHunger;
    const requestedSaturation = currentSaturation + entry.saturation;
    currentSaturation = Math.min(saturationCeiling, requestedSaturation);
    wastedSaturation += Math.max(0, requestedSaturation - saturationCeiling);
  }
  return {
    itemName: entry.itemName,
    hungerBefore,
    saturationBefore,
    hungerAfter: currentHunger,
    saturationAfter: currentSaturation,
    wastedHunger,
    wastedSaturation,
    effectiveSaturation: currentSaturation - saturationBefore,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 食物候选（调用方从背包/箱子观测里给出）。 */
export const foodCandidateSchema = z
  .object({ itemName: itemNameSchema, count: z.number().int().min(0).max(9_999) })
  .strict();
export type FoodCandidate = z.infer<typeof foodCandidateSchema>;

/** 当前饥饿/饱和度。运行时状态里没有这两项，必须由调用方作为输入给出。 */
export const hungerStateSchema = z
  .object({ hunger: z.number().min(0).max(MAX_HUNGER), saturation: z.number().min(0).max(MAX_SATURATION) })
  .strict();
export type HungerState = z.infer<typeof hungerStateSchema>;

export const foodPickReasonCodes = [
  "BEST_SATURATION_EFFICIENCY",
  "HIGHEST_EFFECTIVE_SATURATION",
  "COOKED_PREFERRED",
  "ONLY_SAFE_OPTION",
  "HUNGER_ALREADY_FULL",
  "NO_CANDIDATES",
  "ONLY_HARMFUL_FOOD",
  "ONLY_UNKNOWN_FOOD",
  "SATURATION_WOULD_OVERFLOW",
] as const;
export const foodPickReasonCodeSchema = z.enum(foodPickReasonCodes);
export type FoodPickReasonCode = (typeof foodPickReasonCodes)[number];

export interface FoodPickDecision {
  readonly verdict: "EAT" | "REFUSE";
  readonly itemName: string | null;
  readonly reasonCode: FoodPickReasonCode;
  /** 一句话理由（给人看；判定本身只看 reasonCode）。 */
  readonly rationale: string;
  readonly projection: EatProjection | null;
  /** 候选里被排除的有害食物（供上层记录，不做二次判断）。 */
  readonly refusedHarmful: readonly string[];
}

/**
 * 选一口吃的。规则优先级（高到低）：
 *   1. 饥饿已满 → 一律拒绝（HUNGER_ALREADY_FULL）：吃东西不回血还白丢一件。
 *   2. 排除有害食物（rotten_flesh / poisonous_potato / spider_eye / pufferfish）。
 *   3. 在剩下的里面比"单位饥饿能换到的有效饱和度"（越高越顶饿），
 *      并列时取有效饱和度更高者，再并列取熟食（生食有风险/更亏），
 *      再并列按 id 字典序——保证同输入永远同输出。
 *
 * 注意本函数**不**看库存里有没有、也不看附近有没有熔炉：那是上层的事。
 */
export function pickFood(
  candidates: readonly FoodCandidate[],
  hunger: HungerState,
): FoodPickDecision {
  const refusedHarmful: string[] = [];
  const safe: FoodCandidate[] = [];
  let unknownCount = 0;
  for (const candidate of candidates) {
    const entry = foodEntryFor(candidate.itemName);
    if (entry === null) {
      unknownCount += 1;
      continue;
    }
    if (entry.harmful) {
      refusedHarmful.push(entry.itemName);
      continue;
    }
    if (candidate.count > 0) safe.push({ itemName: entry.itemName, count: candidate.count });
  }
  if (hunger.hunger >= MAX_HUNGER) {
    return {
      verdict: "REFUSE",
      itemName: null,
      reasonCode: "HUNGER_ALREADY_FULL",
      rationale: `饥饿值已满（${hunger.hunger}/${MAX_HUNGER}），进食不会回血（满饥饿自然回血），只会白白消耗一件食物。`,
      projection: null,
      refusedHarmful,
    };
  }
  if (safe.length === 0) {
    const reasonCode: FoodPickReasonCode =
      refusedHarmful.length > 0 ? "ONLY_HARMFUL_FOOD" : unknownCount > 0 ? "ONLY_UNKNOWN_FOOD" : "NO_CANDIDATES";
    const rationale =
      reasonCode === "ONLY_HARMFUL_FOOD"
        ? `候选里只有有害食物（${refusedHarmful.join("、")}）：吃了会中毒/饥饿，宁可不吃。`
        : reasonCode === "ONLY_UNKNOWN_FOOD"
          ? "候选食物不在常识表里，无法判断安全性——不猜。"
          : "没有任何可吃的候选食物。";
    return { verdict: "REFUSE", itemName: null, reasonCode, rationale, projection: null, refusedHarmful };
  }
  const scored = safe
    .map((candidate) => {
      const entry = foodEntryFor(candidate.itemName)!;
      const projection = projectEat(candidate.itemName, hunger.hunger, hunger.saturation, 1)!;
      const efficiency = projection.effectiveSaturation / entry.hunger;
      return { candidate, entry, projection, efficiency };
    })
    .sort((left, right) => {
      if (right.efficiency !== left.efficiency) return right.efficiency - left.efficiency;
      if (right.projection.effectiveSaturation !== left.projection.effectiveSaturation) {
        return right.projection.effectiveSaturation - left.projection.effectiveSaturation;
      }
      if (left.entry.cooked !== right.entry.cooked) return left.entry.cooked ? -1 : 1;
      return left.entry.itemName.localeCompare(right.entry.itemName);
    });
  const best = scored[0]!;
  const saturatedRatioHigh = saturationRatio(best.entry) >= HIGH_SATURATION_RATIO;
  const reasonCode: FoodPickReasonCode = saturatedRatioHigh
    ? "BEST_SATURATION_EFFICIENCY"
    : best.projection.wastedSaturation > 0
      ? "SATURATION_WOULD_OVERFLOW"
      : scored.length === 1
        ? "ONLY_SAFE_OPTION"
        : "HIGHEST_EFFECTIVE_SATURATION";
  return {
    verdict: "EAT",
    itemName: best.entry.itemName,
    reasonCode,
    rationale: `吃 ${best.entry.itemName}：饥饿 +${best.entry.hunger}、饱和 +${best.entry.saturation}（有效 ${best.projection.effectiveSaturation}，浪费 ${best.projection.wastedSaturation}），饱和度/饥饿比 ${saturationRatio(best.entry).toFixed(2)}。`,
    projection: best.projection,
    refusedHarmful,
  };
}
