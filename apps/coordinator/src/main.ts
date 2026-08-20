import { randomUUID } from "node:crypto";

import { createStructuredLogger } from "@minecraft-studio/observability";

import { BotRegistry } from "./bot-registry.js";
import { createCoordinatorAIServiceFromEnv } from "./ai-service.js";
import { CoordinatorAIConfigError } from "./ai-service-config.js";
import {
  ControlLinkConfigError,
  loadControlLinkConfig,
} from "./control-link-config.js";
import { ControlLinkServer } from "./control-link-server.js";
import {
  RuntimeLinkConfigError,
  loadRuntimeLinkConfig,
} from "./runtime-link-config.js";
import { RuntimeLinkServer } from "./runtime-link-server.js";
import { InMemorySkillInvocationAuditSink } from "./skill-invocation-controller.js";
import { InMemoryStopAuditSink, StopController } from "./stop-controller.js";
import { TeamCoordinator } from "./team-coordinator.js";

const instanceId = `coordinator-${randomUUID()}`;
const logger = createStructuredLogger({ service: "coordinator", instanceId });

async function main(): Promise<void> {
  const runtimeConfig = loadRuntimeLinkConfig();
  const controlConfig = loadControlLinkConfig();
  const registry = new BotRegistry({
    staleAfterMs: runtimeConfig.botStaleAfterMs,
  });
  const runtimeServer = new RuntimeLinkServer({
    host: runtimeConfig.host,
    port: runtimeConfig.port,
    instanceId,
    peers: runtimeConfig.peers,
    registry,
    logger,
  });
  const teamCoordinator = new TeamCoordinator({ registry });
  const aiService = createCoordinatorAIServiceFromEnv(registry, {
    instanceId,
    transport: runtimeServer,
    auditSink: new InMemorySkillInvocationAuditSink(),
    logger,
    teamStateProvider: (botId) => teamCoordinator.teamStateForBot(botId),
  });
  const stopController = new StopController({
    instanceId,
    registry,
    transport: runtimeServer,
    auditSink: new InMemoryStopAuditSink(),
    logger,
  });
  const controlServer = new ControlLinkServer({
    host: controlConfig.host,
    port: controlConfig.port,
    instanceId,
    clients: controlConfig.clients,
    registry,
    stopController,
    teamCoordinator,
    ...(aiService ? { taskExecutor: aiService } : {}),
    logger,
  });
  let staleTimer: ReturnType<typeof setInterval> | null = null;

  try {
    if (aiService) {
      const health = await aiService.health();
      const log = health.available ? logger.info.bind(logger) : logger.warn.bind(logger);
      log("coordinator_ai_provider_health", {
        providerAvailable: health.available,
        providerLatencyMs: health.latencyMs,
        modelName: health.model ?? null,
        errorCode: health.errorCode ?? null,
      });
    }
    const runtimeAddress = await runtimeServer.start();
    const controlAddress = await controlServer.start();
    staleTimer = setInterval(() => {
      try {
        registry.sweepStale();
      } catch {
        logger.error("coordinator_registry_stale_sweep_failed", {
          code: "COORDINATOR_CLOCK_INVALID",
        });
      }
    }, 1_000);
    logger.info("coordinator_runtime_link_started", {
      bindScope: "loopback",
      port: runtimeAddress.port,
    });
    logger.info("coordinator_control_link_started", {
      bindScope: "loopback",
      port: controlAddress.port,
    });
  } catch (cause) {
    if (staleTimer) clearInterval(staleTimer);
    aiService?.close();
    await Promise.allSettled([controlServer.stop(), runtimeServer.stop()]);
    throw cause;
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (staleTimer) clearInterval(staleTimer);
    aiService?.close();
    logger.info("coordinator_stopping", { signal });
    await Promise.allSettled([controlServer.stop(), runtimeServer.stop()]);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

void main().catch((cause: unknown) => {
  const code =
    cause instanceof RuntimeLinkConfigError ||
    cause instanceof ControlLinkConfigError ||
    cause instanceof CoordinatorAIConfigError
      ? cause.code
      : "COORDINATOR_START_FAILED";
  logger.error("coordinator_start_failed", { code });
  process.exitCode = 1;
});
