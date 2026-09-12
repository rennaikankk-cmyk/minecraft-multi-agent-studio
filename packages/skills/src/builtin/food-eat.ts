import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";
import { MAX_HUNGER } from "../commons/food-values.js";

// ---------------------------------------------------------------------------
// food.eat —— 吃一口（有据可查的那一口）。
//
// 与 food.pick 的分工：food.pick 只回答"该吃哪个、为什么"（纯函数，零能力），
// 本技能把那个答复**执行掉**：一个 world.interact / food.eat-safe 能力调用，
// 由 bot-runtime 走 equip → 复核 → consume 原语。
//
// 为什么必须带读回：L0 的 CONSUME_SAFE_FOOD 只需要"吃下去了"（安全层接受
// consume() 不抛错）；技能的证据门槛更高——**物品计数必须真的下降，或饥饿值
// 必须真的上升**，否则 FOOD_EAT_NOT_CONFIRMED。consume() resolve 只是"包发出去
// 了"，不是"食物进了肚子"。
//
// 为什么非幂等：吃一口就少一件，重复执行会连吃（满饥饿前一直有效）。
// 上层要重复必须先重新观察饥饿值，所以这里 maxAttempts=1 且 retryableErrorCodes
// 为空——不给出"盲重试"的许可。
//
// **可用区间是饥饿 15..19**（分工，不是巧合）：
//   ≤14 —— 归 L0 反射层。packages/safety 的 EAT_AT_FOOD_LEVEL=14 会让 HUNGER
//          成为一项风险，从而 PAUSE_NORMAL_TASKS；普通技能连前置条件都过不了，
//          报文是 NORMAL_ACTIONS_PAUSED。紧急饥饿由反射层自己吃
//          （CONSUME_SAFE_FOOD），不经过技能/规划器——这正是 AGENTS.md §0.1
//          的"反射层由确定性代码负责"。
//   15..19 —— 本技能的区间：还没到反射层阈值，但也不满，可以规划着吃。
//   20（满）—— FOOD_NOT_NEEDED 拒绝：满饥饿自然回血，吃下去白丢一件。
// ---------------------------------------------------------------------------

export const FOOD_EAT_TIMEOUT_MS = 10_000;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const itemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);

export const foodEatInputSchema = z
  .object({
    /**
     * 想吃的那一件（通常来自 food.pick 的 itemName）。
     * **建议而非命令**：能力端仍按 commons/food-values.ts 的规则重新选一口
     * （满饥饿拒绝、有害食物排除、食物储备保护），以免上层用一个过期快照
     * 指名吃掉不该吃的东西。
     */
    itemName: itemNameSchema,
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const foodEatStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        z: z.number().finite(),
        dimension: dimensionSchema,
        serverProfileId: identifierSchema,
        yaw: z.number().finite().optional(),
        pitch: z.number().finite().optional(),
      })
      .strict()
      .nullable(),
    /** 当前饥饿值（0..20，上限取自 commons 的 MAX_HUNGER）。null/缺失 = 快照不可用 → fail-closed，不猜。 */
    hunger: z.number().min(0).max(MAX_HUNGER).nullable().optional(),
    /** 候选食物计数（通常只填 itemName 那一项）。null/缺失 = 快照不可用。 */
    foodItemCount: z.number().int().min(0).nullable().optional(),
  })
  .strip();

export const foodEatOutputSchema = z
  .object({
    /** 只有读回成立才会返回这个对象；字段全部是读回事实，没有裸 "ok"。 */
    succeeded: z.literal(true),
    /** 实际吃下去的物品名（能力端重新选了就以它为准，可能与入参不同）。 */
    itemName: itemNameSchema,
    /** 吃后该食物剩余计数（读回）。 */
    remainingCount: z.number().int().min(0),
    /** 计数差值（读回）；饥饿先涨而计数滞后时为 0，如实上报。 */
    consumedCount: z.number().int().min(0),
    hungerBefore: z.number().min(0).max(MAX_HUNGER),
    /** 饥饿值读回；读不到时为 null（不补默认值）。 */
    hungerAfter: z.number().min(0).max(MAX_HUNGER).nullable(),
    saturationBefore: z.number().min(0).max(20),
    saturationAfter: z.number().min(0).max(20).nullable(),
    /** commons 投影出的有效饱和度（吃的这一口**预计**能撑多久）。 */
    projectedSaturationGain: z.number().min(0).max(20),
    /** commons 的选择理由码（如 BEST_SATURATION_EFFICIENCY）。 */
    reasonCode: z.string().min(1).max(64),
  })
  .strict();

export const foodEatCapabilityInputSchema = foodEatInputSchema;
export const foodEatCapabilityOutputSchema = foodEatOutputSchema;

export const foodEatSkill = defineSkill({
  id: "food.eat",
  version: "1.0.0",
  progressContract: "INVENTORY_CHANGE",
  inputSchema: foodEatInputSchema,
  outputSchema: foodEatOutputSchema,
  stateSchema: foodEatStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  // 只碰背包（装备+进食）；不读方块、不移动——睡眠/装桶那两个才需要别的锁。
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: FOOD_EAT_TIMEOUT_MS,
  // 非幂等：吃一口就少一件，重复执行等于连吃（满饥饿前一直生效）。
  idempotent: false,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 200,
    maxDelayMs: 500,
    retryableErrorCodes: [],
  },
  preconditions: [
    {
      id: "bot.online",
      failureCode: "BOT_NOT_ONLINE",
      check: (_input, state) => state.online,
    },
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
    {
      // 饥饿值读不到就不吃：既判断不了"该不该吃"，也判断不了满饥饿浪费。
      id: "hunger.snapshot-known",
      failureCode: "BOT_HUNGER_UNKNOWN",
      check: (_input, state) => state.hunger != null,
    },
    {
      // 满饥饿进食 = 白丢一件（原版满饥饿自然回血）。规则来自 commons 的
      // pickFood（HUNGER_ALREADY_FULL），这里只是把拒绝提前到能力调用之前。
      // 注意下界不在这里：饥饿 ≤14 由 L0 反射层接管（普通动作已被暂停），
      // 本技能只在 15..19 这个区间被真正执行。
      id: "hunger.not-full",
      failureCode: "FOOD_NOT_NEEDED",
      check: (_input, state) => (state.hunger ?? MAX_HUNGER) < MAX_HUNGER,
    },
    {
      id: "food.count-known",
      failureCode: "INVENTORY_COUNT_UNKNOWN",
      check: (_input, state) => state.foodItemCount != null,
    },
    {
      id: "food.available",
      failureCode: "INVENTORY_INSUFFICIENT_ITEMS",
      check: (_input, state) => (state.foodItemCount ?? 0) >= 1,
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "world.interact",
      "food.eat-safe",
      foodEatCapabilityInputSchema.parse(input),
    ),
});
