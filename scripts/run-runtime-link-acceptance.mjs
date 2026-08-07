#!/usr/bin/env node

/**
 * Two-process Runtime Link acceptance supervisor.
 *
 * Service processes under test:
 *   1. test harness composed from production Coordinator components
 *   2. test-only SingleBotRuntime harness
 *
 * The application path must use an authenticated 127.0.0.1 WebSocket with the
 * minecraft-studio.runtime.v1 subprotocol. Supervisor IPC is only for process
 * readiness, fault injection and cleanup; it must never carry application
 * telemetry, stop commands or stop confirmations.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_LINK_SUBPROTOCOL = "minecraft-studio.runtime.v1";
const HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 15_000;
const ACCEPTANCE_TIMEOUT_MS = 30_000;
const BOT_ID = "runtime-link-test-bot";
const TRACE_ID = "44444444-4444-4444-8444-444444444444";
const COMMAND_ID = "55555555-5555-4555-8555-555555555555";

const ENV = Object.freeze({
  coordinatorHost: "COORDINATOR_RUNTIME_LINK_HOST",
  coordinatorPort: "COORDINATOR_RUNTIME_LINK_PORT",
  coordinatorPeersJson: "COORDINATOR_RUNTIME_LINK_PEERS_JSON",
  runtimeUrl: "BOT_RUNTIME_LINK_URL",
  runtimeKeyId: "BOT_RUNTIME_LINK_KEY_ID",
  runtimeSecret: "BOT_RUNTIME_LINK_SECRET",
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coordinatorEntry = resolve(
  root,
  "scripts/fixtures/coordinator-runtime-link-harness.mjs",
);
const runtimeFixtureEntry = resolve(
  root,
  "scripts/fixtures/runtime-transport-harness.mjs",
);

const children = new Set();

async function main() {
  await Promise.all([access(coordinatorEntry), access(runtimeFixtureEntry)]);

  const port = await reserveEphemeralPort();
  const keyId = "runtime-link-acceptance-key";
  const secret = randomBytes(32).toString("base64url");
  const secretSha256 = createHash("sha256")
    .update(secret, "utf8")
    .digest("hex");

  const coordinatorPeersJson = JSON.stringify([
    {
      keyId,
      botId: BOT_ID,
      secretSha256,
    },
  ]);

  const coordinator = spawnNode(coordinatorEntry, {
    [ENV.coordinatorHost]: HOST,
    [ENV.coordinatorPort]: String(port),
    [ENV.coordinatorPeersJson]: coordinatorPeersJson,
  });

  const coordinatorReady = await waitForIpcEvent(
    coordinator,
    "coordinator_ready",
    STARTUP_TIMEOUT_MS,
  );
  if (coordinatorReady.host !== HOST || coordinatorReady.port !== port) {
    throw new Error("Coordinator Runtime Link reported an unexpected bind address.");
  }

  const runtime = spawnNode(runtimeFixtureEntry, {
    [ENV.runtimeUrl]: `ws://${HOST}:${port}/v1/runtime-link`,
    [ENV.runtimeKeyId]: keyId,
    [ENV.runtimeSecret]: secret,
  });

  const runtimeReady = await waitForIpcEvent(
    runtime,
    "fixture_ready",
    STARTUP_TIMEOUT_MS,
  );
  if (
    runtimeReady.botId !== BOT_ID ||
    runtimeReady.protocol !== RUNTIME_LINK_SUBPROTOCOL
  ) {
    throw new Error("Runtime fixture reported an unexpected identity or protocol.");
  }

  const [result, closeObservation] = await Promise.all([
    waitForIpcEvent(coordinator, "acceptance_result", ACCEPTANCE_TIMEOUT_MS),
    waitForIpcEvent(runtime, "fixture_client_closed", ACCEPTANCE_TIMEOUT_MS),
  ]);
  assertAcceptanceResult(
    result,
    closeObservation,
    coordinator.acceptanceLogRecords,
    runtime.acceptanceLogRecords,
  );

  console.log(JSON.stringify({
    service: "runtime-link-acceptance",
    event: "acceptance_passed",
    protocol: RUNTIME_LINK_SUBPROTOCOL,
    processes: 2,
    transport: "loopback-websocket",
    minecraftConnected: false,
    botId: BOT_ID,
    traceId: TRACE_ID,
    commandId: COMMAND_ID,
  }));
}

function assertAcceptanceResult(
  result,
  closeObservation,
  coordinatorLogs,
  runtimeLogs,
) {
  if (
    result.traceId !== TRACE_ID ||
    result.commandId !== COMMAND_ID ||
    result.outcome !== "completed" ||
    result.registryState !== "offline" ||
    result.offlineReason !== "requested_stop" ||
    JSON.stringify(result.auditStatuses) !== JSON.stringify(["started", "completed"])
  ) {
    throw new Error("Coordinator reported an invalid Runtime Link stop outcome.");
  }
  if (closeObservation.closeCalls !== 1) {
    throw new Error("Test BotClient was not closed exactly once.");
  }
  const coordinatorTraceEvents = coordinatorLogs
    .filter((record) => record.traceId === TRACE_ID)
    .map((record) => record.event);
  const runtimeTraceEvents = runtimeLogs
    .filter((record) => record.traceId === TRACE_ID)
    .map((record) => record.event);
  if (
    coordinatorTraceEvents.filter((event) => event === "coordinator_stop_audit")
      .length !== 2 ||
    !runtimeTraceEvents.includes("bot_runtime_stop_requested") ||
    !runtimeTraceEvents.includes("bot_runtime_stop_result")
  ) {
    throw new Error("The fixed traceId was not preserved across both processes.");
  }
}

function spawnNode(entry, extraEnvironment) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      ...extraEnvironment,
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  child.acceptanceInbox = [];
  child.acceptanceLogRecords = [];
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let logBuffer = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    logBuffer += chunk;
    const lines = logBuffer.split(/\r?\n/u);
    logBuffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record && typeof record === "object") {
          child.acceptanceLogRecords.push(record);
        }
      } catch {
        // Non-JSON child output is forwarded but never treated as evidence.
      }
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("message", (message) => {
    child.acceptanceInbox.push(message);
    if (child.acceptanceInbox.length > 100) child.acceptanceInbox.shift();
  });
  return child;
}

async function reserveEphemeralPort() {
  const server = createServer();
  server.unref();
  server.listen({ host: HOST, port: 0, exclusive: true });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback acceptance port.");
  }
  const port = address.port;
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return port;
}

function waitForIpcEvent(child, expectedEvent, timeoutMs) {
  return new Promise((resolveWait, rejectWait) => {
    const takeExpected = () => {
      const index = child.acceptanceInbox.findIndex(
        (message) => message?.event === expectedEvent,
      );
      return index < 0 ? null : child.acceptanceInbox.splice(index, 1)[0];
    };
    const existing = takeExpected();
    if (existing) {
      resolveWait(existing);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      rejectWait(new Error(`Timed out waiting for IPC event ${expectedEvent}.`));
    }, timeoutMs);

    const onMessage = () => {
      const message = takeExpected();
      if (message) finish(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectWait(
        new Error(
          `Child exited before IPC event ${expectedEvent} (code=${String(code)}, signal=${String(signal)}).`,
        ),
      );
    };
    const finish = (value) => {
      cleanup();
      resolveWait(value);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };

    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function stopChildren() {
  // Runtime is spawned last, so reverse order closes the client link before
  // the Coordinator listener and avoids turning normal cleanup into a reconnect.
  for (const child of [...children].reverse()) {
    await stopChild(child);
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.send({ type: "shutdown" });
  } catch {
    // The child may have closed its IPC channel while exiting.
  }
  await Promise.race([once(child, "exit"), delay(2_000)]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(1_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

const overallTimeout = setTimeout(() => {
  console.error(
    JSON.stringify({
      service: "runtime-link-acceptance",
      event: "acceptance_timed_out",
      code: "RUNTIME_LINK_ACCEPTANCE_TIMEOUT",
      timeoutMs: ACCEPTANCE_TIMEOUT_MS,
    }),
  );
  void stopChildren().finally(() => {
    process.exitCode = 1;
  });
}, ACCEPTANCE_TIMEOUT_MS);
overallTimeout.unref();

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown acceptance error.";
  console.error(
    JSON.stringify({
      service: "runtime-link-acceptance",
      event: "acceptance_failed",
      code: "RUNTIME_LINK_ACCEPTANCE_FAILED",
      protocol: RUNTIME_LINK_SUBPROTOCOL,
      message,
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(overallTimeout);
  await stopChildren();
}
