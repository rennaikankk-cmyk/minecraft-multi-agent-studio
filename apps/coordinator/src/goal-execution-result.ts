import { AISchedulerError } from "@minecraft-studio/ai-router";
import {
  goalResultSummaryFromOutput,
  type ControlLinkGoalErrorCode,
  type GoalDispatchResultV1,
} from "@minecraft-studio/protocol";

import { GoalLifecycleStoreError } from "./goal-lifecycle-store.js";
import {
  LocalPlannerError,
  type LocalPlanResult,
} from "./local-planner.js";

export function projectGoalDispatchResult(
  identity: Readonly<{ taskId: string; botId: string }>,
  result: LocalPlanResult,
): GoalDispatchResultV1 {
  const ai = {
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
  if (payload.outcome !== "completed") {
    return { ...base, errorCode: payload.errorCode };
  }
  const summary = goalResultSummaryFromOutput(payload.output);
  return summary === undefined ? base : { ...base, summary };
}

export function mapGoalExecutionError(
  cause: unknown,
  timedOut: boolean,
  aborted = false,
): ControlLinkGoalErrorCode {
  if (timedOut) return "AI_TIMEOUT";
  if (aborted) return "CONTROL_LINK_STOPPED";
  if (cause instanceof GoalLifecycleStoreError) return cause.code;
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
