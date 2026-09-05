import { AISchedulerError } from "@minecraft-studio/ai-router";
import { processContinuationCode } from "@minecraft-studio/skills";
import {
  goalDispatchTerminalResultV1Schema,
  goalResultSummaryFromOutput,
  type ControlLinkGoalErrorCode,
  type GoalDispatchTerminalResultV1,
} from "@minecraft-studio/protocol";

import { GoalLifecycleStoreError } from "./goal-lifecycle-store.js";
import { BotAssignmentError } from "./bot-assignment.js";
import {
  LocalPlannerError,
  type LocalPlanResult,
} from "./local-planner.js";

export function projectGoalDispatchResult(
  identity: Readonly<{ taskId: string; botId: string }>,
  result: LocalPlanResult,
): GoalDispatchTerminalResultV1 {
  // Deterministic decisions carry no AI usage record; the projection reports
  // zeroed counters instead of pretending a model round-trip happened.
  const ai = result.ai === null
    ? { attempts: 0, queueTimeMs: 0, executionTimeMs: 0, totalTimeMs: 0 }
    : {
        attempts: result.ai.attempts,
        queueTimeMs: Math.round(result.ai.queueTimeMs),
        executionTimeMs: Math.round(result.ai.executionTimeMs),
        totalTimeMs: Math.round(result.ai.totalTimeMs),
      };
  if (result.action === "noop") {
    return {
      action: "noop",
      botId: identity.botId,
      taskId: identity.taskId,
      reasonCode: result.reasonCode,
      ai,
    };
  }
  const payload = result.result.payload;
  const base = {
    action: "skill_result",
    botId: identity.botId,
    taskId: identity.taskId,
    reasonCode: result.reasonCode,
    skillId: payload.skillId,
    skillVersion: payload.skillVersion,
    outcome: payload.outcome,
    ai,
  } as const;
  const summary = payload.outcome === "completed"
    ? goalResultSummaryFromOutput(payload.output)
    : undefined;
  if (payload.outcome === "completed") {
    const continuation = processContinuationCode(payload.skillId, payload.output);
    if (continuation) return goalDispatchTerminalResultV1Schema.parse({ ...base, outcome: "failed", errorCode: continuation });
  }
  const candidate = payload.outcome !== "completed"
    ? { ...base, errorCode: payload.errorCode }
    : (summary === undefined ? { ...base } : { ...base, summary });
  // 终态出口统一经 schema 收窄（判别联合的手工构造不再依赖推断细节）。
  return goalDispatchTerminalResultV1Schema.parse(candidate);
}

export function mapGoalExecutionError(
  cause: unknown,
  timedOut: boolean,
  aborted = false,
): ControlLinkGoalErrorCode {
  if (timedOut) return "AI_TIMEOUT";
  if (aborted) return "CONTROL_LINK_STOPPED";
  if (cause instanceof GoalLifecycleStoreError) return cause.code;
  if (cause instanceof BotAssignmentError) return "BOT_UNAVAILABLE";
  if (cause instanceof AISchedulerError) {
    if (cause.code === "AI_QUEUE_FULL") return "AI_QUEUE_FULL";
    if (cause.code === "AI_REQUEST_TIMEOUT") return "AI_TIMEOUT";
    return "AI_UNAVAILABLE";
  }
  if (cause instanceof LocalPlannerError) {
    if (cause.code === "PLANNER_TIMEOUT") return "AI_TIMEOUT";
    if (
      cause.code === "PLANNER_BOT_UNAVAILABLE" ||
      cause.code === "PLANNER_BOT_BUSY" ||
      cause.code === "PLANNER_SAFETY_PAUSED" ||
      cause.code === "PLANNER_SKILL_CATALOG_UNAVAILABLE"
    ) {
      return "BOT_UNAVAILABLE";
    }
    return "PLANNER_REJECTED";
  }
  return "SKILL_DISPATCH_FAILED";
}
