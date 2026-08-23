import {
  TaskHandlerRegistry,
  type TaskHandlerDefinition,
} from "@minecraft-studio/task-system";
import {
  isolatedDeterministicHandler,
} from "./isolated-deterministic-handler.js";

export const ISOLATED_ACCEPTANCE_TASK_TYPE =
  "isolated.acceptance.wait";
export const ISOLATED_ACCEPTANCE_HANDLER_VERSION = "1.0.0";

export const isolatedAcceptanceHandler: TaskHandlerDefinition = {
  taskType: ISOLATED_ACCEPTANCE_TASK_TYPE,
  handlerVersion: ISOLATED_ACCEPTANCE_HANDLER_VERSION,
  idempotent: true,
  async execute({ signal }) {
    await new Promise<never>((_resolve, reject) => {
      const rejectCancelled = () =>
        reject(new Error("Isolated acceptance handler was cancelled."));
      if (signal.aborted) {
        rejectCancelled();
        return;
      }
      signal.addEventListener("abort", rejectCancelled, { once: true });
    });
    return { result: null, evidence: [] };
  },
};

export function createIsolatedAcceptanceRegistry(): TaskHandlerRegistry {
  const registry = new TaskHandlerRegistry();
  registry.register(isolatedAcceptanceHandler);
  registry.register(isolatedDeterministicHandler);
  return registry;
}
