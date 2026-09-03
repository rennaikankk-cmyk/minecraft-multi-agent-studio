import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const SAFE_PATH_MAX_DISTANCE = 64;

/**
 * L7B-1（2026-09-03）：单段安全寻路 20s 默认保持；10-bot 共享 fixture 的
 * 拥挤场景可用 STUDIO_MOVEMENT_GOTO_TIMEOUT_MS 显式放宽（5s-300s 有界，
 * 垃圾值 fail-closed 回默认）。E2E 场景脚本按需设置，不改变生产缺省契约。
 */
const MOVEMENT_TIMEOUT_OVERRIDE_MS = (() => {
  const raw = process.env.STUDIO_MOVEMENT_GOTO_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return 20_000;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 5_000 || value > 300_000) return 20_000;
  return value;
})();
export const SAFE_PATH_TIMEOUT_MS = MOVEMENT_TIMEOUT_OVERRIDE_MS;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const targetPositionSchema = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2_048).max(2_048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

const observedPositionSchema = z
  .object({
    x: z.number().finite().min(-30_000_000).max(30_000_000),
    y: z.number().finite().min(-2_048).max(2_048),
    z: z.number().finite().min(-30_000_000).max(30_000_000),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    // runtime 快照附带朝向角；剥掉语义上不需要，但 strict 下缺失会拒真状态
    yaw: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
  })
  .strict();

export const safeMovementGotoInputSchema = z
  .object({
    target: targetPositionSchema,
    radius: z.number().int().min(1).max(4),
  })
  .strict();

export const safeMovementGotoStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  // 运行时下发的是一份共享 state（还带着背包占用等本技能用不到的字段）。
  // 未知键剥掉而不是 strict 拒绝，否则任何一个技能新增观测字段都会让这里
  // 报 SKILL_STATE_INVALID —— 与 equipArmorStateSchema 同一处理。
  .strip();

export const safeMovementGotoOutputSchema = z
  .object({
    reached: z.literal(true),
    finalPosition: observedPositionSchema,
    distanceToTarget: z.number().finite().min(0).max(SAFE_PATH_MAX_DISTANCE + 8),
  })
  .strict();

export const safeMovementGotoCapabilityInputSchema =
  safeMovementGotoInputSchema;

export const safeMovementGotoCapabilityOutputSchema =
  safeMovementGotoOutputSchema;

type MovementGotoInput = z.infer<typeof safeMovementGotoInputSchema>;
type MovementGotoState = z.infer<typeof safeMovementGotoStateSchema>;

function distance(
  left: MovementGotoInput["target"],
  right: NonNullable<MovementGotoState["position"]>,
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

export const movementGotoSkill = defineSkill({
  id: "movement.goto",
  version: "1.0.0",
  progressContract: "MOVE_TO_TARGET",
  inputSchema: safeMovementGotoInputSchema,
  outputSchema: safeMovementGotoOutputSchema,
  stateSchema: safeMovementGotoStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["bot.move"] as const,
  timeoutMs: SAFE_PATH_TIMEOUT_MS,
  // L2 实证（2026-09-03 重跑）：L0 STUCK（5s 位移<ε，重启后起步瞬态即可触发）
  // → PAUSE_NORMAL_TASKS 取消在飞的 movement.goto → idempotent:false 判
  // NON_IDEMPOTENT_L0_RETRY_UNSAFE 直接 ABORT——而"移动到目标点"对世界零
  // 不可逆副作用，重放只会收敛（重派同目标）。声明 idempotent 后：L0 取消
  // → 安全重放；协调器重启期间在飞移动 → 保守重规划而非 PLANNER_RESTART_
  // RECOVERY_UNSAFE；传输失败 → 直接重试而非背包快照 reconcile（移动无物品
  // 副作用，快照 reconcile 对移动步是语义错误）。
  idempotent: true,
  // L2 实证（2026-09-03 第二轮）：durable 队列在 catalog 接受后 ~100ms 即恢复
  // goal，此刻出生点 chunk 尚未加载完 → pathfinder 55ms NoPath → 终态 FAIL。
  // NoPath 在刚上线窗口是瞬态（chunk 流追上来即可达），movement 已 idempotent，
  // 有界重试语义安全：3 次 × 750ms 基退避给 chunk ~2s 追载窗口。
  retryPolicy: {
    maxAttempts: 3,
    baseDelayMs: 750,
    maxDelayMs: 2_000,
    retryableErrorCodes: ["PATHFINDER_GOTO_FAILED"],
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
      id: "bot.position-available",
      failureCode: "BOT_POSITION_UNAVAILABLE",
      check: (_input, state) => state.position !== null,
    },
    {
      id: "target.server-profile-matches",
      failureCode: "TARGET_SERVER_PROFILE_MISMATCH",
      check: (input, state) =>
        input.target.serverProfileId === state.serverProfileId,
    },
    {
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input, state) =>
        state.position !== null &&
        input.target.dimension === state.position.dimension,
    },
    {
      id: "target.within-safe-range",
      failureCode: "TARGET_OUT_OF_SAFE_RANGE",
      check: (input, state) =>
        state.position !== null &&
        distance(input.target, state.position) <= SAFE_PATH_MAX_DISTANCE,
    },
  ],
  execute: async (context, input) =>
    context.callCapability(
      "bot.move",
      "pathfinder.goto-safe",
      safeMovementGotoCapabilityInputSchema.parse(input),
    ) as Promise<z.infer<typeof safeMovementGotoOutputSchema> | null>,
});
