import type { BotTelemetryMessageV1 } from "@minecraft-studio/protocol";
import { createStructuredLogger } from "@minecraft-studio/observability";

import { createMineflayerClient } from "./mineflayer-client.js";
import { SingleBotRuntime } from "./runtime.js";
import { loadServerProfile, ServerProfileError } from "./server-profile.js";
const logger = createStructuredLogger({
  service: "bot-runtime",
  instanceId: `bot-runtime-${process.pid}`,
});

function reportTelemetry(message: BotTelemetryMessageV1): void {
  const payload = message.payload;
  logger.info("bot_telemetry", {
    traceId: message.traceId,
    taskId:
      "currentTaskId" in payload
        ? payload.currentTaskId ?? null
        : "currentTask" in payload
          ? payload.currentTask?.taskId ?? null
          : null,
    messageType: message.type,
    botId: message.botId,
    skillId: null,
    modelName: null,
    sequence: "sequence" in payload ? payload.sequence : undefined,
    connectionState:
      "connectionState" in payload ? payload.connectionState : undefined,
  });
}

async function main(): Promise<void> {
  const profile = await loadServerProfile();
  const runtime = new SingleBotRuntime(profile, {
    createClient: createMineflayerClient,
    messageSink: reportTelemetry,
    logger,
  });

  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    await runtime.stop(signal);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  runtime.start();
}

void main().catch((error: unknown) => {
  if (error instanceof ServerProfileError) {
    logger.error("server_profile_rejected", { code: error.code });
  } else {
    logger.error("bot_runtime_start_failed", { code: "UNEXPECTED_ERROR" });
  }
  process.exitCode = 1;
});

export {
  createMineflayerClient,
  createMineflayerOptions,
} from "./mineflayer-client.js";
export {
  RuntimeControlError,
  SingleBotRuntime,
  type RuntimeControlErrorCode,
  type RuntimeDependencies,
  type RuntimeStopOutcome,
} from "./runtime.js";
export {
  ServerProfileError,
  loadServerProfile,
  serverProfileSchema,
  type ServerProfile,
  type ServerProfileErrorCode,
} from "./server-profile.js";
export type {
  BotClient,
  BotClientFactory,
  BotClientHandlers,
  BotClientSnapshot,
  BotDisconnectInfo,
} from "./client.js";
export {
  isMineflayerTestedVersion,
  isMineflayerUnsupportedVersionError,
  mineflayerVersionOption,
  mineflayerVersionSupport,
  resolvedVersionCompatibility,
  unsupportedVersionCompatibility,
  type MinecraftVersionSelection,
} from "./version-compatibility.js";
