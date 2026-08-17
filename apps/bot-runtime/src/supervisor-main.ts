import { createStructuredLogger } from "@minecraft-studio/observability";

import {
  BotSupervisorConfigError,
  loadBotSupervisorConfig,
} from "./supervisor-config.js";
import { BotProcessSupervisor } from "./supervisor.js";

const logger = createStructuredLogger({
  service: "bot-process-supervisor",
  instanceId: `bot-process-supervisor-${process.pid}`,
});

async function main(): Promise<void> {
  const config = await loadBotSupervisorConfig();
  const supervisor = await BotProcessSupervisor.create({
    config,
    logger,
    onGroupRestartExhausted: () => {
      process.exitCode = 1;
    },
  });
  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    await supervisor.stop(`signal_${signal.toLowerCase()}`);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await supervisor.start();
  if (shutdownStarted) return;
  logger.info("bot_supervisor_ready", {
    groupCount: supervisor.plan.groups.length,
    botCount: config.bots.length,
    botsPerProcess: supervisor.plan.effectiveBotsPerProcess,
  });
}

void main().catch((error: unknown) => {
  logger.error("bot_supervisor_start_failed", {
    code:
      error instanceof BotSupervisorConfigError
        ? error.code
        : "UNEXPECTED_ERROR",
  });
  process.exitCode = 1;
});
