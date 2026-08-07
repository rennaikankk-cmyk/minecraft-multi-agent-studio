import { randomUUID } from "node:crypto";

import { createStructuredLogger } from "@minecraft-studio/observability";

import { loadControlApiConfig } from "./config.js";
import { CoordinatorLinkClient } from "./coordinator-link-client.js";
import {
  CoordinatorLinkConfigError,
  loadCoordinatorLinkConfig,
} from "./coordinator-link-config.js";
import { ControlApiServer } from "./server.js";

const instanceId = `control-api-${randomUUID()}`;
const logger = createStructuredLogger({
  service: "control-api",
  instanceId,
});

async function main(): Promise<void> {
  const config = loadControlApiConfig();
  const coordinatorLink = new CoordinatorLinkClient({
    config: loadCoordinatorLinkConfig(),
    instanceId,
    logger,
  });
  await coordinatorLink.start();
  const server = new ControlApiServer({
    host: config.host,
    port: config.port,
    registry: coordinatorLink,
    stopController: coordinatorLink,
    principals: config.principals,
    requestLimitPerMinute: config.requestLimitPerMinute,
    handshakeLimitPerMinute: config.handshakeLimitPerMinute,
    maxConnectionsPerSubject: config.maxConnectionsPerSubject,
    logger,
  });

  let address;
  try {
    address = await server.start();
  } catch (cause) {
    await coordinatorLink.close();
    throw cause;
  }
  logger.info("control_api_started", { bindScope: "loopback", port: address.port });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("control_api_stopping", { signal });
    await server.stop();
    await coordinatorLink.close();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

void main().catch((cause: unknown) => {
  const code =
    cause instanceof CoordinatorLinkConfigError
      ? cause.code
      : "CONTROL_API_START_FAILED";
  logger.error("control_api_start_failed", { code });
  process.exitCode = 1;
});
