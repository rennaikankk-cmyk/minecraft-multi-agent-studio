import { createStructuredLogger } from "@minecraft-studio/observability";

import {
  runSupervisorChildRuntime,
  SupervisorChildRuntimeError,
} from "./supervisor-child-runtime.js";

const logger = createStructuredLogger({
  service: "bot-runtime-child",
  instanceId: `bot-runtime-child-${process.pid}`,
});

void runSupervisorChildRuntime({ logger }).catch((error: unknown) => {
  logger.error("bot_supervisor_child_exit", {
    code:
      error instanceof SupervisorChildRuntimeError
        ? error.code
        : "UNEXPECTED_ERROR",
  });
  process.exitCode = 1;
});
