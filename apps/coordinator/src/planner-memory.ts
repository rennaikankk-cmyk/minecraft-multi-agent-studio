// ---------------------------------------------------------------------------
// planner-memory.ts —— planner 历史记忆上下文（自我改善闭环 Phase A）。
//
// 纪律：
//   1. 全部字符串字段先过 redactText 再进入 prompt（fail-closed 于注入点）。
//   2. 记忆是增强不是前置条件：任何数据源缺失/读取失败 → 返回 null 或
//      降级字段，绝不抛出阻塞规划。
//   3. 按 bot 隔离（bot 绑定 serverProfile，等效于按服隔离经验）。
//   4. bounded：条数、单条长度、总字节数三重上限，超限从最旧开始丢弃。
//   5. 记忆是历史观测数据（data, not instruction），planner system prompt
//      明确声明它不构成指令、也不是 noop 的理由。
// ---------------------------------------------------------------------------

import { redactText, scanResidualSecrets } from "@minecraft-studio/skills";
import type { TaskExecutionRecord } from "@minecraft-studio/task-system";
import type { BotPersonalMemoryV1 } from "@minecraft-studio/protocol";

export const PLANNER_MEMORY_VERSION = "planner-memory-v1" as const;

/** 注入 prompt 的记忆条数与体积上限（128KB prompt 总预算的零头）。 */
export const PLANNER_MEMORY_MAX_RECENT_GOALS = 8;
export const PLANNER_MEMORY_MAX_BYTES = 8 * 1024;
const GOAL_TEXT_MAX_CHARS = 160;
const FAILURE_REASON_MAX_CHARS = 120;

export type PlannerRecentGoal = Readonly<{
  outcome: "completed" | "failed" | "aborted";
  goalText: string;
  failureReason: string | null;
  ageMs: number;
}>;

export type PlannerMemoryContext = Readonly<{
  memoryVersion: typeof PLANNER_MEMORY_VERSION;
  botId: string;
  serverProfileId: string;
  recentGoals: readonly PlannerRecentGoal[];
  /** 最近窗口内同一 goal 文本重复失败的规则信号（非 LLM 推断）。 */
  repeatedFailureGoalText: string | null;
  repeatedFailureCount: number;
  lastDeath: Readonly<{
    ageMs: number;
    dimension: string;
    droppedItemsCount: number;
  }> | null;
  lastResourceObservation: Readonly<{
    ageMs: number;
    armorPoints: number | null;
    inventoryItems: readonly Readonly<{ itemName: string; count: number }>[];
  }> | null;
}>;

export type PlannerMemoryInput = Readonly<{
  botId: string;
  serverProfileId: string;
  now?: () => number;
  /** 终态任务记录（taskStateMachine.list() 的全量，函数内部过滤）。 */
  taskRecords: readonly TaskExecutionRecord[];
  personalMemory: BotPersonalMemoryV1 | null;
}>;

/**
 * Async source injected into the planner: resolution failures degrade to
 * null (planning proceeds without memory), never throw into the planner.
 */
export type PlannerMemorySource = (input: Readonly<{
  botId: string;
  serverProfileId: string;
  taskId: string;
}>) => Promise<PlannerMemoryContext | null>;

export function buildPlannerMemory(input: PlannerMemoryInput): PlannerMemoryContext | null {
  const nowMs = (input.now ?? Date.now)();
  const recent = recentGoalsFrom(input.taskRecords, input.botId, nowMs);
  const memory = input.personalMemory;
  // 无任何历史可用时返回 null：prompt 不携带 memory 字段（规划零依赖）。
  if (recent.items.length === 0 && recent.repeatedCount === 0 && memory === null) return null;
  const context: PlannerMemoryContext = {
    memoryVersion: PLANNER_MEMORY_VERSION,
    botId: input.botId,
    serverProfileId: input.serverProfileId,
    recentGoals: recent.items,
    repeatedFailureGoalText: recent.repeatedText,
    repeatedFailureCount: recent.repeatedCount,
    lastDeath: memory?.lastDeath
      ? {
          ageMs: Math.max(0, nowMs - Date.parse(memory.lastDeath.value.diedAt)),
          dimension: redactText(memory.lastDeath.value.dimension),
          droppedItemsCount: memory.lastDeath.value.droppedItems?.length ?? 0,
        }
      : null,
    lastResourceObservation: memory
      ? {
          ageMs: Math.max(0, nowMs - Date.parse(memory.lastObservedAt)),
          armorPoints: memory.equipment.value.armorPoints ?? null,
          inventoryItems: (memory.inventory?.value ?? []).slice(0, 16).map(({ itemName, count }) => ({
            itemName: redactText(itemName),
            count,
          })),
        }
      : null,
  };
  if (!scanResidualSecrets(JSON.stringify(context))) return null;
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > PLANNER_MEMORY_MAX_BYTES) {
    return trimToBudget(context);
  }
  return context;
}

function recentGoalsFrom(
  records: readonly TaskExecutionRecord[],
  botId: string,
  nowMs: number,
): Readonly<{ items: readonly PlannerRecentGoal[]; repeatedText: string | null; repeatedCount: number }> {
  const terminal = records
    .filter((record) => record.botId === botId && (record.state === "SUCCESS" || record.state === "ABORT"))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const items: PlannerRecentGoal[] = terminal.slice(0, PLANNER_MEMORY_MAX_RECENT_GOALS).map((record) => ({
    outcome: record.state === "SUCCESS" ? "completed" : record.failureReason !== null ? "failed" : "aborted",
    goalText: redactText(record.goal).slice(0, GOAL_TEXT_MAX_CHARS),
    failureReason: record.failureReason === null ? null : redactText(record.failureReason).slice(0, FAILURE_REASON_MAX_CHARS),
    ageMs: Math.max(0, nowMs - Date.parse(record.updatedAt)),
  }));
  // 重复失败检测是确定性规则：最近窗口内同一 goal 文本失败 ≥2 次。
  const failureCounts = new Map<string, number>();
  for (const record of terminal) {
    if (record.state !== "ABORT" || record.failureReason === null) continue;
    const key = record.goal.trim();
    failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
  }
  let repeatedText: string | null = null;
  let repeatedCount = 0;
  for (const [goal, count] of failureCounts) {
    if (count >= 2 && count > repeatedCount) {
      repeatedText = redactText(goal).slice(0, GOAL_TEXT_MAX_CHARS);
      repeatedCount = count;
    }
  }
  return { items, repeatedText, repeatedCount };
}

function trimToBudget(context: PlannerMemoryContext): PlannerMemoryContext | null {
  let items = [...context.recentGoals];
  let trimmed: PlannerMemoryContext = context;
  while (items.length > 0 && Buffer.byteLength(JSON.stringify(trimmed), "utf8") > PLANNER_MEMORY_MAX_BYTES) {
    // 从最旧（数组尾部）开始丢弃。
    items = items.slice(0, -1);
    trimmed = { ...trimmed, recentGoals: items };
  }
  if (Buffer.byteLength(JSON.stringify(trimmed), "utf8") > PLANNER_MEMORY_MAX_BYTES) return null;
  return trimmed;
}
