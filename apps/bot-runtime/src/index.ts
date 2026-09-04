import { createStructuredLogger } from "@minecraft-studio/observability";
import { PerfSpanTracker } from "./perf-spans.js";

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
  onWriteSpan: (durationMs) => bootPerfSpans.record("log.write", durationMs),
});
// Phase 3 测量面：日志写入耗时进 span 追踪器（环形缓冲，零逐次日志）。
// 运行时实例创建后再接完整窗口采集；boot 期只留 write 计时。
const bootPerfSpans = new PerfSpanTracker();

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
    logger.error("bot_runtime_start_failed", {
      code: "UNEXPECTED_ERROR",
      detail: (error instanceof Error ? error.stack ?? error.message : String(error))
        .split("\n")
        .slice(0, 4)
        .join(" | ")
        .slice(0, 500),
    });
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
  CombatDriver,
  type CombatActionAcknowledgement,
  type CombatActionExecutor,
  type CombatDriverConfig,
  type CombatDriverEntityObservation,
  type CombatDriverObservation,
  type CombatDriverReceipt,
  type CombatPrimitiveAction,
} from "./combat-driver.js";
export { MineflayerCombatAdapter } from "./combat-mineflayer-adapter.js";
export {
  ExplosionPacketAdapter,
  ExplosionPacketAdapterError,
  type CombatExplosionObservation,
  type CombatExplosionVector,
  type ExplosionPacketAdapterErrorCode,
  type ExplosionPacketSchemaKind,
} from "./explosion-packet-adapter.js";
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
  serverProfileCombatConfigSchema,
  serverProfilePurposeSchema,
  serverProfileSchema,
  type ServerProfile,
  type ServerProfileCombatConfig,
  type ServerProfileErrorCode,
  type ServerProfilePurpose,
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
  BotDamageInfo,
  BotDisconnectInfo,
  BotRecoveryAction,
  BotRecoveryActionResult,
} from "./client.js";
export {
  DEFAULT_PROGRESS_WATCHDOG_CONFIG,
  ProgressWatchdog,
  type ProgressSample,
  type ProgressWatchdogConfig,
  type ProgressWatchdogEvent,
  type ProgressWatchdogEventKind,
  type ProgressWatchdogSnapshot,
} from "./progress-watchdog.js";
export {
  importantBlockNames,
  WorldStateStore,
  type EntityState,
  type ImportantBlockName,
  type InventoryItemState,
  type NavigationState,
  type NearbyBlockState,
  type WorldPosition,
  type WorldStateObservation,
  type WorldStateSnapshot,
} from "./world-state.js";
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
