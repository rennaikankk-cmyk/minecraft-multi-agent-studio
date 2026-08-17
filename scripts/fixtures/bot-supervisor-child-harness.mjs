import { open } from "node:fs/promises";

import { runSupervisorChildRuntime } from "../../apps/bot-runtime/dist/supervisor-child-runtime.js";

async function createHost(assignment) {
  return {
    async start() {
      if (!assignment.botId.startsWith("crash-once-")) return;
      try {
        const marker = await open(assignment.profilePath, "wx", 0o600);
        await marker.close();
        throw new Error("fixture_crash_once");
      } catch (error) {
        if (error instanceof Error && error.message === "fixture_crash_once") {
          throw error;
        }
        if (error && typeof error === "object" && error.code === "EEXIST") return;
        throw error;
      }
    },
    async stop() {},
  };
}

const logger = {
  info() {},
  warn() {},
  error() {},
};

void runSupervisorChildRuntime({ createHost, logger }).catch(() => {
  process.exitCode = 1;
});
