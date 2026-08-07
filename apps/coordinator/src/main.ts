import { createStructuredLogger } from "@minecraft-studio/observability";

import { BotRegistry } from "./bot-registry.js";
import {
  RuntimeLinkConfigError,
  loadRuntimeLinkConfig,
} from "./runtime-link-config.js";
import { RuntimeLinkServer } from "./runtime-link-server.js";

const instanceId = `coordinator-${process.pid}`;
const logger = createStructuredLogger({ service: "coordinator", instanceId });

async function main(): Promise<void> {
  const config = loadRuntimeLinkConfig();
  const registry = new BotRegistry({ staleAfterMs: 15_000 });
  const server = new RuntimeLinkServer({
    host: config.host,
    port: config.port,
    instanceId,
    peers: config.peers,
    registry,
    logger,
  });
  const staleTimer = setInterval(() => {
    try {
      registry.sweepStale();
    } catch {
      logger.error("coordinator_registry_stale_sweep_failed", {
        code: "COORDINATOR_CLOCK_INVALID",
      });
    }
  }, 1_000);

  try {
    const address = await server.start();
    logger.info("coordinator_runtime_link_started", {
      bindScope: "loopback",
      port: address.port,
      controlApiConnected: false,
    });
  } catch (cause) {
    clearInterval(staleTimer);
    await server.stop();
    throw cause;
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(staleTimer);
    logger.info("coordinator_runtime_link_stopping", { signal });
    await server.stop();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

void main().catch((cause: unknown) => {
  const code =
    cause instanceof RuntimeLinkConfigError
      ? cause.code
      : "COORDINATOR_RUNTIME_LINK_START_FAILED";
  logger.error("coordinator_runtime_link_start_failed", { code });
  process.exitCode = 1;
});
