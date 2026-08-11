#!/usr/bin/env node

/**
 * Test-only Coordinator process for Runtime Link acceptance.
 *
 * The process composes the production RuntimeLinkServer, BotRegistry and
 * StopController. IPC reports readiness and the final observation only;
 * telemetry, the stop command and its confirmation always use the production
 * authenticated loopback WebSocket.
 */

const ENV = Object.freeze({
  host: "COORDINATOR_RUNTIME_LINK_HOST",
  port: "COORDINATOR_RUNTIME_LINK_PORT",
  peersJson: "COORDINATOR_RUNTIME_LINK_PEERS_JSON",
});

const BOT_ID = "runtime-link-test-bot";
const TRACE_ID = "44444444-4444-4444-8444-444444444444";
const COMMAND_ID = "55555555-5555-4555-8555-555555555555";
const DECISION_ID = "66666666-6666-4666-8666-666666666666";

function sendSupervisorEvent(event, fields = {}) {
  process.send?.({
    source: "coordinator-runtime-link-harness",
    event,
    ...fields,
  });
}

async function main() {
  for (const name of Object.values(ENV)) {
    if (!process.env[name]) {
      throw new Error(`Required acceptance environment variable is missing: ${name}`);
    }
  }

  const [
    { createStructuredLogger },
    {
      BotRegistry,
      InMemoryStopAuditSink,
      RuntimeLinkServer,
      StopController,
      loadRuntimeLinkConfig,
    },
  ] = await Promise.all([
    import("../../packages/observability/dist/index.js"),
    import("../../apps/coordinator/dist/index.js"),
  ]);

  const config = loadRuntimeLinkConfig(process.env);
  const logger = createStructuredLogger({
    service: "coordinator",
    instanceId: `runtime-link-harness-${process.pid}`,
  });
  const registry = new BotRegistry({ staleAfterMs: 5_000 });
  const auditSink = new InMemoryStopAuditSink();
  const linkServer = new RuntimeLinkServer({
    host: config.host,
    port: config.port,
    instanceId: `runtime-link-harness-${process.pid}`,
    peers: config.peers,
    registry,
    logger,
  });
  const stopController = new StopController({
    instanceId: `runtime-link-harness-${process.pid}`,
    registry,
    transport: linkServer,
    auditSink,
    logger,
  });

  const address = await linkServer.start();
  sendSupervisorEvent("coordinator_ready", {
    host: address.host,
    port: address.port,
  });

  let stopStarted = false;
  const unsubscribe = registry.subscribe((record) => {
    if (
      stopStarted ||
      record.botId !== BOT_ID ||
      record.connectionState !== "online"
    ) {
      return;
    }
    stopStarted = true;
    void requestVerifiedStop(stopController, registry, auditSink).catch((error) => {
      const message = error instanceof Error
        ? error.message
        : "Unknown Coordinator acceptance failure.";
      logger.error("runtime_link_acceptance_stop_failed", {
        traceId: TRACE_ID,
        botId: BOT_ID,
        code: "RUNTIME_LINK_ACCEPTANCE_STOP_FAILED",
        message,
      });
      process.exitCode = 1;
      void linkServer.stop().finally(() => {
        if (process.connected) process.disconnect();
      });
    });
  });

  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    unsubscribe();
    await linkServer.stop();
    if (process.connected) process.disconnect();
  };

  process.on("message", (message) => {
    if (message?.type === "shutdown") void shutdown();
  });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function requestVerifiedStop(stopController, registry, auditSink) {
  const requestedAt = new Date();
  const result = await stopController.requestStop({
    commandId: COMMAND_ID,
    traceId: TRACE_ID,
    botId: BOT_ID,
    mode: "graceful",
    reason: "runtime_link_two_process_acceptance",
    gracePeriodMs: 1_000,
    timeoutMs: 5_000,
    authorization: {
      decisionId: DECISION_ID,
      actorId: "runtime-link-acceptance",
      permissions: new Set(["bot.stop"]),
      issuedAt: new Date(requestedAt.getTime() - 1_000),
      expiresAt: new Date(requestedAt.getTime() + 10_000),
    },
  });

  const record = registry.get(BOT_ID, new Date());
  sendSupervisorEvent("acceptance_result", {
    traceId: result.traceId,
    commandId: result.payload.commandId,
    outcome: result.payload.outcome,
    runtimeInstanceId: result.payload.runtimeInstanceId,
    registryState: record?.connectionState ?? null,
    offlineReason: record?.offlineReason ?? null,
    auditStatuses: auditSink.entries().map((entry) => entry.status),
  });
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown harness error.";
  console.error(JSON.stringify({
    service: "coordinator-runtime-link-harness",
    event: "coordinator_failed",
    code: "RUNTIME_LINK_ACCEPTANCE_FAILED",
    message,
  }));
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
