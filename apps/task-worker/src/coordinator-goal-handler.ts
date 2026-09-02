import {
  coordinatorGoalExecutionResponseV1Schema,
  COORDINATOR_GOAL_EXECUTION_PATH,
  identifierSchema,
  type GoalDispatchTerminalResultV1,
  type SkillJsonValue,
} from "@minecraft-studio/protocol";
import {
  TaskHandlerRegistry,
  type TaskHandlerDefinition,
  type TaskHandlerResult,
} from "@minecraft-studio/task-system";

export const COORDINATOR_GOAL_TASK_TYPE = "coordinator.goal";
export const COORDINATOR_GOAL_HANDLER_VERSION = "1.0.0";

export type CoordinatorGoalHandlerOptions = Readonly<{
  baseUrl: string;
  secret: string;
  /** Stable identity of the Task Worker process executing this handler. */
  workerInstanceId: string;
  fetchImplementation?: typeof fetch;
}>;

export function createCoordinatorGoalHandler(
  options: CoordinatorGoalHandlerOptions,
): TaskHandlerDefinition {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  if (!baseUrl.startsWith("http://127.0.0.1:") &&
      !baseUrl.startsWith("http://[::1]:")) {
    throw new TypeError("Coordinator goal handler URL must target loopback.");
  }
  if (options.secret.length < 32 || options.secret.length > 512) {
    throw new TypeError("Coordinator goal handler secret is invalid.");
  }
  const workerInstanceId = identifierSchema.safeParse(options.workerInstanceId);
  if (!workerInstanceId.success) {
    throw new TypeError("Coordinator goal handler worker instance ID is invalid.");
  }
  return {
    taskType: COORDINATOR_GOAL_TASK_TYPE,
    handlerVersion: COORDINATOR_GOAL_HANDLER_VERSION,
    // The planner may observe and mutate the Minecraft world, so a retry after
    // a worker crash is not assumed idempotent.
    idempotent: false,
    async execute(context) {
      if (context.task.taskType !== COORDINATOR_GOAL_TASK_TYPE ||
          context.task.handlerVersion !== COORDINATOR_GOAL_HANDLER_VERSION ||
          context.task.executionIdempotent ||
          context.task.leaseOwner === null) {
        throw new Error("Persisted Coordinator goal contract is invalid.");
      }
      const response = await fetchImplementation(
        `${baseUrl}${COORDINATOR_GOAL_EXECUTION_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.secret}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            schemaVersion: "1.0",
            taskId: context.task.taskId,
            assignmentLeaseOwner: context.task.leaseOwner,
            workerInstanceId: workerInstanceId.data,
          }),
          signal: context.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Coordinator execution bridge returned ${response.status}.`);
      }
      const body = coordinatorGoalExecutionResponseV1Schema.parse(
        await response.json(),
      );
      if (!body.ok) {
        return terminalForError(body.errorCode);
      }
      return terminalForResult(body.result);
    },
  };
}

export function createCoordinatorGoalRegistry(
  options: CoordinatorGoalHandlerOptions,
): TaskHandlerRegistry {
  const registry = new TaskHandlerRegistry();
  registry.register(createCoordinatorGoalHandler(options));
  return registry;
}

function terminalForResult(result: GoalDispatchTerminalResultV1): TaskHandlerResult {
  const safeResult = result as unknown as SkillJsonValue;
  if (result.action === "noop") {
    return {
      result: safeResult,
      evidence: [],
      terminal: { status: "failed" as const, failureReason: result.reasonCode },
    };
  }
  if (result.outcome === "completed") {
    return { result: safeResult, evidence: [] };
  }
  if (result.outcome === "cancelled") {
    return {
      result: safeResult,
      evidence: [],
      terminal: { status: "cancelled" as const },
    };
  }
  if (result.outcome === "timed_out") {
    return {
      result: safeResult,
      evidence: [],
      terminal: { status: "expired" as const },
    };
  }
  return {
    result: safeResult,
    evidence: [],
    terminal: {
      status: "failed" as const,
      failureReason: result.errorCode ?? "GOAL_RESULT_FAILED",
    },
  };
}

function terminalForError(errorCode: string): TaskHandlerResult {
  if (errorCode === "AI_TIMEOUT") {
    return {
      result: null,
      evidence: [],
      terminal: { status: "expired" as const },
    };
  }
  if (errorCode === "CONTROL_LINK_STOPPED") {
    return {
      result: null,
      evidence: [],
      terminal: { status: "cancelled" as const },
    };
  }
  return {
    result: null,
    evidence: [],
    terminal: { status: "failed" as const, failureReason: errorCode },
  };
}
