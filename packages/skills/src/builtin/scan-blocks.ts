import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 只读方块扫描技能。`site.assess` 只把世界压成 resources 的 0–1 密度分，
// 那个分数无法瞄准 `collect.block`——上层只能拿 `movement.goto` 盲跳去试。
// 本技能补的正是这一段：返回**带坐标的命中结果**，不消耗、不挖掘、不移动。
//
// 它与 `collect.block` 共用 Runtime 侧同一套 registry.blocksByName →
// findBlocks → blockAt 机器，区别只在于把找到的目标交回调用方，
// 而不是喂给采集器。因此这里 requiredCapabilities 是 world.read 而非
// world.interact，idempotent 为 true，也不需要 inventory.has-room：
// 扫描不产出掉落物，背包满不影响它的诚实性。
// ---------------------------------------------------------------------------

export const SCAN_BLOCKS_TIMEOUT_MS = 10_000;
export const SCAN_MAX_COUNT = 32;
export const SCAN_MAX_DISTANCE = 96;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const blockNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);

const observedPositionSchema = z
  .object({
    x: z.number().finite().min(-30_000_000).max(30_000_000),
    y: z.number().finite().min(-2_048).max(2_048),
    z: z.number().finite().min(-30_000_000).max(30_000_000),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    // runtime 快照附带朝向角（与 movement-goto 同一形状）：strict 下缺失会拒真状态
    yaw: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
  })
  .strict();

/**
 * 命中项按整数方块坐标返回，`distance` 是到 Bot 当前位置的直线距离。
 * 坐标不带 dimension/serverProfileId：整次扫描只在一个维度、一个
 * ServerProfile 内进行，那两个事实由输出顶层的 `dimension` 承载，
 * 逐项重复只会给上层第二个可以漂移的副本。
 */
const scanMatchSchema = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2_048).max(2_048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
    distance: z.number().finite().nonnegative(),
  })
  .strict();

export const scanBlocksInputSchema = z
  .object({
    blockName: blockNameSchema,
    maxCount: z.number().int().min(1).max(SCAN_MAX_COUNT),
    maxDistance: z.number().int().min(2).max(SCAN_MAX_DISTANCE),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const scanBlocksStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    // 观测不到位置时为 null，前置条件按"没位置"拒绝（fail-closed）。
    position: observedPositionSchema.nullable(),
  })
  .strip();

export const scanBlocksOutputSchema = z
  .object({
    blockName: blockNameSchema,
    dimension: dimensionSchema,
    /** 已按 distance 升序排列，最近的命中在前。 */
    matches: z.array(scanMatchSchema).max(SCAN_MAX_COUNT),
    /**
     * findBlocks 命中的位置数，可能大于 matches.length：区块未加载时
     * blockAt 读不到方块，那一项就不能进 matches。两个数不相等即说明
     * 这次观测不完整，`complete` 会是 false。
     */
    targetsFound: z.number().int().min(0).max(SCAN_MAX_COUNT),
    /** 每个命中位置都读到了方块数据才为 true。 */
    complete: z.boolean(),
  })
  .strict();

export const scanBlocksCapabilityInputSchema = scanBlocksInputSchema;
export const scanBlocksCapabilityOutputSchema = scanBlocksOutputSchema;

export const scanBlocksSkill = defineSkill({
  id: "world.scan",
  version: "1.0.0",
  progressContract: "WAITING_EXTERNAL",
  inputSchema: scanBlocksInputSchema,
  outputSchema: scanBlocksOutputSchema,
  stateSchema: scanBlocksStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["world.read"] as const,
  timeoutMs: SCAN_BLOCKS_TIMEOUT_MS,
  idempotent: true,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 100,
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
      // 只读也照样受 L0 约束：暂停期间上层不该继续推进任务，
      // 让扫描例外就等于给暂停开了一个绕道。
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
  ],
  execute: async (context, input) =>
    scanBlocksCapabilityOutputSchema.parse(
      await context.callCapability(
        "world.read",
        "world.scan-blocks-safe",
        scanBlocksCapabilityInputSchema.parse(input),
      ),
    ),
});
