#!/usr/bin/env node

/**
 * Four-process service acceptance for the local control path.
 *
 * Application processes under test:
 *   1. production Coordinator
 *   2. production Control API
 *   3. production Dashboard standalone server
 *   4. test-only SingleBotRuntime harness
 *
 * Bot state, stop commands and stop confirmations may only cross the real
 * loopback HTTP/WebSocket application links. IPC is restricted to Runtime
 * fixture readiness, close-call observation and orderly fixture shutdown.
 * The Runtime fixture never imports Mineflayer or connects to Minecraft.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST = "127.0.0.1";
const BOT_ID = "runtime-link-test-bot";
const TRACE_ID = "77777777-7777-4777-8777-777777777777";
const RUNTIME_LINK_PATH = "/v1/runtime-link";
const CONTROL_LINK_PATH = "/v1/control-link";
const STARTUP_TIMEOUT_MS = 20_000;
const STATE_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 25_000;
const OVERALL_TIMEOUT_MS = 75_000;
const MAX_CAPTURED_OUTPUT_BYTES = 4 * 1_024 * 1_024;

const ENV = Object.freeze({
  coordinatorRuntimeHost: "COORDINATOR_RUNTIME_LINK_HOST",
  coordinatorRuntimePort: "COORDINATOR_RUNTIME_LINK_PORT",
  coordinatorRuntimePeers: "COORDINATOR_RUNTIME_LINK_PEERS_JSON",
  coordinatorControlHost: "COORDINATOR_CONTROL_LINK_HOST",
  coordinatorControlPort: "COORDINATOR_CONTROL_LINK_PORT",
  coordinatorControlClients: "COORDINATOR_CONTROL_LINK_CLIENTS_JSON",
  controlApiHost: "CONTROL_API_HOST",
  controlApiPort: "CONTROL_API_PORT",
  controlApiAuth: "CONTROL_API_AUTH_JSON",
  controlCoordinatorUrl: "CONTROL_API_COORDINATOR_LINK_URL",
  controlCoordinatorClientId: "CONTROL_API_COORDINATOR_LINK_CLIENT_ID",
  controlCoordinatorKeyId: "CONTROL_API_COORDINATOR_LINK_KEY_ID",
  controlCoordinatorSecret: "CONTROL_API_COORDINATOR_LINK_SECRET",
  dashboardControlUrl: "DASHBOARD_CONTROL_API_URL",
  dashboardControlToken: "DASHBOARD_CONTROL_API_TOKEN",
  dashboardStopHash: "DASHBOARD_STOP_CONFIRMATION_SHA256",
  runtimeUrl: "BOT_RUNTIME_LINK_URL",
  runtimeKeyId: "BOT_RUNTIME_LINK_KEY_ID",
  runtimeSecret: "BOT_RUNTIME_LINK_SECRET",
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = Object.freeze({
  coordinator: resolve(root, "apps/coordinator/dist/main.js"),
  controlApi: resolve(root, "apps/control-api/dist/main.js"),
  dashboard: resolve(
    root,
    "apps/dashboard/.next/standalone/apps/dashboard/server.js",
  ),
  runtime: resolve(root, "scripts/fixtures/runtime-transport-harness.mjs"),
  protocol: resolve(root, "packages/protocol/dist/index.js"),
});

const children = [];
const reservations = new Set();
const reservationCleanupErrors = [];
let schemas;
let secretsToReject = [];
let acceptanceCancelled = false;

async function runAcceptance() {
  await Promise.all(Object.values(entries).map((entry) => access(entry)));
  schemas = await import(pathToFileURL(entries.protocol).href);

  const [runtimeReservation, controlLinkReservation, controlApiReservation, dashboardReservation] =
    await reserveLoopbackPorts(4);
  const runtimePort = runtimeReservation.port;
  const controlLinkPort = controlLinkReservation.port;
  const controlApiPort = controlApiReservation.port;
  const dashboardPort = dashboardReservation.port;

  const runtimeKeyId = "four-process-runtime-key";
  const runtimeSecret = randomBytes(32).toString("base64url");
  const runtimeSecretSha256 = sha256(runtimeSecret);
  const controlClientId = "four-process-control-api";
  const controlKeyId = "four-process-control-key";
  const controlSecret = randomBytes(32).toString("base64url");
  const controlSecretSha256 = sha256(controlSecret);
  const dashboardToken = randomBytes(32).toString("base64url");
  const dashboardTokenSha256 = sha256(dashboardToken);
  const confirmationCode = `accept-${randomBytes(18).toString("base64url")}`;
  const confirmationSha256 = sha256(confirmationCode);
  secretsToReject = [
    runtimeSecret,
    runtimeSecretSha256,
    controlSecret,
    controlSecretSha256,
    dashboardToken,
    dashboardTokenSha256,
    confirmationCode,
    confirmationSha256,
  ];

  await Promise.all([
    releaseReservation(runtimeReservation),
    releaseReservation(controlLinkReservation),
  ]);
  const coordinator = spawnService("coordinator", entries.coordinator, {
    [ENV.coordinatorRuntimeHost]: HOST,
    [ENV.coordinatorRuntimePort]: String(runtimePort),
    [ENV.coordinatorRuntimePeers]: JSON.stringify([
      { keyId: runtimeKeyId, botId: BOT_ID, secretSha256: runtimeSecretSha256 },
    ]),
    [ENV.coordinatorControlHost]: HOST,
    [ENV.coordinatorControlPort]: String(controlLinkPort),
    [ENV.coordinatorControlClients]: JSON.stringify([
      {
        clientId: controlClientId,
        keyId: controlKeyId,
        secretSha256: controlSecretSha256,
        capabilities: ["bot.read", "bot.stop"],
      },
    ]),
  });
  await Promise.all([
    waitForTcpPort(runtimePort, coordinator, STARTUP_TIMEOUT_MS),
    waitForTcpPort(controlLinkPort, coordinator, STARTUP_TIMEOUT_MS),
  ]);

  await releaseReservation(controlApiReservation);
  const controlApi = spawnService("control-api", entries.controlApi, {
    [ENV.controlApiHost]: HOST,
    [ENV.controlApiPort]: String(controlApiPort),
    [ENV.controlApiAuth]: JSON.stringify([
      {
        subject: "four-process-dashboard",
        tokenSha256: dashboardTokenSha256,
        permissions: ["bot.read", "bot.position.read", "bot.stop"],
      },
    ]),
    [ENV.controlCoordinatorUrl]: `ws://${HOST}:${controlLinkPort}${CONTROL_LINK_PATH}`,
    [ENV.controlCoordinatorClientId]: controlClientId,
    [ENV.controlCoordinatorKeyId]: controlKeyId,
    [ENV.controlCoordinatorSecret]: controlSecret,
  });

  const controlApiBaseUrl = `http://${HOST}:${controlApiPort}`;
  await waitForControlApiEmpty(
    controlApiBaseUrl,
    dashboardToken,
    controlApi,
    STARTUP_TIMEOUT_MS,
  );

  await releaseReservation(dashboardReservation);
  const dashboard = spawnService("dashboard", entries.dashboard, {
    HOSTNAME: HOST,
    PORT: String(dashboardPort),
    [ENV.dashboardControlUrl]: controlApiBaseUrl,
    [ENV.dashboardControlToken]: dashboardToken,
    [ENV.dashboardStopHash]: confirmationSha256,
  });
  const dashboardBaseUrl = `http://${HOST}:${dashboardPort}`;

  // This is an application-path assertion, not a fixture observation: before
  // Runtime exists, Dashboard must expose the Coordinator's real empty state.
  const emptyState = await waitForDashboardResponse(
    dashboardBaseUrl,
    dashboard,
    (body) => body.data.bots.length === 0,
    STARTUP_TIMEOUT_MS,
  );
  if (
    emptyState.data.source !== "control-api" ||
    emptyState.data.bots.length !== 0 ||
    emptyState.data.capabilities.stopConfirmationConfigured !== true
  ) {
    throw new Error("Dashboard did not expose a configured, genuinely empty control state.");
  }

  const runtime = spawnService(
    "bot-runtime",
    entries.runtime,
    {
      [ENV.runtimeUrl]: `ws://${HOST}:${runtimePort}${RUNTIME_LINK_PATH}`,
      [ENV.runtimeKeyId]: runtimeKeyId,
      [ENV.runtimeSecret]: runtimeSecret,
    },
    { ipc: true, nodeEnvironment: "test" },
  );
  const runtimeReady = await waitForIpcEvent(
    runtime,
    "fixture_ready",
    STARTUP_TIMEOUT_MS,
  );
  if (runtimeReady.botId !== BOT_ID) {
    throw new Error("Runtime fixture reported an unexpected Bot identity.");
  }

  const onlineState = await waitForDashboardResponse(
    dashboardBaseUrl,
    dashboard,
    (body) => body.data.bots.some(
      (bot) => bot.botId === BOT_ID && bot.connectionState === "online",
    ),
    STATE_TIMEOUT_MS,
  );
  assertOnlineFixtureState(onlineState);

  const closeObservationOutcome = waitForIpcEvent(
    runtime,
    "fixture_client_closed",
    STOP_TIMEOUT_MS,
  ).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  const stopResponse = await fetchWithTimeout(
    `${dashboardBaseUrl}/api/bots/${encodeURIComponent(BOT_ID)}/stop`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: dashboardBaseUrl,
        "Sec-Fetch-Site": "same-origin",
        "X-Studio-Action": "stop-bot",
      },
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: TRACE_ID,
        confirmationCode,
      }),
    },
    STOP_TIMEOUT_MS,
  );
  const stopValue = await readJsonResponse(stopResponse, "Dashboard stop");
  if (!stopResponse.ok) {
    throw new Error(`Dashboard stop failed with HTTP ${stopResponse.status}.`);
  }
  const stopResult = schemas.dashboardStopResponseV1Schema.parse(stopValue);
  if (
    stopResult.data.botId !== BOT_ID ||
    stopResult.data.traceId !== TRACE_ID ||
    stopResult.data.commandId !== TRACE_ID ||
    stopResult.data.outcome !== "completed" ||
    stopResult.data.errorCode !== null
  ) {
    throw new Error("Dashboard returned an invalid graceful-stop confirmation.");
  }

  const [closeOutcome, offlineState] = await Promise.all([
    closeObservationOutcome,
    waitForDashboardResponse(
      dashboardBaseUrl,
      dashboard,
      (body) => body.data.bots.some(
        (bot) => bot.botId === BOT_ID && bot.connectionState === "offline",
      ),
      STATE_TIMEOUT_MS,
    ),
  ]);
  if (!closeOutcome.ok) throw closeOutcome.error;
  const closeObservation = closeOutcome.value;
  if (closeObservation.closeCalls !== 1) {
    throw new Error("The test BotClient was not closed exactly once.");
  }
  assertSingleBotState(offlineState, "offline");
  assertTraceAcrossFourProcesses({ coordinator, controlApi, dashboard, runtime });

  return {
    botId: BOT_ID,
    traceId: TRACE_ID,
    coordinator,
    controlApi,
    dashboard,
    runtime,
  };
}

function assertOnlineFixtureState(body) {
  assertSingleBotState(body, "online");
  const bot = body.data.bots[0];
  if (
    bot.health?.current !== 18 ||
    bot.health?.maximum !== 20 ||
    bot.position?.x !== 12 ||
    bot.position?.y !== 64 ||
    bot.position?.z !== -8 ||
    bot.positionRedacted ||
    bot.minecraftVersion?.resolvedVersion !== "1.21.8"
  ) {
    throw new Error("Dashboard state did not preserve deterministic Runtime telemetry.");
  }
}

function assertSingleBotState(body, expectedState) {
  if (
    body.data.source !== "control-api" ||
    body.data.bots.length !== 1 ||
    body.data.bots[0]?.botId !== BOT_ID ||
    body.data.bots[0]?.connectionState !== expectedState
  ) {
    throw new Error(`Dashboard did not expose exactly one ${expectedState} fixture Bot.`);
  }
}

function assertTraceAcrossFourProcesses(processes) {
  const requirements = [
    [processes.dashboard, ["dashboard_stop_requested", "dashboard_stop_result"]],
    [processes.controlApi, ["control_api_stop_requested", "control_api_stop_result"]],
    [processes.runtime, ["bot_runtime_stop_requested", "bot_runtime_stop_result"]],
  ];
  for (const [child, events] of requirements) {
    for (const event of events) {
      if (!child.logRecords.some((record) => record.event === event && record.traceId === TRACE_ID)) {
        throw new Error(`${child.label} did not log ${event} with the fixed traceId.`);
      }
    }
  }

  const auditStatuses = processes.coordinator.logRecords
    .filter(
      (record) =>
        record.event === "coordinator_stop_audit" && record.traceId === TRACE_ID,
    )
    .map((record) => record.status);
  if (JSON.stringify(auditStatuses) !== JSON.stringify(["started", "completed"])) {
    throw new Error("Coordinator did not record the expected trace-bound stop audit sequence.");
  }
}

async function waitForControlApiEmpty(baseUrl, token, child, timeoutMs) {
  const value = await pollUntil(
    async () => {
      assertChildRunning(child, "Control API readiness");
      const response = await fetchWithTimeout(
        `${baseUrl}/v1/bots`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Studio-Schema-Version": "1.0",
          },
        },
        1_500,
      ).catch(() => null);
      if (!response) return null;
      const body = await readJsonResponse(response, "Control API readiness").catch(
        () => null,
      );
      if (response.status === 401 || response.status === 403 || response.status === 400) {
        throw new Error(`Control API rejected its acceptance principal with HTTP ${response.status}.`);
      }
      if (!response.ok || !body) return null;
      const parsed = schemas.botListResponseV1Schema.parse(body);
      if (parsed.data.bots.length !== 0) {
        throw new Error("Control API contained Bot state before the Runtime fixture started.");
      }
      return parsed;
    },
    timeoutMs,
    "Control API authenticated empty snapshot",
  );
  return value;
}

async function waitForDashboardResponse(baseUrl, child, predicate, timeoutMs) {
  return pollUntil(
    async () => {
      assertChildRunning(child, "Dashboard readiness");
      const response = await fetchWithTimeout(
        `${baseUrl}/api/bots`,
        { headers: { Accept: "application/json" } },
        1_500,
      ).catch(() => null);
      if (!response || !response.ok) return null;
      const body = await readJsonResponse(response, "Dashboard bots").catch(() => null);
      if (!body) return null;
      const parsed = schemas.dashboardBotListResponseV1Schema.parse(body);
      return predicate(parsed) ? parsed : null;
    },
    timeoutMs,
    "Dashboard Bot state",
  );
}

async function pollUntil(operation, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    assertAcceptanceActive();
    try {
      const value = await operation();
      if (value !== null && value !== undefined) return value;
    } catch (error) {
      lastError = error;
      if (isTerminalReadinessError(error)) throw error;
    }
    await delay(100);
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}.${suffix}`);
}

function isTerminalReadinessError(error) {
  return error instanceof Error && (
    error.message.includes("exited before") ||
    error.message.includes("rejected its acceptance principal") ||
    error.message.includes("contained Bot state before")
  );
}

async function waitForTcpPort(port, child, timeoutMs) {
  await pollUntil(
    async () => {
      assertChildRunning(child, `TCP ${port}`);
      return new Promise((resolveConnect) => {
        const socket = createConnection({ host: HOST, port });
        const finish = (connected) => {
          socket.removeAllListeners();
          socket.destroy();
          resolveConnect(connected ? true : null);
        };
        socket.setTimeout(500, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
      });
    },
    timeoutMs,
    `loopback TCP port ${port}`,
  );
}

function spawnService(
  label,
  entry,
  extraEnvironment,
  { ipc = false, nodeEnvironment = "production" } = {},
) {
  assertAcceptanceActive();
  const stdio = ipc
    ? ["ignore", "pipe", "pipe", "ipc"]
    : ["ignore", "pipe", "pipe"];
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      ...extraEnvironment,
      NODE_ENV: nodeEnvironment,
    },
    stdio,
    windowsHide: true,
  });
  child.label = label;
  child.logRecords = [];
  child.rawOutput = "";
  child.outputBytes = 0;
  child.ipcInbox = [];
  child.usesIpc = ipc;
  child.closeObserved = false;
  child.closePromise = new Promise((resolveClose) => {
    child.once("close", () => {
      child.closeObserved = true;
      resolveClose();
    });
  });
  children.push(child);

  captureOutput(child, child.stdout, process.stdout);
  captureOutput(child, child.stderr, process.stderr);
  child.on("message", (message) => {
    child.ipcInbox.push(message);
    if (child.ipcInbox.length > 100) child.ipcInbox.shift();
  });
  child.once("error", (error) => {
    child.spawnError = error;
  });
  return child;
}

function captureOutput(child, readable, destination) {
  readable.setEncoding("utf8");
  let lineBuffer = "";
  readable.on("data", (chunk) => {
    destination.write(chunk);
    child.outputBytes += Buffer.byteLength(chunk, "utf8");
    if (child.outputBytes <= MAX_CAPTURED_OUTPUT_BYTES) child.rawOutput += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split(/\r?\n/u);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) rememberJsonLog(child, line);
  });
  readable.once("end", () => {
    if (lineBuffer) rememberJsonLog(child, lineBuffer);
  });
}

function rememberJsonLog(child, line) {
  try {
    const record = JSON.parse(line);
    if (record && typeof record === "object" && !Array.isArray(record)) {
      child.logRecords.push(record);
      if (child.logRecords.length > 10_000) {
        throw new Error(`${child.label} exceeded the structured-log acceptance limit.`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("acceptance limit")) {
      child.captureError = error;
    }
    // Next.js emits human-readable lifecycle lines; only JSON lines are evidence.
  }
}

function assertChildRunning(child, description) {
  if (child.spawnError) throw child.spawnError;
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `${child.label} exited before ${description} (code=${String(child.exitCode)}, signal=${String(child.signalCode)}).`,
    );
  }
}

function waitForIpcEvent(child, expectedEvent, timeoutMs) {
  return new Promise((resolveWait, rejectWait) => {
    const takeExpected = () => {
      const index = child.ipcInbox.findIndex(
        (message) => message?.event === expectedEvent,
      );
      return index < 0 ? null : child.ipcInbox.splice(index, 1)[0];
    };
    const existing = takeExpected();
    if (existing) {
      resolveWait(existing);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      rejectWait(new Error(`Timed out waiting for Runtime IPC event ${expectedEvent}.`));
    }, timeoutMs);
    const onMessage = () => {
      const message = takeExpected();
      if (message) finish(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectWait(
        new Error(
          `Runtime exited before IPC event ${expectedEvent} (code=${String(code)}, signal=${String(signal)}).`,
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

async function fetchWithTimeout(url, init, timeoutMs) {
  return fetch(url, {
    ...init,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function readJsonResponse(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned a non-JSON response.`);
  }
}

async function reserveLoopbackPorts(count) {
  const values = [];
  try {
    for (let index = 0; index < count; index += 1) {
      assertAcceptanceActive();
      const server = createServer();
      const reservation = {
        server,
        port: 0,
        releasePromise: null,
        sockets: new Set(),
      };
      reservations.add(reservation);
      values.push(reservation);
      server.on("connection", (socket) => {
        reservation.sockets.add(socket);
        socket.once("close", () => reservation.sockets.delete(socket));
        socket.destroy();
      });
      server.unref();
      server.listen({ host: HOST, port: 0, exclusive: true });
      await once(server, "listening");
      assertAcceptanceActive();
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not reserve a loopback acceptance port.");
      }
      reservation.port = address.port;
    }
    return values;
  } catch (error) {
    await Promise.allSettled(values.map(releaseReservation));
    throw error;
  }
}

async function releaseReservation(reservation) {
  if (reservation.releasePromise) return reservation.releasePromise;
  reservation.releasePromise = new Promise((resolveClose, rejectClose) => {
    for (const socket of reservation.sockets) socket.destroy();
    reservation.server.closeAllConnections?.();
    reservation.server.close((error) => {
      reservations.delete(reservation);
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
  return reservation.releasePromise;
}

async function releaseAllReservations() {
  const results = await Promise.allSettled(
    [...reservations].map(releaseReservation),
  );
  for (const result of results) {
    if (result.status === "rejected") reservationCleanupErrors.push(result.reason);
  }
}

async function stopChildren() {
  const forced = [];
  const handled = new Set();
  while (true) {
    const pending = [...children].filter((child) => !handled.has(child)).reverse();
    if (pending.length === 0) break;
    for (const child of pending) {
      handled.add(child);
      if (await stopChild(child)) forced.push(child.label);
    }
  }
  return forced;
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    if (child.usesIpc && child.connected) {
      try {
        child.send({ type: "shutdown" });
      } catch {
        // The fixture may have already closed its IPC channel while exiting.
      }
    } else {
      child.kill("SIGTERM");
    }
  }
  await settleWithin(child.closePromise, 3_000);
  if (child.closeObserved) return false;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  child.stdout?.destroy();
  child.stderr?.destroy();
  await settleWithin(child.closePromise, 1_000);
  return true;
}

function assertNoSensitiveOutput() {
  for (const child of children) {
    if (child.outputBytes > MAX_CAPTURED_OUTPUT_BYTES) {
      throw new Error(`${child.label} exceeded the captured-output security boundary.`);
    }
    if (child.captureError) throw child.captureError;
    for (const secret of secretsToReject) {
      if (secret && child.rawOutput.includes(secret)) {
        throw new Error(`${child.label} leaked acceptance credentials into process output.`);
      }
    }
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertAcceptanceActive() {
  if (acceptanceCancelled) {
    throw new Error("Four-process acceptance was cancelled before completion.");
  }
}

let acceptanceResult = null;
let acceptanceError = null;
let overallTimer;
let acceptancePromise;
let rejectForSignal;
let receivedSignalCount = 0;
let signalError = null;
const signalCancellation = new Promise((_, rejectSignal) => {
  rejectForSignal = rejectSignal;
});
const handleSignal = (signal) => {
  receivedSignalCount += 1;
  if (receivedSignalCount > 1) {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.exit(1);
  }
  acceptanceCancelled = true;
  signalError = new Error(`Four-process acceptance received ${signal}.`);
  rejectForSignal(signalError);
};
const handleSigint = () => handleSignal("SIGINT");
const handleSigterm = () => handleSignal("SIGTERM");
process.on("SIGINT", handleSigint);
process.on("SIGTERM", handleSigterm);
try {
  const timeout = new Promise((_, rejectTimeout) => {
    overallTimer = setTimeout(() => {
      acceptanceCancelled = true;
      rejectTimeout(new Error("Four-process acceptance timed out."));
    }, OVERALL_TIMEOUT_MS);
  });
  acceptancePromise = runAcceptance();
  acceptanceResult = await Promise.race([
    acceptancePromise,
    timeout,
    signalCancellation,
  ]);
} catch (error) {
  acceptanceError = error;
} finally {
  acceptanceCancelled = true;
  if (overallTimer) clearTimeout(overallTimer);
  await releaseAllReservations();
  const forcedChildren = await stopChildren();
  if (acceptancePromise) {
    await settleWithin(acceptancePromise.catch(() => undefined), 2_000);
  }
  await releaseAllReservations();
  forcedChildren.push(...(await stopChildren()));
  try {
    assertNoSensitiveOutput();
    if (forcedChildren.length > 0) {
      throw new Error(
        `Application processes required forced cleanup: ${forcedChildren.join(", ")}.`,
      );
    }
    if (reservationCleanupErrors.length > 0) {
      throw new Error("One or more loopback port reservations failed to close.");
    }
  } catch (error) {
    acceptanceError ??= error;
  }
  acceptanceError ??= signalError;
  process.off("SIGINT", handleSigint);
  process.off("SIGTERM", handleSigterm);
}

if (acceptanceError) {
  const message = acceptanceError instanceof Error
    ? acceptanceError.message
    : "Unknown four-process acceptance error.";
  console.error(JSON.stringify({
    service: "four-process-acceptance",
    event: "acceptance_failed",
    code: "FOUR_PROCESS_ACCEPTANCE_FAILED",
    message,
    applicationProcesses: 4,
    transport: "loopback-http-websocket",
    minecraftConnected: false,
  }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    service: "four-process-acceptance",
    event: "acceptance_passed",
    applicationProcesses: 4,
    supervisorProcessExcluded: true,
    transport: "loopback-http-websocket",
    minecraftConnected: false,
    testRuntimeFixture: true,
    botId: acceptanceResult.botId,
    traceId: acceptanceResult.traceId,
    outcome: "completed",
    finalState: "offline",
    closeCalls: 1,
  }));
}
