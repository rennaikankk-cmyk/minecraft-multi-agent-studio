// Goal store 装配语义的单一事实源。
//
// 背景（Round 6.1 P0-1）：planner 自 Round 6 起无条件装配（确定性兜底），
// 但 goalStore 只在 PostgreSQL 或显式 COORDINATOR_LOCAL_MEMORY_MODE=1 时存在。
// 四进程 offline-quality fixture 两者都没声明，撞上 ControlLinkServer 的
// durable-storage 构造守卫。这里把"哪个模式下允许哪种 store"收敛成一个纯函数，
// main.ts 在构造前用它做结构化 fail-closed 诊断，而不是让 TypeError 深埋在
// COORDINATOR_START_FAILED 里。
//
// 语义（不变式，与本文件测试一一对应）：
// - PostgreSQL 配置存在            → "postgresql"（production durable）
// - 无 PG + 显式 local memory mode → "local-memory"（仅限 offline/test/desktop fixture）
// - 两者皆无                       → "none"
// - mode "none" 且 planner 已装配  → COORDINATOR_GOAL_STORE_REQUIRED（fail closed，
//   不允许 production 静默降级到内存）

export type GoalStoreMode = "postgresql" | "local-memory" | "none";

export class GoalStoreWiringError extends Error {
  readonly code = "COORDINATOR_GOAL_STORE_REQUIRED";

  constructor(message: string) {
    super(message);
    this.name = "GoalStoreWiringError";
  }
}

export function resolveGoalStoreMode(input: {
  hasPersistenceConfig: boolean;
  localMemoryMode: boolean;
}): GoalStoreMode {
  if (input.hasPersistenceConfig) {
    return "postgresql";
  }
  return input.localMemoryMode ? "local-memory" : "none";
}

/**
 * planner 装配而无 store 时 fail closed（结构化 FailureCode）。
 * 返回值供启动日志使用；抛错路径发生在任何服务器 start 之前。
 */
export function assertGoalStoreWiring(input: {
  mode: GoalStoreMode;
  hasPlanner: boolean;
}): GoalStoreMode {
  if (input.mode === "none" && input.hasPlanner) {
    throw new GoalStoreWiringError(
      "Goal execution is assembled (planner present) but no goal store is configured. " +
        "Set COORDINATOR_TASK_POSTGRES_URL for the durable store, or declare the explicit " +
        "offline fixture mode with COORDINATOR_LOCAL_MEMORY_MODE=1. " +
        "Production must not silently fall back to an in-memory store.",
    );
  }
  return input.mode;
}
