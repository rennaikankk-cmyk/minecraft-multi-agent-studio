import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import {
  foodCandidateSchema,
  foodEntryFor,
  foodPickReasonCodeSchema,
  harmfulFoodItemNames,
  hungerStateSchema,
  MAX_HUNGER,
  projectEat,
  saturationRatio,
} from "../commons/food-values.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// food.pick —— 选一口吃的（纯函数技能）。
//
// 运行时状态里**没有饥饿值也没有饱和度**（只有 usedSlots/totalSlots 这种背包
// 容量），所以饥饿/饱和度必须由调用方作为 INPUT 给出；背包里有什么食物同理。
//
// 它只回答"现在该吃哪一个、为什么"，不负责吃（那是 inventory/use 类技能的事），
// 也不负责找食物（那是 food.secure 的事）。规则见 commons/food-values.ts：
//   1. 饥饿满了就不吃——满饥饿本来就会自然回血，吃下去纯浪费。
//   2. 有害食物（腐肉/毒马铃薯/蜘蛛眼/河豚）永远不用来填饥饿。
//   3. 比"单位饥饿换到的有效饱和度"，饱和度比饥饿点更值钱（撑得久）。
//   4. 并列时熟食优先（生食有中毒风险且更亏），再并列按 id 字典序定序。
// ---------------------------------------------------------------------------

export const FOOD_PICK_TIMEOUT_MS = 2_000;
export const FOOD_PICK_MAX_CANDIDATES = 64;

export const foodPickInputSchema = z
  .object({
    /** 候选食物（背包/箱子观测；count=0 的候选会被忽略）。 */
    candidates: z.array(foodCandidateSchema).max(FOOD_PICK_MAX_CANDIDATES),
    hunger: hungerStateSchema,
    serverProfileId: identifierSchema,
  })
  .strict();
export type FoodPickInput = z.infer<typeof foodPickInputSchema>;

const eatProjectionSchema = z
  .object({
    itemName: z.string().min(1).max(64),
    hungerBefore: z.number().min(0).max(MAX_HUNGER),
    saturationBefore: z.number().min(0).max(20),
    hungerAfter: z.number().min(0).max(MAX_HUNGER),
    saturationAfter: z.number().min(0).max(20),
    wastedHunger: z.number().min(0).max(1_000),
    wastedSaturation: z.number().min(0).max(1_000),
    effectiveSaturation: z.number().min(0).max(20),
  })
  .strict();

export const foodPickOutputSchema = z
  .object({
    verdict: z.enum(["EAT", "REFUSE"]),
    itemName: z.string().min(1).max(64).nullable(),
    reasonCode: foodPickReasonCodeSchema,
    rationale: z.string().min(1).max(512),
    projection: eatProjectionSchema.nullable(),
    /** 被规则排除的有害食物（如实记录，供上层审计）。 */
    refusedHarmful: z.array(z.string().min(1).max(64)).max(FOOD_PICK_MAX_CANDIDATES),
    hungerBefore: z.number().min(0).max(MAX_HUNGER),
    saturationBefore: z.number().min(0).max(20),
  })
  .strict();
export type FoodPickOutput = z.infer<typeof foodPickOutputSchema>;

export const foodPickStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
  })
  .strip();
export type FoodPickState = z.infer<typeof foodPickStateSchema>;

export const foodPickSkill = defineSkill({
  id: "food.pick",
  version: "1.0.0",
  progressContract: "WAITING_EXTERNAL",
  inputSchema: foodPickInputSchema,
  outputSchema: foodPickOutputSchema,
  stateSchema: foodPickStateSchema,
  compatibility: {
    variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }],
  },
  // 纯选择：不吃、不翻背包（与 stock.levels / movement.profile 同类）。
  requiredCapabilities: [] as const,
  timeoutMs: FOOD_PICK_TIMEOUT_MS,
  idempotent: true,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    {
      id: "l0.normal-actions-allowed",
      failureCode: "NORMAL_ACTIONS_PAUSED",
      check: (_input, state) => state.normalActionsAllowed,
    },
    {
      id: "target.server-profile-matches",
      failureCode: "TARGET_SERVER_PROFILE_MISMATCH",
      check: (input, state) => input.serverProfileId === state.serverProfileId,
    },
  ],
  execute: async (_context, input) => {
    const refusedHarmful: string[] = [];
    const safe: { itemName: string; count: number }[] = [];
    let unknownCount = 0;
    for (const candidate of input.candidates) {
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
    const base = {
      refusedHarmful,
      hungerBefore: input.hunger.hunger,
      saturationBefore: input.hunger.saturation,
    };

    // 规则 1：满饥饿进食 = 白丢一件（满饥饿自然回血，吃下去不产生任何收益）。
    if (input.hunger.hunger >= MAX_HUNGER) {
      return foodPickOutputSchema.parse({
        ...base,
        verdict: "REFUSE",
        itemName: null,
        reasonCode: "HUNGER_ALREADY_FULL",
        rationale: `饥饿值已满（${input.hunger.hunger}/${MAX_HUNGER}）：满饥饿本来就会自然回血，此时进食只消耗食物、不产生收益。`,
        projection: null,
      });
    }
    if (safe.length === 0) {
      const reasonCode =
        refusedHarmful.length > 0 ? "ONLY_HARMFUL_FOOD" : unknownCount > 0 ? "ONLY_UNKNOWN_FOOD" : "NO_CANDIDATES";
      const rationale =
        reasonCode === "ONLY_HARMFUL_FOOD"
          ? `候选里只有有害食物（${refusedHarmful.join("、")}）：吃了会中毒/饥饿，宁可不吃。`
          : reasonCode === "ONLY_UNKNOWN_FOOD"
            ? "候选食物不在常识表里，无法判断安全性——不猜。"
            : "没有任何可吃的候选食物。";
      return foodPickOutputSchema.parse({ ...base, verdict: "REFUSE", itemName: null, reasonCode, rationale, projection: null });
    }

    // 规则 3/4：比有效饱和度效率，并列取熟食，再并列取 id 字典序（保证确定性）。
    const scored = safe
      .map((candidate) => {
        const entry = foodEntryFor(candidate.itemName)!;
        const projection = projectEat(candidate.itemName, input.hunger.hunger, input.hunger.saturation, 1)!;
        return { entry, projection, efficiency: projection.effectiveSaturation / entry.hunger };
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
    const reasonCode = reasonCodeForPick(scored.length, saturationRatio(best.entry), best.projection.wastedSaturation);
    return foodPickOutputSchema.parse({
      ...base,
      verdict: "EAT",
      itemName: best.entry.itemName,
      reasonCode,
      rationale: `吃 ${best.entry.itemName}：饥饿 +${best.entry.hunger}、饱和度 +${best.entry.saturation}（有效 ${best.projection.effectiveSaturation}、溢出 ${best.projection.wastedSaturation}），饱和度/饥饿 = ${saturationRatio(best.entry).toFixed(2)}。`,
      projection: best.projection,
    });
  },
});

/** 选中的那一个用哪个理由码说明（稳定映射，不随候选取值漂移）。 */
export function reasonCodeForPick(
  candidateCount: number,
  ratio: number,
  wastedSaturation: number,
): z.infer<typeof foodPickReasonCodeSchema> {
  if (ratio >= 1) return "BEST_SATURATION_EFFICIENCY";
  if (wastedSaturation > 0) return "SATURATION_WOULD_OVERFLOW";
  if (candidateCount === 1) return "ONLY_SAFE_OPTION";
  return "HIGHEST_EFFECTIVE_SATURATION";
}

/** 常识表里的有害食物清单（转发，便于上层做"背包里有没有不能吃的"检查）。 */
export const harmfulFoods: readonly string[] = harmfulFoodItemNames;
