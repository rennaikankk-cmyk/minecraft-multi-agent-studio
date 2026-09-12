import { describe, expect, it } from "vitest";

import {
  BUCKET_FILL_TIMEOUT_MS,
  FOOD_EAT_TIMEOUT_MS,
  SLEEP_BED_TIMEOUT_MS,
  assessBedUse,
  bucketFillInputSchema,
  bucketFillSkill,
  foodEatInputSchema,
  foodEatSkill,
  sleepBedInputSchema,
  sleepBedSkill,
} from "../src/index.js";
import {
  SLEEP_WINDOW_CLEAR,
  SLEEP_WINDOW_RAIN,
  SLEEP_WINDOW_THUNDERSTORM,
  sleepableWindow,
  sleepWeatherFrom,
} from "../src/builtin/sleep-bed.js";
import { MAX_HUNGER } from "../src/commons/food-values.js";

// ---------------------------------------------------------------------------
// 三个基础动作技能（food.eat / sleep.bed / bucket.fill）的静态契约测试。
//
// 这里只测**不碰世界**的那一半：入参 schema、前置条件、超时/幂等声明、
// 能力接线。真正会碰世界的执行路径在 apps/bot-runtime/tests/basic-actions.test.ts
// 用假 bot 打——本文件不断言任何"操作成功"，因为纯测试拿不到读回。
// ---------------------------------------------------------------------------

function evaluatePreconditions(
  skill: {
    preconditions: ReadonlyArray<{
      id: string;
      failureCode: string;
      check: (input: unknown, state: unknown, policy?: unknown) => boolean;
    }>;
  },
  input: unknown,
  state: unknown,
) {
  // 策略桩：6 格内可达。形状必须与 SkillPolicyView 一致——checkBlockReach
  // 返回 `{ allowed }` 而不是裸 boolean（reach.ts 读的是 `.allowed`）。
  const policy = { checkBlockReach: (distance: number) => ({ allowed: distance <= 6 }) };
  for (const precondition of skill.preconditions) {
    if (!precondition.check(input, state, policy)) {
      return { ok: false, failureCode: precondition.failureCode, preconditionId: precondition.id };
    }
  }
  return { ok: true, failureCode: null, preconditionId: null };
}

function onlineState(extra: Record<string, unknown> = {}) {
  return {
    online: true,
    normalActionsAllowed: true,
    serverProfileId: "srv-test",
    position: {
      x: 0, y: 64, z: 0,
      dimension: "minecraft:overworld",
      serverProfileId: "srv-test",
      yaw: 0,
      pitch: 0,
    },
    ...extra,
  };
}

const BASE = { serverProfileId: "srv-test" };
const OVERWORLD = "minecraft:overworld";

describe("food.eat", () => {
  const input = foodEatInputSchema.parse({ itemName: "bread", dimension: OVERWORLD, ...BASE });

  it("declares the basic-action contract: non-idempotent, single attempt, one capability", () => {
    expect(foodEatSkill.id).toBe("food.eat");
    expect(foodEatSkill.requiredCapabilities).toEqual(["world.interact"]);
    // 吃一口少一件：非幂等，且不给任何可重试码（盲重试 = 连吃）。
    expect(foodEatSkill.idempotent).toBe(false);
    expect(foodEatSkill.retryPolicy.maxAttempts).toBe(1);
    expect(foodEatSkill.retryPolicy.retryableErrorCodes).toEqual([]);
    expect(foodEatSkill.timeoutMs).toBe(FOOD_EAT_TIMEOUT_MS);
  });

  it("rejects bad item names and unknown props", () => {
    expect(foodEatInputSchema.safeParse({ itemName: "Bread", dimension: OVERWORLD, ...BASE }).success).toBe(false);
    expect(foodEatInputSchema.safeParse({ itemName: "bread", dimension: OVERWORLD, extra: 1, ...BASE }).success).toBe(false);
  });

  it("keeps connection and L0 gates first, then hunger/food gates", () => {
    const state = onlineState({ hunger: 10, foodItemCount: 2 });
    expect(foodEatSkill.preconditions.map(({ failureCode }) => failureCode)).toEqual([
      "BOT_NOT_ONLINE",
      "NORMAL_ACTIONS_PAUSED",
      "TARGET_SERVER_PROFILE_MISMATCH",
      "BOT_HUNGER_UNKNOWN",
      "FOOD_NOT_NEEDED",
      "INVENTORY_COUNT_UNKNOWN",
      "INVENTORY_INSUFFICIENT_ITEMS",
    ]);
    expect(evaluatePreconditions(foodEatSkill, input, state).ok).toBe(true);
  });

  it("fails closed when the hunger snapshot is unavailable (BOT_HUNGER_UNKNOWN)", () => {
    const state = onlineState({ hunger: null, foodItemCount: 2 });
    expect(evaluatePreconditions(foodEatSkill, input, state).failureCode).toBe("BOT_HUNGER_UNKNOWN");
  });

  it("refuses to eat at full hunger (FOOD_NOT_NEEDED — the commons waste rule)", () => {
    const state = onlineState({ hunger: MAX_HUNGER, foodItemCount: 2 });
    expect(evaluatePreconditions(foodEatSkill, input, state).failureCode).toBe("FOOD_NOT_NEEDED");
  });

  it("fails closed on unknown food count and refuses an empty stack", () => {
    expect(evaluatePreconditions(foodEatSkill, input, onlineState({ hunger: 10 })).failureCode)
      .toBe("INVENTORY_COUNT_UNKNOWN");
    expect(evaluatePreconditions(foodEatSkill, input, onlineState({ hunger: 10, foodItemCount: 0 })).failureCode)
      .toBe("INVENTORY_INSUFFICIENT_ITEMS");
  });

  it("refuses an offline bot and a paused L0 layer", () => {
    expect(evaluatePreconditions(foodEatSkill, input, onlineState({ online: false, hunger: 10, foodItemCount: 1 })).failureCode)
      .toBe("BOT_NOT_ONLINE");
    expect(evaluatePreconditions(foodEatSkill, input, onlineState({ normalActionsAllowed: false, hunger: 10, foodItemCount: 1 })).failureCode)
      .toBe("NORMAL_ACTIONS_PAUSED");
  });
});

describe("sleep.bed", () => {
  const input = sleepBedInputSchema.parse({
    bed: { x: 4, y: 64, z: 4 }, dimension: OVERWORLD, ...BASE,
  });
  const nightState = () =>
    onlineState({ timeOfDay: 15_000, isRaining: false, bedBlockName: "red_bed", bedOccupied: false, bedHeadroomClear: true });

  it("declares the basic-action contract: non-idempotent, single attempt, one capability", () => {
    expect(sleepBedSkill.id).toBe("sleep.bed");
    expect(sleepBedSkill.requiredCapabilities).toEqual(["world.interact"]);
    expect(sleepBedSkill.idempotent).toBe(false);
    expect(sleepBedSkill.retryPolicy.maxAttempts).toBe(1);
    expect(sleepBedSkill.retryPolicy.retryableErrorCodes).toEqual([]);
    expect(sleepBedSkill.timeoutMs).toBe(SLEEP_BED_TIMEOUT_MS);
  });

  it("accepts a well-formed bed position and rejects a fractional one", () => {
    expect(sleepBedInputSchema.parse({ bed: { x: 0, y: 64, z: 0 }, dimension: OVERWORLD, ...BASE }).bed)
      .toEqual({ x: 0, y: 64, z: 0 });
    expect(sleepBedInputSchema.safeParse({ bed: { x: 0.5, y: 64, z: 0 }, dimension: OVERWORLD, ...BASE }).success)
      .toBe(false);
  });

  it("uses the vanilla three-tier sleep window (clear 12523–23477, rain 12002–23998, thunderstorm any)", () => {
    // 一手出处见 sleep-bed.ts 常量注释（minecraft.wiki《Bed》Sleeping 小节）。
    expect(SLEEP_WINDOW_CLEAR).toEqual({ start: 12_523, end: 23_477 });
    expect(SLEEP_WINDOW_RAIN).toEqual({ start: 12_002, end: 23_998 });
    expect(SLEEP_WINDOW_THUNDERSTORM).toBeNull();
  });

  it("gates the clear-weather window on both boundaries", () => {
    expect(sleepableWindow(12_522)).toBe(false);
    expect(sleepableWindow(12_523)).toBe(true);
    expect(sleepableWindow(23_477)).toBe(true);
    expect(sleepableWindow(23_478)).toBe(false);
    expect(sleepableWindow(0)).toBe(false);
    expect(sleepableWindow(12_000)).toBe(false);
  });

  it("widens the window while raining — but tick 500 is still not sleepable", () => {
    expect(sleepableWindow(12_001, { raining: true })).toBe(false);
    expect(sleepableWindow(12_002, { raining: true })).toBe(true);
    expect(sleepableWindow(23_998, { raining: true })).toBe(true);
    expect(sleepableWindow(23_999, { raining: true })).toBe(false);
    // 修复前这里会错：把"任意下雨"当成全天可睡。
    expect(sleepableWindow(500, { raining: true })).toBe(false);
    expect(sleepableWindow(500, { raining: true, thundering: false })).toBe(false);
  });

  it("opens the whole day only during a thunderstorm, and never for NaN", () => {
    expect(sleepableWindow(500, { thundering: true })).toBe(true);
    expect(sleepableWindow(500, { raining: true, thundering: true })).toBe(true);
    expect(sleepableWindow(500)).toBe(false);
    expect(sleepableWindow(Number.NaN)).toBe(false);
    expect(sleepableWindow(Number.NaN, { thundering: true })).toBe(false);
    expect(sleepableWindow(Number.POSITIVE_INFINITY, { thundering: true })).toBe(false);
  });

  it("normalizes raw weather facts without widening the window on missing data", () => {
    expect(sleepWeatherFrom({})).toEqual({ raining: false, thundering: false });
    expect(sleepWeatherFrom({ isRaining: true })).toEqual({ raining: true, thundering: false });
    expect(sleepWeatherFrom({ thunderState: 1 })).toEqual({ raining: false, thundering: true });
    expect(sleepWeatherFrom({ isThundering: true })).toEqual({ raining: false, thundering: true });
    expect(sleepWeatherFrom({ thunderState: 0 })).toEqual({ raining: false, thundering: false });
    // 读不到雷暴 → 退回晴天窗口，而不是放宽成全天。
    expect(sleepableWindow(500, sleepWeatherFrom({ thunderState: null }))).toBe(false);
    expect(sleepableWindow(15_000, sleepWeatherFrom({ isRaining: true, thunderState: null }))).toBe(true);
  });

  it("matches the commons hazard table on the bed-explodes dimensions", () => {
    expect(assessBedUse(OVERWORLD).allowed).toBe(true);
    expect(assessBedUse("minecraft:the_nether").allowed).toBe(false);
    expect(assessBedUse("minecraft:the_end").allowed).toBe(false);
    // 未知维度取保守档：不能睡（不从缺失数据推出有利结论）。
    expect(assessBedUse("minecraft:unknown_dimension").allowed).toBe(false);
  });

  it("passes every gate in the overworld at night", () => {
    expect(evaluatePreconditions(sleepBedSkill, input, nightState()).ok).toBe(true);
  });

  it("refuses the nether and the end with BED_EXPLODES", () => {
    for (const dimension of ["minecraft:the_nether", "minecraft:the_end"]) {
      const netherInput = sleepBedInputSchema.parse({ bed: { x: 4, y: 64, z: 4 }, dimension, ...BASE });
      const state = onlineState({
        timeOfDay: 15_000, bedBlockName: "red_bed", bedOccupied: false, bedHeadroomClear: true,
        position: { x: 0, y: 64, z: 0, dimension, serverProfileId: "srv-test" },
      });
      expect(evaluatePreconditions(sleepBedSkill, netherInput, state).failureCode, dimension)
        .toBe("BED_EXPLODES");
    }
  });

  it("refuses daytime and fails closed on unknown time; bed facts stay adapter-side", () => {
    expect(evaluatePreconditions(sleepBedSkill, input, { ...nightState(), timeOfDay: 6_000 }).failureCode)
      .toBe("SLEEP_NOT_NIGHT");
    // 床位/上床/阻挡是**适配器**的硬闸（state 拿不到坐标相关的方块读数），
    // 所以这里只断言技能不把它们错报成前置拒绝：床字段缺失也不该改变结论。
    const bedFactsMissing = { ...nightState() };
    delete (bedFactsMissing as Record<string, unknown>).bedBlockName;
    delete (bedFactsMissing as Record<string, unknown>).bedOccupied;
    delete (bedFactsMissing as Record<string, unknown>).bedHeadroomClear;
    expect(evaluatePreconditions(sleepBedSkill, input, bedFactsMissing).ok).toBe(true);
  });

  it("fails closed when the world time is unknown (BOT_TIME_UNKNOWN)", () => {
    expect(evaluatePreconditions(sleepBedSkill, input, { ...nightState(), timeOfDay: null }).failureCode)
      .toBe("BOT_TIME_UNKNOWN");
    expect(evaluatePreconditions(sleepBedSkill, input, { ...nightState(), timeOfDay: undefined }).failureCode)
      .toBe("BOT_TIME_UNKNOWN");
  });

  it("lets a thunderstorm open the daytime window", () => {
    const stormy = { ...nightState(), timeOfDay: 1_000, isRaining: true, thunderState: 1 };
    expect(evaluatePreconditions(sleepBedSkill, input, stormy).ok).toBe(true);
    // 普通下雨的白天仍然不行（这正是修复前前置会放行的那一格）。
    const rainyDay = { ...nightState(), timeOfDay: 1_000, isRaining: true, thunderState: 0 };
    expect(evaluatePreconditions(sleepBedSkill, input, rainyDay).failureCode).toBe("SLEEP_NOT_NIGHT");
  });

  it("keeps the precondition verdict identical to sleepableWindow for the same raw facts", () => {
    // 前置只独立读世界事实，判定必须**逐格**等于唯一实现 sleepableWindow。
    for (const timeOfDay of [0, 500, 12_001, 12_002, 12_522, 12_523, 15_000, 23_477, 23_478, 23_998, 23_999]) {
      for (const [isRaining, thunderState] of [[false, 0], [true, 0], [true, 1], [false, 1]] as const) {
        const state = { ...nightState(), timeOfDay, isRaining, thunderState };
        const expected = sleepableWindow(timeOfDay, sleepWeatherFrom(state));
        const result = evaluatePreconditions(sleepBedSkill, input, state);
        expect(result.ok, `timeOfDay=${timeOfDay} rain=${isRaining} thunder=${thunderState}`).toBe(expected);
        if (!expected) expect(result.failureCode).toBe("SLEEP_NOT_NIGHT");
      }
    }
  });

  it("keeps the connection/L0/profile/dimension gates ahead of the bed gates", () => {
    expect(sleepBedSkill.preconditions.map(({ failureCode }) => failureCode)).toEqual([
      "BOT_NOT_ONLINE",
      "NORMAL_ACTIONS_PAUSED",
      "TARGET_SERVER_PROFILE_MISMATCH",
      "TARGET_DIMENSION_MISMATCH",
      "BED_EXPLODES",
      "BOT_TIME_UNKNOWN",
      "SLEEP_NOT_NIGHT",
    ]);
    // 床方块事实（present/occupied/headroom）刻意**不在**前置里：state 拿不到
    // 坐标相关的方块读数，硬塞会让这条前置永远不可能满足。它们在适配器里判。
    expect(sleepBedSkill.preconditions.map(({ id }) => id)).not.toContain("bed.present");
    const mismatched = sleepBedInputSchema.parse({ bed: { x: 4, y: 64, z: 4 }, dimension: "minecraft:the_nether", ...BASE });
    expect(evaluatePreconditions(sleepBedSkill, mismatched, nightState()).failureCode)
      .toBe("TARGET_DIMENSION_MISMATCH");
  });
});

describe("bucket.fill", () => {
  const input = bucketFillInputSchema.parse({
    mode: "water", target: { x: 1, y: 64, z: 0 }, dimension: OVERWORLD, ...BASE,
  });

  it("declares the basic-action contract: non-idempotent, single attempt, one capability", () => {
    expect(bucketFillSkill.id).toBe("bucket.fill");
    expect(bucketFillSkill.requiredCapabilities).toEqual(["world.interact"]);
    expect(bucketFillSkill.idempotent).toBe(false);
    expect(bucketFillSkill.retryPolicy.maxAttempts).toBe(1);
    expect(bucketFillSkill.retryPolicy.retryableErrorCodes).toEqual([]);
    expect(bucketFillSkill.timeoutMs).toBe(BUCKET_FILL_TIMEOUT_MS);
  });

  it("accepts water/lava modes and rejects anything else", () => {
    expect(bucketFillInputSchema.parse({ mode: "lava", target: { x: 0, y: 64, z: 0 }, dimension: OVERWORLD, ...BASE }).mode)
      .toBe("lava");
    expect(bucketFillInputSchema.safeParse({ mode: "milk", target: { x: 0, y: 64, z: 0 }, dimension: OVERWORLD, ...BASE }).success)
      .toBe(false);
  });

  it("requires an empty bucket and a known snapshot", () => {
    expect(evaluatePreconditions(bucketFillSkill, input, onlineState({ bucketCounts: null })).failureCode)
      .toBe("INVENTORY_COUNT_UNKNOWN");
    expect(evaluatePreconditions(bucketFillSkill, input, onlineState({
      bucketCounts: { bucket: 0, water_bucket: 3, lava_bucket: 0 },
    })).failureCode).toBe("FLUID_BUCKET_MISSING");
    // 全部前置都过：能力调用前的最后一道门是 reach，经 policy 桩放行。
    const stocked = onlineState({
      bucketCounts: { bucket: 2, water_bucket: 0, lava_bucket: 0 },
      position: { x: 1, y: 64, z: 0, dimension: OVERWORLD, serverProfileId: "srv-test", yaw: 0, pitch: 0 },
    });
    const verdict = evaluatePreconditions(bucketFillSkill, input, stocked);
    expect(verdict.failureCode, String(verdict.preconditionId)).toBeNull();
    expect(verdict.ok).toBe(true);
  });

  it("refuses a target out of policy reach (TARGET_OUT_OF_REACH)", () => {
    const far = bucketFillInputSchema.parse({
      mode: "water", target: { x: 40, y: 64, z: 0 }, dimension: OVERWORLD, ...BASE,
    });
    expect(evaluatePreconditions(bucketFillSkill, far, onlineState({
      bucketCounts: { bucket: 2, water_bucket: 0, lava_bucket: 0 },
    })).failureCode).toBe("TARGET_OUT_OF_REACH");
  });

  it("keeps the connection/L0/profile/dimension gates ahead of the bucket gates", () => {
    expect(bucketFillSkill.preconditions.map(({ failureCode }) => failureCode)).toEqual([
      "BOT_NOT_ONLINE",
      "NORMAL_ACTIONS_PAUSED",
      "TARGET_SERVER_PROFILE_MISMATCH",
      "TARGET_DIMENSION_MISMATCH",
      "INVENTORY_COUNT_UNKNOWN",
      "FLUID_BUCKET_MISSING",
      "TARGET_OUT_OF_REACH",
    ]);
  });
});

describe("basic-action output schemas carry readback facts, not a bare ok", () => {
  it("rejects an output that only claims success", () => {
    // 这条断言是"证据必须来自读回"的静态保证：只回 { succeeded: true } 会被
    // schema 挡下来——每个 success 字段旁边都必须有对应的读回事实。
    expect(foodEatSkill.outputSchema.safeParse({ succeeded: true }).success).toBe(false);
    expect(sleepBedSkill.outputSchema.safeParse({ succeeded: true }).success).toBe(false);
    expect(bucketFillSkill.outputSchema.safeParse({ succeeded: true }).success).toBe(false);
  });

  it("accepts a complete readback record for each", () => {
    expect(foodEatSkill.outputSchema.safeParse({
      succeeded: true, itemName: "bread", remainingCount: 1, consumedCount: 1,
      hungerBefore: 10, hungerAfter: 15, saturationBefore: 2, saturationAfter: 8,
      projectedSaturationGain: 6, reasonCode: "BEST_SATURATION_EFFICIENCY",
    }).success).toBe(true);
    expect(sleepBedSkill.outputSchema.safeParse({
      succeeded: true, isSleepingAfter: true, sleepableWindowAtAttempt: true,
      timeOfDayAtAttempt: 15_000, timeOfDayAfter: 15_000, bedBlockName: "red_bed",
      position: { x: 4, y: 64, z: 4 },
    }).success).toBe(true);
    expect(bucketFillSkill.outputSchema.safeParse({
      succeeded: true, mode: "water", filledItemName: "water_bucket",
      emptyBucketBefore: 2, emptyBucketAfter: 1, filledBucketBefore: 0, filledBucketAfter: 1,
      resultingBlockName: "air", position: { x: 1, y: 64, z: 0 },
    }).success).toBe(true);
  });

  it("refuses a fill readback whose filled bucket contradicts its mode", () => {
    expect(bucketFillSkill.outputSchema.safeParse({
      succeeded: true, mode: "water", filledItemName: "lava_bucket",
      emptyBucketBefore: 2, emptyBucketAfter: 1, filledBucketBefore: 0, filledBucketAfter: 1,
      resultingBlockName: "air", position: { x: 1, y: 64, z: 0 },
    }).success).toBe(false);
  });
});
