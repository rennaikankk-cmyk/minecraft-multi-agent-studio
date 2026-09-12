import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { assessBedUse } from "../commons/hazards.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// sleep.bed —— 睡一觉到天亮（并顺带把重生点绑到床边）。
//
// 生存价值：夜晚是敌意生物的主场，也是唯一能不打架度过夜晚的手段；睡觉还会
// 把重生点设到床边——对"死了就掉光装备"的服务器，这是最便宜的一条保命线。
//
// 三处**确定性**拒绝（AGENTS.md §0.1：确定性代码决定，不是模型）：
//   1. 下界/末地——床会爆炸。这一条同时写在技能前置与能力适配器里：前置是
//      给规划器的可见拒绝，适配器是最后一道硬闸（前置可以被绕过，闸不行）。
//      判定调用 commons/hazards.ts 的 assessBedUse，维度清单不在本文件重写。
//   2. 非可睡窗口——原版判据是"内部天空光照 ≤ 11"，在地表标准情形下表现为
//      三档 tick 窗口（晴天 12523–23477、下雨 12002–23998、雷暴全天）。
//      判定只有 commons 之外的 sleepableWindow 一处实现（见下方常量注释），
//      技能前置与适配器共用它；时间读数缺失按 BOT_TIME_UNKNOWN 拒绝。
//   3. 床被占（occupied 属性）或床上方有阻挡——原版要求床上有空间。
//
// 为什么非幂等：睡一觉改变世界状态（时间推进/重生点绑定）且执行期间 bot 会
// 停止响应普通动作；重复执行不是"再睡一次"而是"又一次不可控的暂停"。
// 另外一次性动作必须带读回：结果里 isSleepingAfter 与 timeOfDayAfter 都是
// 服务器侧读回，不是"sleep() 没抛错"。
// ---------------------------------------------------------------------------

export const SLEEP_BED_TIMEOUT_MS = 20_000;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const blockPositionSchema = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2_048).max(2_048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  })
  .strict();

export const sleepBedInputSchema = z
  .object({
    /** 床头或床尾的方块坐标（上层从世界观测选好；必须是床方块）。 */
    bed: blockPositionSchema,
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const sleepBedStateSchema = z
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
    /** 世界时间（tick，0..24000）。null/缺失 = 读数不可用 → fail-closed。 */
    timeOfDay: z.number().min(0).max(24_000).nullable().optional(),
    /** 世界是否在下雨（下雨档窗口更宽）。缺失按"没下雨"处理（不放大可睡范围）。 */
    isRaining: z.boolean().optional(),
    /** 雷暴强度读回（mineflayer 的 bot.thunderState；>0 即雷暴）。 */
    thunderState: z.number().nullable().optional(),
    /** 部分服务器/适配器直接给出雷暴布尔量；与 thunderState 取或。 */
    isThundering: z.boolean().optional(),
  })
  .strip();

export const sleepBedOutputSchema = z
  .object({
    /** 只有读回成立才会返回这个对象；字段全部是读回事实。 */
    succeeded: z.literal(true),
    /** 读回：服务器 entitySleep 之后的 bot.isSleeping。 */
    isSleepingAfter: z.literal(true),
    /** 尝试时的睡眠窗口判定（夜晚或雷暴）。 */
    sleepableWindowAtAttempt: z.boolean(),
    timeOfDayAtAttempt: z.number().min(0).max(24_000),
    /** 醒来后的时间读数；读不到时为 null。 */
    timeOfDayAfter: z.number().min(0).max(24_000).nullable(),
    /** 真正被激活的床方块名（读回）。 */
    bedBlockName: z.string().min(1).max(64),
    position: blockPositionSchema,
  })
  .strict();

export const sleepBedCapabilityInputSchema = sleepBedInputSchema;
export const sleepBedCapabilityOutputSchema = sleepBedOutputSchema;

/**
 * 把技能 state 里的原始天气读数折成 `sleepableWindow` 的天气事实。
 *
 * 只做**归一**，不做判定：判定仍然只有 `sleepableWindow` 一处。
 * `isThundering` 与 `thunderState > 0` 取或（两个都是"现在有没有雷暴"的
 * 原始观测，任一为真即雷暴）；两项都读不到时 thundering 为 false，
 * 于是落到下雨/晴天档——不会因为"读不到"而放宽成全天可睡。
 */
export function sleepWeatherFrom(state: {
  readonly isRaining?: boolean | undefined;
  readonly thunderState?: number | null | undefined;
  readonly isThundering?: boolean | undefined;
}): SleepWeather {
  const thundering =
    state.isThundering === true ||
    (typeof state.thunderState === "number" && state.thunderState > 0);
  return { raining: state.isRaining === true, thundering };
}

/** 睡眠窗口（原版 Java，timeOfDay tick）。
 *
 * 一手出处：minecraft.wiki《Bed》Sleeping 小节原文——
 *   "A player sleeps by using a bed when the internal sky light is 11 or below.
 *    This occurs between 12523 and 23477 ticks in clear weather, when stars appear
 *    in the sky, between 12002 and 23998 ticks in rainy weather, and at any time of
 *    day during thunderstorms."
 *
 * 真正的闸是**内部天空光照 ≤ 11**；下面这三档是该规则在地表标准情形下的表现，
 * 所以它是**近似**判据——服务器永远权威，被拒绝时按正常失败上报，不当 bug。
 */
export const SLEEP_WINDOW_CLEAR: Readonly<{ start: number; end: number }> = Object.freeze({
  start: 12_523,
  end: 23_477,
});
export const SLEEP_WINDOW_RAIN: Readonly<{ start: number; end: number }> = Object.freeze({
  start: 12_002,
  end: 23_998,
});
/** 雷暴档：全天任意时刻（没有窗口边界）。 */
export const SLEEP_WINDOW_THUNDERSTORM: null = null;

/** 天气事实。缺省（无参数 / 字段缺失）一律按**晴天**处理——不放大可睡范围。 */
export interface SleepWeather {
  readonly raining?: boolean | undefined;
  readonly thundering?: boolean | undefined;
}

/**
 * 时间读数是否落在可睡窗口内。纯函数：不掷骰子、不看时钟、不读 bot。
 *
 * 语义（三档互斥，优先级从高到低）：
 *   thundering → true（全天可睡）
 *   raining    → timeOfDay ∈ SLEEP_WINDOW_RAIN
 *   否则        → timeOfDay ∈ SLEEP_WINDOW_CLEAR
 * 非有限值 → false（fail-closed：不假定是夜晚）。
 *
 * 这是睡眠判据的**唯一实现**：技能前置与 bot-runtime 适配器都走这里，
 * 两处只各自独立读世界事实，不各自维护常量。
 */
export function sleepableWindow(timeOfDay: number, weather: SleepWeather = {}): boolean {
  if (!Number.isFinite(timeOfDay)) return false;
  if (weather.thundering === true) return true;
  const window = weather.raining === true ? SLEEP_WINDOW_RAIN : SLEEP_WINDOW_CLEAR;
  return timeOfDay >= window.start && timeOfDay <= window.end;
}

export const sleepBedSkill = defineSkill({
  id: "sleep.bed",
  version: "1.0.0",
  progressContract: "WAITING_EXTERNAL",
  inputSchema: sleepBedInputSchema,
  outputSchema: sleepBedOutputSchema,
  stateSchema: sleepBedStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  // 只碰方块（activateBlock via bot.sleep）；不翻背包、不移动。
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: SLEEP_BED_TIMEOUT_MS,
  // 非幂等：睡觉推进时间并绑定重生点，且期间 bot 不响应普通动作。
  idempotent: false,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 500,
    maxDelayMs: 1_000,
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
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input, state) =>
        state.position !== null && input.dimension === state.position.dimension,
    },
    {
      // 下界/末地：床会爆炸。判定来自 commons/hazards.ts（未知维度也是拒绝档）。
      id: "bed.dimension-allows-sleep",
      failureCode: "BED_EXPLODES",
      check: (input) => assessBedUse(input.dimension).allowed,
    },
    {
      // 床的方块事实（是不是床、有没有被占、床上方有没有阻挡）**没有**放进
      // 前置条件：它依赖对任意坐标的方块读取，运行时的技能 state 是技能无关的
      // 一个对象，天然拿不到这种坐标相关的读数（快照里塞坐标读数会让 state
      // 变成"按 input 变形"的东西，前置条件也就不再是一致快照的纯判断）。
      // 这三项由能力适配器做权威硬闸，并抛同一组稳定码：
      // SLEEP_BED_UNAVAILABLE / BLOCK_NAME_UNKNOWN。判定点下移，语义不丢。
      id: "world.time-known",
      failureCode: "BOT_TIME_UNKNOWN",
      check: (_input, state) => state.timeOfDay != null,
    },
    {
      id: "world.night",
      failureCode: "SLEEP_NOT_NIGHT",
      // 与适配器**同一判据**：都用 sleepableWindow（唯一实现）。
      // 这里只独立读世界事实（timeOfDay / isRaining / thunderState）。
      check: (_input, state) =>
        state.timeOfDay != null && sleepableWindow(state.timeOfDay, sleepWeatherFrom(state)),
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "world.interact",
      "sleep-safe",
      sleepBedCapabilityInputSchema.parse(input),
    ),
});
