import type { BotTelemetryMessageV1 } from "@minecraft-studio/protocol";
import { createStructuredLogger } from "@minecraft-studio/observability";

import { createMineflayerClient } from "./mineflayer-client.js";
import {
  RuntimeLinkClient,
  RuntimeLinkClientError,
} from "./runtime-link-client.js";
import {
  loadRuntimeLinkConfig,
  RuntimeLinkConfigError,
} from "./runtime-link-config.js";
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
  const runtimeLinkConfig = loadRuntimeLinkConfig();
  let runtimeLink: RuntimeLinkClient | null = null;
  const runtime = new SingleBotRuntime(profile, {
    createClient: createMineflayerClient,
    messageSink: (message) => {
      reportTelemetry(message);
      runtimeLink?.publishTelemetry(message);
    },
    logger,
  });

  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    await runtime.stop(signal);
    await runtimeLink?.close();
  };

  runtimeLink = new RuntimeLinkClient({
    config: runtimeLinkConfig,
    botId: profile.botId,
    runtimeInstanceId: runtime.getRuntimeInstanceId(),
    logger,
    handleStopCommand: (command, authorizationContext) =>
      runtime.handleStopCommand(command, authorizationContext),
    publishCurrentState: () => runtime.publishCurrentState(),
    failClosed: async (error) => {
      logger.error("bot_runtime_control_link_lost", { code: error.code });
      process.exitCode = 1;
      await runtime.stop("runtime_link_fail_closed");
    },
  });

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await runtimeLink.start();
  runtime.start();
}

void main().catch((error: unknown) => {
  if (error instanceof ServerProfileError) {
    logger.error("server_profile_rejected", { code: error.code });
  } else if (error instanceof RuntimeLinkConfigError) {
    logger.error("runtime_link_config_rejected", { code: error.code });
  } else if (error instanceof RuntimeLinkClientError) {
    logger.error("runtime_link_start_failed", { code: error.code });
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
  RuntimeLinkClient,
  RuntimeLinkClientError,
  type RuntimeLinkClientErrorCode,
  type RuntimeLinkClientOptions,
} from "./runtime-link-client.js";
export {
  RuntimeLinkConfigError,
  loadRuntimeLinkConfig,
  type RuntimeLinkClientConfig,
  type RuntimeLinkConfigErrorCode,
} from "./runtime-link-config.js";
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
