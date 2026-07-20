import type { BotTelemetryMessageV1 } from "@minecraft-studio/protocol";

import { createMineflayerClient } from "./mineflayer-client.js";
import { SingleBotRuntime } from "./runtime.js";
import { loadServerProfile, ServerProfileError } from "./server-profile.js";
import type { RuntimeLogger } from "./runtime-types.js";

function writeLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  const output = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

const logger: RuntimeLogger = {
  info: (event, fields) => writeLog("info", event, fields),
  warn: (event, fields) => writeLog("warn", event, fields),
  error: (event, fields) => writeLog("error", event, fields),
};

function reportTelemetry(message: BotTelemetryMessageV1): void {
  const payload = message.payload;
  writeLog("info", "bot_telemetry", {
    messageType: message.type,
    botId: message.botId,
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
    writeLog("error", "server_profile_rejected", { code: error.code });
  } else {
    writeLog("error", "bot_runtime_start_failed", { code: "UNEXPECTED_ERROR" });
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
