import { BotRegistry } from "@minecraft-studio/coordinator";

import { loadControlApiConfig } from "./config.js";
import { ControlApiServer, type ControlApiLogger } from "./server.js";

const logger: ControlApiLogger = {
  info: (event, fields = {}) => console.log(JSON.stringify({ event, ...fields })),
  warn: (event, fields = {}) => console.warn(JSON.stringify({ event, ...fields })),
  error: (event, fields = {}) => console.error(JSON.stringify({ event, ...fields })),
};

async function main(): Promise<void> {
  const config = loadControlApiConfig();
  const registry = new BotRegistry({ staleAfterMs: config.staleAfterMs });
  const server = new ControlApiServer({
    host: config.host,
    port: config.port,
    registry,
    principals: config.principals,
    requestLimitPerMinute: config.requestLimitPerMinute,
    handshakeLimitPerMinute: config.handshakeLimitPerMinute,
    maxConnectionsPerSubject: config.maxConnectionsPerSubject,
    logger,
  });

  const address = await server.start();
  logger.info("control_api_started", { bindScope: "loopback", port: address.port });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("control_api_stopping", { signal });
    await server.stop();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

void main().catch(() => {
  logger.error("control_api_start_failed", { code: "CONTROL_API_START_FAILED" });
  process.exitCode = 1;
});
