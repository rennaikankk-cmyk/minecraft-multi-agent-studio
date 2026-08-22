import { createStructuredLogger } from "@minecraft-studio/observability";

import {
  RuntimeLinkClientError,
} from "./runtime-link-client.js";
import {
  loadRuntimeLinkConfig,
  RuntimeLinkConfigError,
} from "./runtime-link-config.js";
import { BotRuntimeHost } from "./runtime-host.js";
import { loadServerProfile, ServerProfileError } from "./server-profile.js";
const logger = createStructuredLogger({
  service: "bot-runtime",
  instanceId: `bot-runtime-${process.pid}`,
});

async function main(): Promise<void> {
  const profile = await loadServerProfile();
  const runtimeLinkConfig = loadRuntimeLinkConfig();
  const host = new BotRuntimeHost({
    profile,
    runtimeLinkConfig,
    logger,
    onFatal: () => {
      process.exitCode = 1;
    },
  });

  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    await host.stop(signal);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await host.start();
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
  combatEntityFromMineflayer,
  type MineflayerCombatEntityView,
  type MineflayerCombatRegistryView,
} from "./combat-entity-adapter.js";
export {
  BotRuntimeHost,
  type BotRuntimeHostOptions,
} from "./runtime-host.js";
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
export {
  BotSupervisorConfigError,
  loadBotSupervisorConfig,
  type BotSupervisorConfig,
  type BotSupervisorConfigErrorCode,
  type BotSupervisorIpcConfig,
  type BotSupervisorRestartConfig,
  type ResolvedSupervisorBot,
} from "./supervisor-config.js";
export {
  BotProcessSupervisor,
  type BotProcessGroupSnapshot,
  type BotProcessSupervisorOptions,
  type BotProcessSupervisorSnapshot,
  type SupervisorFork,
} from "./supervisor.js";
export {
  createBotSupervisorPlan,
  RestartBudget,
  type BotProcessGroupPlan,
  type BotSupervisorPlan,
  type RestartDecision,
} from "./supervisor-plan.js";
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
export {
  categorizeStepFailure,
  GoalExecutor,
  stepOutcomeFromResult,
  STEP_DISPATCH_UNAVAILABLE,
  STEP_INVOCATION_INVALID,
  STEP_TARGET_NOT_FOUND,
} from "./goal-execution.js";
export type {
  DispatchableStep,
  GoalExecutionDependencies,
  GoalExecutionLogger,
  GoalExecutionOutcome,
  StepDispatcher,
  StepInvoker,
} from "./goal-execution.js";
