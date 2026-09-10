import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 繁殖动物技能：对两只同类成年动物各喂一份对应食物（bot.useOn）。
// 生存价值：牛肉/猪排/羊肉/皮革/羽毛的可持续来源——farms 之后食物安全
// 的第二层保险。鸡用种子、牛羊用小麦、猪用胡萝卜/甜菜根/土豆。
// 前置物品由调用方（goal-planner 链）准备；本技能只做"走近+喂+读回"。
// 爱心粒子不可观测，验证用：喂食成功 = 食物从背包消失 + 实体进入
// love 模式的服务器侧证据不可得 → 以物品消耗 + 双实体仍在场为 Receipt。
// ---------------------------------------------------------------------------

export const ANIMAL_BREED_TIMEOUT_MS = 60_000;

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

const entityUuidSchema = z.string().regex(/^[0-9a-f-]{32,40}$/iu);

/** 物种 → 可用饲料（vanilla 事实，带繁殖语义）。 */
export const BREED_FOOD_BY_ANIMAL: Readonly<Record<string, readonly string[]>> = Object.freeze({
  cow: Object.freeze(["wheat"]),
  sheep: Object.freeze(["wheat"]),
  pig: Object.freeze(["carrot", "potato", "beetroot"]),
  chicken: Object.freeze(["wheat_seeds", "melon_seeds", "pumpkin_seeds", "beetroot_seeds"]),
  rabbit: Object.freeze(["carrot", "golden_carrot", "dandelion"]),
  horse: Object.freeze(["golden_apple", "golden_carrot"]),
  cat: Object.freeze(["cod", "salmon"]),
  wolf: Object.freeze(["most_meats"]),
  fox: Object.freeze(["sweet_berries"]),
  turtle: Object.freeze(["seagrass"]),
  bee: Object.freeze(["flower"]),
  panda: Object.freeze(["bamboo"]),
  hoglin: Object.freeze(["crimson_fungis"]),
  strider: Object.freeze(["warped_fungis"]),
});

export const animalBreedInputSchema = z
  .object({
    animal: z.enum(["cow", "sheep", "pig", "chicken", "rabbit", "fox", "turtle", "bee", "panda", "horse", "cat"]),
    /** 两只待喂实体的 UUID（上层从世界观测选好；身份绑定防错喂）。 */
    firstEntityUuid: entityUuidSchema,
    secondEntityUuid: entityUuidSchema,
    foodItem: itemNameSchema,
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict()
  .refine(
    (input) => input.firstEntityUuid !== input.secondEntityUuid,
    { message: "two distinct entities are required" },
  );

export const animalBreedStateSchema = z
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
      .strip()
      .nullable(),
    /** 背包中饲料计数（null = 快照不可用）。 */
    foodItemCount: z.number().int().min(0).nullable().optional(),
    /** 两目标实体仍在观测范围内（true 才喂）。 */
    entitiesPresent: z.boolean().optional(),
  })
  .strip();

export const animalBreedOutputSchema = z
  .object({
    bred: z.literal(true),
    animal: z.string().min(1).max(32),
    fedEntities: z.number().int().min(2).max(2),
    consumedCount: z.number().int().min(2).max(2),
    /** 爱心粒子不可观测；如实标注为物品消耗回执，不伪造出生判定。 */
    offspringObserved: z.literal(false),
  })
  .strict();

export const animalBreedCapabilityInputSchema = animalBreedInputSchema;
export const animalBreedCapabilityOutputSchema = animalBreedOutputSchema;

export function breedFoodAccepted(animal: string, foodItem: string): boolean {
  const accepted = BREED_FOOD_BY_ANIMAL[animal];
  if (accepted === undefined) return false;
  // wolf 的 "most_meats" 特例：从宽按肉族判定。
  if (accepted.includes("most_meats")) {
    return /(^|_)(beef|porkchop|chicken|mutton|rabbit|rotten)_?$|cooked_/u.test(foodItem);
  }
  return accepted.includes(foodItem);
}

export const animalBreedSkill = defineSkill({
  id: "animal.breed",
  version: "1.0.0",
  progressContract: "INVENTORY_CHANGE",
  inputSchema: animalBreedInputSchema,
  outputSchema: animalBreedOutputSchema,
  stateSchema: animalBreedStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["world.interact", "inventory.write"] as const,
  timeoutMs: ANIMAL_BREED_TIMEOUT_MS,
  // 喂过的动物进入 5 分钟繁殖冷却：重复执行不会多消耗饲料（对账），
  // 但也不会再次触发繁殖——按幂等处理由上层控制频率。
  idempotent: true,
  retryPolicy: {
    maxAttempts: 2,
    baseDelayMs: 500,
    maxDelayMs: 2_000,
    retryableErrorCodes: ["ENTITY_INTERACT_NOT_SETTLED"],
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
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input, state) =>
        state.position !== null && input.dimension === state.position.dimension,
    },
    {
      id: "food.compatible",
      failureCode: "BREED_FOOD_INCOMPATIBLE",
      check: (input) => breedFoodAccepted(input.animal, input.foodItem),
    },
    {
      id: "food.count-known",
      failureCode: "INVENTORY_COUNT_UNKNOWN",
      check: (_input, state) => state.foodItemCount != null,
    },
    {
      id: "food.enough",
      failureCode: "INVENTORY_INSUFFICIENT_ITEMS",
      check: (_input, state) => (state.foodItemCount ?? 0) >= 2,
    },
    {
      id: "entities.present",
      failureCode: "ENTITY_NOT_FOUND",
      check: (_input, state) => state.entitiesPresent !== false,
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "world.interact",
      "animal.breed-safe",
      animalBreedCapabilityInputSchema.parse(input),
    ),
});
