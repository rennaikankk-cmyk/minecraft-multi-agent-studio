// movement-rejection.ts —— mineflayer-pathfinder 拒绝名 → 技能错码的确定性映射。
//
// 语义（用户审查 2026-09-04 Phase 3 前置检查）：
//  - GoalChanged：旧 Goal 已被替换/取消——**不得自动重试旧 Goal**（重试会
//    和新 Goal 的持有者打架）。非重试码，协调器按中断语义零冷却重选。
//  - PathStopped：主动停止（我们的 stopPathfinder：抢占/中止）= 取消/
//    抢占语义，非重试；**非主动停止**且条件可能仍成立 → 允许有界恢复
//    （走可重试码，3×750ms 预算内）。
//  - NoPath：只有 chunk 追载/世界变化等**明确条件**下才重试——目标列
//    已加载仍无路 = 真不可达，非重试终态。目标列未加载 = 追载中，有界重试。
//  - Timeout：思考预算用尽没有证明不可达 → 有界重试。

export type MovementRejectionContext = Readonly<{
  /** 距离我方主动 stopPathfinder 的毫秒数；null=无近期主动停止。 */
  msSinceIntentionalStop: number | null;
  /** 目标列（x,z chunk）是否已加载；null=无法判定（按已加载保守处理）。 */
  goalColumnLoaded: boolean | null;
}>;

export type MovementRejectionDecision = Readonly<{
  /** 技能错码（进 retryPolicy/Incident 的公共面）。 */
  code:
    | "PATHFINDER_GOTO_FAILED"
    | "MOVEMENT_GOAL_REPLACED"
    | "MOVEMENT_PATH_PREEMPTED"
    | "MOVEMENT_NO_PATH_CONFIRMED"
    | "SKILL_CANCELLED";
  /** 是否允许有界重试（retryPolicy 的 retryableErrorCodes 语义）。 */
  retryable: boolean;
}>;

/** 主动停止的归因窗口：窗口内的 PathStopped 视为我们的停止。 */
export const INTENTIONAL_STOP_ATTRIBUTION_MS = 3_000;

export function classifyMovementRejection(
  errorName: string,
  context: MovementRejectionContext,
): MovementRejectionDecision {
  switch (errorName) {
    case "GoalChanged":
      return { code: "MOVEMENT_GOAL_REPLACED", retryable: false };
    case "PathStopped": {
      const intentional =
        context.msSinceIntentionalStop !== null &&
        context.msSinceIntentionalStop <= INTENTIONAL_STOP_ATTRIBUTION_MS;
      return intentional
        ? { code: "MOVEMENT_PATH_PREEMPTED", retryable: false }
        : { code: "PATHFINDER_GOTO_FAILED", retryable: true };
    }
    case "NoPath": {
      const loaded = context.goalColumnLoaded ?? true; // 不可判定=保守终态
      return loaded
        ? { code: "MOVEMENT_NO_PATH_CONFIRMED", retryable: false }
        : { code: "PATHFINDER_GOTO_FAILED", retryable: true };
    }
    case "Timeout":
      return { code: "PATHFINDER_GOTO_FAILED", retryable: true };
    default:
      // 未知名字：不可重试（ MOVEMENT_INTERNAL_ERROR 由调用方另行处理）。
      return { code: "PATHFINDER_GOTO_FAILED", retryable: false };
  }
}

/** 目标列加载探测：列未加载时 getColumn 抛错 → false（chunk 追载中）。 */
export function goalColumnLoaded(
  world: { getColumn: (x: number, z: number) => unknown },
  x: number,
  z: number,
): boolean | null {
  try {
    world.getColumn(Math.floor(x >> 4), Math.floor(z >> 4));
    return true;
  } catch {
    return false;
  }
}
