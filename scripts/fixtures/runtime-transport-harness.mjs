#!/usr/bin/env node

/**
 * Test-only Bot Runtime process for the authenticated loopback Runtime Link.
 *
 * This fixture deliberately uses SingleBotRuntime with a deterministic in-memory
 * BotClient. It never imports the Mineflayer adapter and never opens a Minecraft
 * connection. All application telemetry and stop results must still cross the
 * production Runtime Link implementation over loopback WebSocket.
 */

const RUNTIME_LINK_SUBPROTOCOL = "minecraft-studio.runtime.v1";

// Keep every environment name in one place so the fixture can be aligned with
// the production config without spreading provisional names through the file.
const ENV = Object.freeze({
  coordinatorUrl: "BOT_RUNTIME_LINK_URL",
  coordinatorKeyId: "BOT_RUNTIME_LINK_KEY_ID",
  coordinatorSecret: "BOT_RUNTIME_LINK_SECRET",
});

const DEFAULT_BOT_ID = "runtime-link-test-bot";
const DEFAULT_PROFILE_ID = "runtime-link-test-profile";

class DeterministicTestBotClient {
  #handlers = null;
  #closed = false;
  #closeCalls = 0;

  setHandlers(handlers) {
    this.#handlers = handlers;
    queueMicrotask(() => {
      if (!this.#closed) handlers.onSpawn();
    });
  }

  snapshot() {
    return {
      health: { current: 18, maximum: 20 },
      food: { level: 16, saturation: 4 },
      armorPoints: 4,
      position: {
        x: 12,
        y: 64,
        z: -8,
        dimension: "minecraft:overworld",
      },
      latencyMs: 22,
      safety: {
        oxygenLevel: 20,
        inWater: false,
        inLava: false,
        onGround: true,
        velocityY: 0,
        inventory: { usedSlots: 3, totalSlots: 36 },
        hasSafeFood: true,
        movementRequested: false,
      },
    };
  }

  versionCompatibility() {
    return {
      selection: "fixed",
      requestedVersion: "1.21.8",
      resolvedVersion: "1.21.8",
      supportLevel: "tested",
      supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
    };
  }

  async executeSafetyAction() {
    return { outcome: "executed", errorCode: null };
  }

  async close() {
    this.#closeCalls += 1;
    if (this.#closed) {
      sendSupervisorEvent("fixture_client_closed", {
        closeCalls: this.#closeCalls,
      });
      return;
    }
    this.#closed = true;
    this.#handlers?.onDisconnected({
      reason: "requested_stop",
      expected: true,
    });
    sendSupervisorEvent("fixture_client_closed", {
      closeCalls: this.#closeCalls,
    });
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required acceptance environment variable is missing: ${name}`);
  }
  return value;
}

function runtimeProfile(botId) {
  return {
    schemaVersion: "1.0",
    id: DEFAULT_PROFILE_ID,
    botId,
    purpose: "isolated-test",
    networkScope: "loopback",
    // Metadata only: DeterministicTestBotClient never connects to this address.
    host: "127.0.0.1",
    port: 25565,
    minecraftVersion: "1.21.8",
    username: "RuntimeLinkFixture",
    auth: "offline",
    statusIntervalMs: 250,
    heartbeatIntervalMs: 500,
    stopGracePeriodMs: 1_000,
    reconnect: {
      enabled: false,
      maxAttempts: 0,
      baseDelayMs: 250,
      maxDelayMs: 500,
    },
  };
}

function sendSupervisorEvent(event, fields = {}) {
  process.send?.({
    source: "runtime-transport-harness",
    event,
    ...fields,
  });
}

async function main() {
  requiredEnvironment(ENV.coordinatorUrl);
  requiredEnvironment(ENV.coordinatorKeyId);
  requiredEnvironment(ENV.coordinatorSecret);
  const botId = DEFAULT_BOT_ID;

  const [
    { createStructuredLogger },
    { SingleBotRuntime },
    { RuntimeLinkClient },
    { loadRuntimeLinkConfig },
  ] =
    await Promise.all([
      import("../../packages/observability/dist/index.js"),
      import("../../apps/bot-runtime/dist/runtime.js"),
      import("../../apps/bot-runtime/dist/runtime-link-client.js"),
      import("../../apps/bot-runtime/dist/runtime-link-config.js"),
    ]);

  const logger = createStructuredLogger({
    service: "bot-runtime",
    instanceId: `runtime-link-fixture-${process.pid}`,
  });

  const config = loadRuntimeLinkConfig(process.env);
  let link;
  let failClosedError = null;
  const runtime = new SingleBotRuntime(runtimeProfile(botId), {
    createClient: () => new DeterministicTestBotClient(),
    messageSink: (message) => link.publishTelemetry(message),
    logger,
  });

  link = new RuntimeLinkClient({
    config,
    botId,
    runtimeInstanceId: runtime.getRuntimeInstanceId(),
    logger,
    handleStopCommand: (command, authorizationContext) =>
      runtime.handleStopCommand(command, authorizationContext),
    publishCurrentState: () => runtime.publishCurrentState(),
    failClosed: async (error) => {
      failClosedError = error;
      logger.error("runtime_link_acceptance_fail_closed", { code: error.code });
      process.exitCode = 1;
      await runtime.stop("runtime_link_fail_closed");
    },
  });

  await link.start();
  if (failClosedError) throw failClosedError;
  runtime.start();
  sendSupervisorEvent("fixture_ready", {
    botId,
    runtimeInstanceId: runtime.getRuntimeInstanceId(),
    protocol: RUNTIME_LINK_SUBPROTOCOL,
  });

  let shutdownStarted = false;
  const shutdown = async (reason) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    const outcome = await runtime.stop(reason);
    await link.close();
    if (!outcome.confirmed) process.exitCode = 1;
    if (process.connected) process.disconnect();
  };

  process.on("message", (message) => {
    if (message?.type === "shutdown") void shutdown("acceptance_shutdown");
  });
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown fixture error.";
  console.error(JSON.stringify({
    service: "runtime-transport-harness",
    event: "fixture_failed",
    code: "RUNTIME_LINK_ACCEPTANCE_FAILED",
    message,
  }));
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
