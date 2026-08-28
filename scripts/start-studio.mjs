import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseEnv } from "node:util";

import {
  createLocalBotSlots,
  discoverLocalAIWithRetry,
  loadLocalAIKeyFile,
  StudioLocalManager,
} from "./studio-local-manager.mjs";

const packagedMode = process.env.STUDIO_SEA_BUNDLE === "1";
const repositoryRoot = path.resolve(
  process.env.STUDIO_BUNDLE_ROOT?.trim() || path.resolve(import.meta.dirname, ".."),
);
const configRoot = path.resolve(
  process.env.STUDIO_CONFIG_ROOT?.trim() || repositoryRoot,
);
const runtimeRoot = path.resolve(
  process.env.STUDIO_RUNTIME_ROOT?.trim() || path.join(repositoryRoot, "runtime-data"),
);
const logRoot = path.join(runtimeRoot, "logs");
const secretPath = path.join(runtimeRoot, "local-control-secrets.json");
const children = new Map();
let studioManager = null;
let stopping = false;
let stopPromise = null;
const shutdownPreload = `data:text/javascript,${encodeURIComponent(
  "process.on('message', (message) => { if (message?.type === 'studio.shutdown') process.emit('SIGTERM'); });",
)}`;

process.once("SIGINT", () => void stopAll("SIGINT"));
process.once("SIGTERM", () => void stopAll("SIGTERM"));

const environmentFileValues = {
  ...(await loadEnvironmentFile(path.join(configRoot, ".env"))),
  ...(await loadEnvironmentFile(path.join(configRoot, ".env.local"))),
};
const hostEnvironment = await loadLocalAIKeyFile(
  { ...environmentFileValues, ...process.env },
  configRoot,
);
const runtimeLinkPort = boundedPort(
  hostEnvironment.COORDINATOR_RUNTIME_LINK_PORT ?? "3220",
  "COORDINATOR_RUNTIME_LINK_PORT",
);
const controlLinkPort = boundedPort(
  hostEnvironment.COORDINATOR_CONTROL_LINK_PORT ?? "3221",
  "COORDINATOR_CONTROL_LINK_PORT",
);
const controlApiPort = boundedPort(
  hostEnvironment.CONTROL_API_PORT ?? "3210",
  "CONTROL_API_PORT",
);
const dashboardPort = boundedPort(hostEnvironment.STUDIO_DASHBOARD_PORT ?? "3000");
const managerPort = boundedPort(
  hostEnvironment.STUDIO_MANAGER_PORT ?? "3230",
  "STUDIO_MANAGER_PORT",
);
const productionTaskDelivery =
  hostEnvironment.COORDINATOR_TASK_DELIVERY?.trim() === "production";
const goalExecutionPort = productionTaskDelivery
  ? boundedPort(
      hostEnvironment.COORDINATOR_TASK_EXECUTION_PORT ?? "3222",
      "COORDINATOR_TASK_EXECUTION_PORT",
    )
  : null;
const configuredPorts = [
  runtimeLinkPort,
  controlLinkPort,
  controlApiPort,
  dashboardPort,
  managerPort,
  ...(goalExecutionPort === null ? [] : [goalExecutionPort]),
];
if (new Set(configuredPorts).size !== configuredPorts.length) {
  throw new Error("Studio service ports must be unique.");
}
await assertPortsAvailable(configuredPorts);
const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
await mkdir(logRoot, { recursive: true });
const secrets = await loadOrCreateSecrets();
const runtimeMasterSecret = firstValidSecret(
  hostEnvironment.BOT_RUNTIME_LINK_SECRET_STUDIO_BOT_01,
  hostEnvironment.BOT_RUNTIME_LINK_SECRET,
  secrets.runtimeSecret,
);
const maxBots = boundedCount(
  hostEnvironment.STUDIO_MAX_BOTS ?? "16",
  "STUDIO_MAX_BOTS",
  1,
  16,
);
const botSlots = withConfiguredFirstSlotKey(
  createLocalBotSlots(runtimeMasterSecret, maxBots),
  hostEnvironment.BOT_RUNTIME_LINK_KEY_ID,
);
const aiDiscovery = await discoverLocalAIWithRetry(hostEnvironment);
const effectiveHostEnvironment = aiDiscovery.config
  ? {
      ...hostEnvironment,
      LOCAL_AI_PROVIDER: aiDiscovery.config.provider,
      LOCAL_AI_HUB_URL: aiDiscovery.config.baseUrl,
      LOCAL_AI_MODEL: aiDiscovery.config.model,
    }
  : hostEnvironment;
const environment = buildEnvironment(secrets, effectiveHostEnvironment, {
  runtimeLinkPort,
  controlLinkPort,
  controlApiPort,
  managerPort,
  goalExecutionPort,
}, botSlots);

await requireBuildArtifacts([
  "apps/coordinator/dist/main.js",
  "apps/control-api/dist/main.js",
  "apps/bot-runtime/dist/index.js",
  packagedMode
    ? "apps/dashboard/.next/standalone/apps/dashboard/.next/BUILD_ID"
    : "apps/dashboard/.next/BUILD_ID",
  ...(productionTaskDelivery ? ["apps/task-worker/dist/main.js"] : []),
]);

try {
  const coordinator = startService("coordinator", "apps/coordinator/dist/main.js", [], environment);
  await waitForTcp(coordinator, "127.0.0.1", controlLinkPort, 15_000, "Coordinator Control Link");

  if (productionTaskDelivery) {
    const taskWorker = startService(
      "task-worker",
      "apps/task-worker/dist/main.js",
      [],
      environment,
    );
    await waitForServiceStable(taskWorker, 500, "Task Worker");
  }

  const controlApi = startService("control-api", "apps/control-api/dist/main.js", [], environment);
  await waitForHttp(
    controlApi,
    `http://127.0.0.1:${controlApiPort}/v1/bots`,
    environment.DASHBOARD_CONTROL_API_TOKEN,
    15_000,
    "Control API",
  );

  studioManager = new StudioLocalManager({
    repositoryRoot,
    runtimeRoot,
    port: managerPort,
    token: environment.DASHBOARD_STUDIO_MANAGER_TOKEN,
    slots: botSlots,
    aiStatus: aiDiscovery.status,
    environment,
    runtimeLinkPort,
    packagedMode,
  });
  await studioManager.start();

  if (environment.BOT_SUPERVISOR_CONFIG_PATH) {
    startService(
      "bot-supervisor",
      "apps/bot-runtime/dist/supervisor-main.js",
      [],
      environment,
    );
  } else if (environment.BOT_SERVER_PROFILE_PATH) {
    startService(
      "bot-runtime-explicit",
      "apps/bot-runtime/dist/index.js",
      [],
      environment,
    );
  }

  const dashboard = packagedMode
    ? startService(
        "dashboard",
        "apps/dashboard/.next/standalone/apps/dashboard/server.js",
        [],
        {
          ...environment,
          HOSTNAME: "127.0.0.1",
          PORT: String(dashboardPort),
        },
        path.join(repositoryRoot, "apps/dashboard/.next/standalone/apps/dashboard"),
      )
    : startService(
        "dashboard",
        "apps/dashboard/node_modules/next/dist/bin/next",
        ["start", "--hostname", "127.0.0.1", "--port", String(dashboardPort)],
        environment,
        path.join(repositoryRoot, "apps/dashboard"),
      );
  await waitForDashboard(dashboard, dashboardUrl, 20_000);
  process.stdout.write(`Minecraft Multi-Agent Studio ready: ${dashboardUrl}\n`);
  if (packagedMode && hostEnvironment.STUDIO_OPEN_BROWSER?.trim() !== "0") {
    openDashboardInBrowser(dashboardUrl);
  }
  process.stdout.write(
    environment.BOT_SUPERVISOR_CONFIG_PATH
      ? "Bot Supervisor enabled from explicit configuration.\n"
      : environment.BOT_SERVER_PROFILE_PATH
        ? "Single Bot Runtime enabled from explicit ServerProfile.\n"
        : "Local Bot Manager ready for Dashboard-created runtimes.\n",
  );
  if (productionTaskDelivery) {
    process.stdout.write("Durable Coordinator goal execution is enabled.\n");
  }
  process.stdout.write(
    environment.LOCAL_AI_HUB_URL && environment.LOCAL_AI_MODEL
      ? `Local AI configured: ${new URL(environment.LOCAL_AI_HUB_URL).origin}\n`
      : "Local AI is not configured; goal submission will fail closed.\n",
  );
  process.stdout.write(
    environment.COORDINATOR_TASK_POSTGRES_URL
      ? "Durable task history configured; the Coordinator will verify the pre-applied schema.\n"
      : "Desktop task history is active in process memory for this session.\n",
  );
} catch (cause) {
  process.stderr.write(`${boundedError(cause)}\n`);
  await stopAll("startup_failure");
  process.exitCode = 1;
}

function startService(name, relativeEntry, args, env, cwd = repositoryRoot) {
  if (stopping) throw new Error(`Cannot start ${name} while Studio is stopping.`);
  const entry = path.join(repositoryRoot, relativeEntry);
  const log = createWriteStream(path.join(logRoot, `${name}.log`), { flags: "a" });
  const childArgs = packagedMode
    ? [
        "--studio-service",
        path.relative(repositoryRoot, entry).split(path.sep).join("/"),
        ...args,
      ]
    : ["--import", shutdownPreload, entry, ...args];
  const child = spawn(process.execPath, childArgs, {
    cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const service = { name, child, log, exitError: null, exited: false };
  children.set(name, service);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.once("error", (error) => {
    service.exitError = error;
    process.stderr.write(`${name} failed to start: ${boundedError(error)}\n`);
    void stopAll(`${name}_error`);
  });
  child.once("exit", (code, signal) => {
    service.exited = true;
    log.end();
    children.delete(name);
    if (!stopping) {
      process.stderr.write(
        `${name} exited unexpectedly (code=${code ?? "none"}, signal=${signal ?? "none"}).\n`,
      );
      process.exitCode = 1;
      void stopAll(`${name}_exit`);
    }
  });
  return service;
}

function openDashboardInBrowser(url) {
  const browser = spawn("explorer.exe", [url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  browser.once("error", (cause) => {
    process.stderr.write(`Unable to open the Dashboard automatically: ${boundedError(cause)}\n`);
  });
  browser.unref();
}

async function stopAll(reason) {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    process.stdout.write(`Stopping Studio services: ${reason}\n`);
    if (studioManager) {
      await studioManager.stop();
      studioManager = null;
    }
    const running = [...children.values()];
    await Promise.all(running.map((service) => stopService(service)));
  })();
  return stopPromise;
}

async function loadEnvironmentFile(filePath) {
  try {
    const source = await readFile(filePath, "utf8");
    return parseEnv(source);
  } catch (cause) {
    if (cause?.code === "ENOENT") return {};
    throw new Error(`Unable to load ${path.basename(filePath)}: ${boundedError(cause)}`);
  }
}

async function loadOrCreateSecrets() {
  try {
    const input = JSON.parse(await readFile(secretPath, "utf8"));
    if (
      input?.schemaVersion === "1.0" &&
      validSecret(input.runtimeSecret) &&
      validSecret(input.controlLinkSecret) &&
      validSecret(input.dashboardToken)
    ) {
      return input;
    }
    throw new Error("Local control secret file is invalid.");
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
    const value = {
      schemaVersion: "1.0",
      runtimeSecret: randomBytes(32).toString("base64url"),
      controlLinkSecret: randomBytes(32).toString("base64url"),
      dashboardToken: randomBytes(32).toString("base64url"),
    };
    await writeFile(secretPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      await chmod(secretPath, 0o600);
    } catch {
      // Windows ACLs remain authoritative when POSIX modes are unavailable.
    }
    return value;
  }
}

function buildEnvironment(secrets, hostEnvironment, ports, botSlots) {
  const postgresConfigured = Boolean(
    hostEnvironment.COORDINATOR_TASK_POSTGRES_URL?.trim(),
  );
  const runtimePeers = buildRuntimePeers(
    hostEnvironment.COORDINATOR_RUNTIME_LINK_PEERS_JSON,
    botSlots,
  );
  const controlClientId = hostEnvironment.CONTROL_API_COORDINATOR_LINK_CLIENT_ID || "local-control-api";
  const controlKeyId = hostEnvironment.CONTROL_API_COORDINATOR_LINK_KEY_ID || "control-api-key-01";
  const controlSecret = hostEnvironment.CONTROL_API_COORDINATOR_LINK_SECRET || secrets.controlLinkSecret;
  const taskExecutionSecret =
    hostEnvironment.COORDINATOR_TASK_EXECUTION_SECRET ||
    sha256(`minecraft-studio-task-execution\n${secrets.controlLinkSecret}`);
  const configuredControlClients = hostEnvironment.COORDINATOR_CONTROL_LINK_CLIENTS_JSON?.trim();
  const controlClients = configuredControlClients
    ? validateConfiguredControlClients(
      configuredControlClients,
      controlClientId,
      controlKeyId,
      controlSecret,
      hostEnvironment.CONTROL_API_COORDINATOR_LINK_SECRET,
    )
    : JSON.stringify([
      {
        clientId: controlClientId,
        keyId: controlKeyId,
        secretSha256: sha256(controlSecret),
        capabilities: ["bot.read", "bot.stop", "goal.submit", "task.read"],
      },
    ]);
  const dashboardToken = hostEnvironment.DASHBOARD_CONTROL_API_TOKEN || secrets.dashboardToken;
  const configuredPrincipals = hostEnvironment.CONTROL_API_AUTH_JSON?.trim();
  const controlPrincipals = configuredPrincipals
    ? validateConfiguredPrincipals(configuredPrincipals, dashboardToken, hostEnvironment.DASHBOARD_CONTROL_API_TOKEN)
    : JSON.stringify([
      {
        subject: "local-dashboard",
        tokenSha256: sha256(dashboardToken),
        permissions: ["bot.read", "bot.position.read", "bot.stop", "goal.submit", "task.read"],
      },
    ]);
  const taskWorkerEnvironment = ports.goalExecutionPort === null
    ? {}
    : {
        COORDINATOR_TASK_EXECUTION_HOST: "127.0.0.1",
        COORDINATOR_TASK_EXECUTION_PORT: String(ports.goalExecutionPort),
        COORDINATOR_TASK_EXECUTION_SECRET: taskExecutionSecret,
        TASK_WORKER_PURPOSE: "production",
        TASK_WORKER_HANDLER_PROFILE: "coordinator-goal",
      };
  return {
    ...hostEnvironment,
    COORDINATOR_RUNTIME_LINK_HOST: "127.0.0.1",
    COORDINATOR_RUNTIME_LINK_PORT: String(ports.runtimeLinkPort),
    COORDINATOR_RUNTIME_LINK_PEERS_JSON: runtimePeers,
    COORDINATOR_CONTROL_LINK_HOST: "127.0.0.1",
    COORDINATOR_CONTROL_LINK_PORT: String(ports.controlLinkPort),
    COORDINATOR_CONTROL_LINK_CLIENTS_JSON: controlClients,
    CONTROL_API_HOST: "127.0.0.1",
    CONTROL_API_PORT: String(ports.controlApiPort),
    CONTROL_API_AUTH_JSON: controlPrincipals,
    CONTROL_API_COORDINATOR_LINK_URL:
      `ws://127.0.0.1:${ports.controlLinkPort}/v1/control-link`,
    CONTROL_API_COORDINATOR_LINK_CLIENT_ID: controlClientId,
    CONTROL_API_COORDINATOR_LINK_KEY_ID: controlKeyId,
    CONTROL_API_COORDINATOR_LINK_SECRET: controlSecret,
    DASHBOARD_CONTROL_API_URL: `http://127.0.0.1:${ports.controlApiPort}`,
    DASHBOARD_CONTROL_API_TOKEN: dashboardToken,
    DASHBOARD_STUDIO_MANAGER_URL: `http://127.0.0.1:${ports.managerPort}`,
    DASHBOARD_STUDIO_MANAGER_TOKEN: dashboardToken,
    COORDINATOR_TASK_POSTGRES_SCHEMA: postgresConfigured
      ? hostEnvironment.COORDINATOR_TASK_POSTGRES_SCHEMA
      : "",
    COORDINATOR_LOCAL_MEMORY_MODE:
      postgresConfigured ? "0" : "1",
    ...taskWorkerEnvironment,
    BOT_RUNTIME_LINK_SECRET_STUDIO_BOT_01:
      hostEnvironment.BOT_RUNTIME_LINK_SECRET_STUDIO_BOT_01 || secrets.runtimeSecret,
  };
}

function buildRuntimePeers(raw, botSlots) {
  let peers = [];
  if (raw?.trim()) {
    try {
      peers = JSON.parse(raw);
    } catch {
      throw new Error("COORDINATOR_RUNTIME_LINK_PEERS_JSON is invalid JSON.");
    }
    if (!Array.isArray(peers)) {
      throw new Error("COORDINATOR_RUNTIME_LINK_PEERS_JSON must be an array.");
    }
  }
  for (const slot of botSlots) {
    const byKey = peers.find((entry) => entry?.keyId === slot.keyId);
    const byBot = peers.find((entry) => entry?.botId === slot.botId);
    const existing = byKey ?? byBot;
    if (existing) {
      if (
        existing.keyId !== slot.keyId ||
        existing.botId !== slot.botId ||
        existing.secretSha256 !== slot.secretSha256
      ) {
        throw new Error(
          `Runtime Link ACL conflicts with managed Bot slot ${slot.botId}.`,
        );
      }
      continue;
    }
    peers.push({
      keyId: slot.keyId,
      botId: slot.botId,
      secretSha256: slot.secretSha256,
    });
  }
  return JSON.stringify(peers);
}

function withConfiguredFirstSlotKey(slots, configuredKeyId) {
  const keyId = configuredKeyId?.trim();
  if (!keyId) return slots;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(keyId)) {
    throw new Error("BOT_RUNTIME_LINK_KEY_ID is invalid.");
  }
  return slots.map((slot, index) =>
    index === 0 ? Object.freeze({ ...slot, keyId }) : slot,
  );
}

async function waitForServiceStable(service, durationMs, label) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    assertServiceAlive(service, label);
    await delay(50);
  }
  assertServiceAlive(service, label);
}

function validateConfiguredControlClients(raw, clientId, keyId, secret, explicitSecret) {
  let clients;
  try {
    clients = JSON.parse(raw);
  } catch {
    throw new Error("COORDINATOR_CONTROL_LINK_CLIENTS_JSON is invalid JSON.");
  }
  if (!explicitSecret) {
    throw new Error("Custom Control Link ACL requires CONTROL_API_COORDINATOR_LINK_SECRET.");
  }
  const matching = Array.isArray(clients)
    ? clients.find((entry) => entry?.clientId === clientId && entry?.keyId === keyId)
    : null;
  if (!matching || matching.secretSha256 !== sha256(secret)) {
    throw new Error("Control API Control Link credentials do not match the configured ACL.");
  }
  return raw;
}

function validateConfiguredPrincipals(raw, token, explicitToken) {
  let principals;
  try {
    principals = JSON.parse(raw);
  } catch {
    throw new Error("CONTROL_API_AUTH_JSON is invalid JSON.");
  }
  if (!explicitToken) {
    throw new Error("Custom Control API ACL requires DASHBOARD_CONTROL_API_TOKEN.");
  }
  const matching = Array.isArray(principals)
    ? principals.find((entry) => entry?.tokenSha256 === sha256(token))
    : null;
  if (!matching || !Array.isArray(matching.permissions) || !matching.permissions.includes("bot.read")) {
    throw new Error("Dashboard Control API credentials do not match the configured ACL.");
  }
  if (!matching.permissions.includes("task.read")) {
    matching.permissions = [...matching.permissions, "task.read"];
  }
  return JSON.stringify(principals);
}

async function requireBuildArtifacts(relativePaths) {
  for (const relativePath of relativePaths) {
    try {
      await stat(path.join(repositoryRoot, relativePath));
    } catch {
      throw new Error(`Build artifact is missing: ${relativePath}. Run pnpm build first.`);
    }
  }
}

async function assertPortsAvailable(ports) {
  const { createServer } = await import("node:net");
  for (const port of ports) {
    await new Promise((resolve, reject) => {
      const server = createServer();
      const fail = (cause) => {
        server.close();
        if (cause?.code === "EADDRINUSE") {
          reject(new Error(`Studio port ${port} is already in use.`));
        } else {
          reject(cause);
        }
      };
      server.once("error", fail);
      server.listen({ host: "127.0.0.1", port }, () => {
        server.close((closeError) => {
          if (closeError) reject(closeError);
          else resolve();
        });
      });
    });
  }
}

async function waitForTcp(service, host, port, timeoutMs, label) {
  const { connect } = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertServiceAlive(service, label);
    const ready = await new Promise((resolve) => {
      const socket = connect({ host, port });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) {
      await delay(25);
      assertServiceAlive(service, label);
      return;
    }
    await delay(100);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms.`);
}

async function waitForHttp(service, url, token, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertServiceAlive(service, label);
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        await delay(25);
        assertServiceAlive(service, label);
        return;
      }
    } catch {
      // Retry until the bounded startup deadline.
    }
    await delay(150);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms.`);
}

async function waitForDashboard(service, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertServiceAlive(service, "Dashboard");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        await delay(25);
        assertServiceAlive(service, "Dashboard");
        return;
      }
    } catch {
      // Retry until the bounded startup deadline.
    }
    await delay(200);
  }
  throw new Error(`Dashboard did not become ready within ${timeoutMs}ms.`);
}

function assertServiceAlive(service, label) {
  if (stopping) throw new Error(`${label} startup cancelled.`);
  if (service.exitError) throw new Error(`${label} failed to start: ${boundedError(service.exitError)}`);
  if (service.exited || service.child.exitCode !== null || service.child.signalCode !== null) {
    throw new Error(`${label} exited before becoming ready.`);
  }
}

async function stopService(service) {
  const { child } = service;
  if (service.exited || child.exitCode !== null) return;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      finish();
    }, 10_000);
    child.once("exit", finish);

    if (process.platform === "win32" && child.connected) {
      child.send({ type: "studio.shutdown" }, (error) => {
        if (error && child.exitCode === null) child.kill("SIGTERM");
        disconnectChild(child);
      });
    } else {
      child.kill("SIGTERM");
    }
  });
}

function disconnectChild(child) {
  if (!child.connected || typeof child.disconnect !== "function") return;
  try {
    child.disconnect();
  } catch {
    // The child may have exited between the connected check and disconnect.
  }
}

function validSecret(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 512;
}

function firstValidSecret(...values) {
  const selected = values.find(validSecret);
  if (!selected) throw new Error("No valid local Runtime Link secret is available.");
  return selected;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedPort(value, name = "STUDIO_DASHBOARD_PORT") {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} is invalid.`);
  }
  return port;
}

function boundedCount(value, name, minimum, maximum) {
  if (!/^[0-9]+$/u.test(String(value))) {
    throw new Error(`${name} is invalid.`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < minimum || count > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return count;
}

function boundedError(cause) {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
