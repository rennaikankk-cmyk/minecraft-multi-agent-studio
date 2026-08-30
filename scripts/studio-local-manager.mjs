import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { IncidentStore } from "../packages/skills/dist/incidents.js";
import { isIP } from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseEnv } from "node:util";

const DEFAULT_SPARK_HOSTS = Object.freeze([
  "192.168.100.2",
  "dgx-spark.local",
  "spark.local",
  "127.0.0.1",
]);
// Keep the historical loopback tunnels in the discovery set as well as the
// directly reachable Spark service ports. The endpoint probe still requires a
// real /v1/models or /api/tags response before any service is selected.
const DEFAULT_SPARK_PORTS = Object.freeze([
  18100,
  18102,
  8000,
  8001,
  11434,
  11435,
]);
const MAX_REQUEST_BYTES = 16 * 1024;
const BOT_ID_PATTERN = /^studio-bot-([0-9]{2})$/u;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u;
const shutdownPreload = `data:text/javascript,${encodeURIComponent(
  "process.on('message', (message) => { if (message?.type === 'studio.shutdown') process.emit('SIGTERM'); });",
)}`;

export async function loadLocalAIKeyFile(environment, configRoot) {
  if (environment.LOCAL_AI_API_KEY?.trim()) return environment;
  const configuredPath = environment.LOCAL_AI_API_KEY_FILE?.trim();
  if (!configuredPath) return environment;

  const keyPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(configRoot, configuredPath);
  let values;
  try {
    values = parseEnv(await readFile(keyPath, "utf8"));
  } catch (cause) {
    const detail = cause?.code === "ENOENT" ? "does not exist" : "could not be read";
    throw new Error(`Local AI API key file ${detail}.`);
  }
  const apiKey = (values.LOCAL_AI_API_KEY ?? values.VLLM_API_KEY ?? "").trim();
  if (!apiKey || apiKey.length > 4_096) {
    throw new Error("Local AI API key file does not contain a valid key.");
  }
  return { ...environment, LOCAL_AI_API_KEY: apiKey };
}

export async function discoverLocalAI(environment = process.env) {
  const checkedAt = new Date().toISOString();
  const rawUrl = environment.LOCAL_AI_HUB_URL?.trim() ?? "";
  const preferredModel = environment.LOCAL_AI_MODEL?.trim() ?? "";
  const apiKey = environment.LOCAL_AI_API_KEY?.trim() || undefined;
  const configuredProvider = normalizedProvider(environment.LOCAL_AI_PROVIDER);
  if (rawUrl) {
    const explicit = await probeExplicitEndpoint(
      rawUrl,
      configuredProvider,
      preferredModel,
      apiKey,
      "explicit",
    );
    return explicit ?? {
      config: null,
      status: unavailableAiStatus(
        "explicit",
        configuredProvider,
        safeOrigin(rawUrl),
        preferredModel || null,
        checkedAt,
        "已配置的 Local AI 地址不可用。",
      ),
    };
  }

  if (environment.STUDIO_SPARK_AUTO_DISCOVERY?.trim() === "0") {
    return {
      config: null,
      status: {
        state: "disabled",
        source: "disabled",
        provider: null,
        baseUrl: null,
        model: null,
        models: [],
        latencyMs: null,
        lastCheckedAt: checkedAt,
        message: "Spark 自动发现已关闭。",
      },
    };
  }

  const hosts = discoveryHosts(environment.STUDIO_SPARK_HOSTS);
  const ports = discoveryPorts(environment.STUDIO_SPARK_PORTS);
  const candidates = [];
  for (const host of hosts) {
    for (const port of ports) {
      const provider = port === 11434 || port === 11435 ? "ollama" : "vllm";
      candidates.push({
        provider,
        baseUrl: `http://${urlHost(host)}:${port}`,
      });
    }
  }

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const probe = await probeAIEndpoint({ ...candidate, apiKey }, 1_200);
      return probe ? { candidate, probe } : null;
    }),
  );
  for (const result of results) {
    if (!result) continue;
    const selection = selectModel(result.probe.models, preferredModel);
  if (selection.error) {
    return {
      config: null,
      probe: result.probe,
      reason: selection.error,
      ...(selection.models ? { availableModels: selection.models } : {}),
    };
  }
  const model = selection.model;
    if (!model) continue;
    return {
      config: {
        provider: result.candidate.provider,
        baseUrl: result.candidate.baseUrl,
        model,
      },
      status: {
        state: "connected",
        source: "discovered",
        provider: result.candidate.provider,
        baseUrl: result.candidate.baseUrl,
        model,
        models: result.probe.models,
        latencyMs: result.probe.latencyMs,
        lastCheckedAt: result.probe.checkedAt,
        message: "已自动发现并连接 DGX Spark 推理服务。",
      },
    };
  }

  return {
    config: null,
    status: unavailableAiStatus(
      "discovered",
      null,
      null,
      preferredModel || null,
      checkedAt,
      "未在已批准的 Spark 主机和端口上发现推理服务。",
    ),
  };
}

/**
 * Spark is often brought up a few seconds before or after the desktop
 * launcher. Give the configured/discovered endpoint a bounded startup window
 * so a transient boot race does not permanently disable the Coordinator for
 * the whole Studio process.
 */
export async function discoverLocalAIWithRetry(
  environment = process.env,
  options = {},
) {
  const startupWaitMs = boundedDiscoveryWait(
    options.startupWaitMs ?? environment.STUDIO_SPARK_STARTUP_WAIT_MS,
    15_000,
    "STUDIO_SPARK_STARTUP_WAIT_MS",
  );
  const retryIntervalMs = boundedDiscoveryWait(
    options.retryIntervalMs,
    1_000,
    "Spark discovery retry interval",
  );
  let latest = await discoverLocalAI(environment);
  if (
    latest.config ||
    latest.status.state === "disabled" ||
    startupWaitMs === 0
  ) {
    return latest;
  }

  const deadline = Date.now() + startupWaitMs;
  while (Date.now() < deadline) {
    await delay(Math.min(retryIntervalMs, deadline - Date.now()));
    latest = await discoverLocalAI(environment);
    if (latest.config) return latest;
  }
  return latest;
}

export function createLocalBotSlots(masterSecret, count = 16) {
  if (typeof masterSecret !== "string" || masterSecret.length < 32) {
    throw new TypeError("Local Bot slot secret is invalid.");
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 16) {
    throw new TypeError("Local Bot slot count is invalid.");
  }
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    const botId = `studio-bot-${suffix}`;
    const secret = index === 0
      ? masterSecret
      : createHmac("sha256", masterSecret)
        .update(`minecraft-studio-local-bot\n${botId}`, "utf8")
        .digest("base64url");
    return Object.freeze({
      botId,
      keyId: `runtime-key-${suffix}`,
      secret,
      secretSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
    });
  });
}

export class StudioLocalManager {
  constructor(options) {
    this.options = options;
    this.server = null;
    this.aiTimer = null;
    this.stopping = false;
    this.configs = new Map();
    this.processes = new Map();
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    this.botRoot = path.join(this.runtimeRoot, "bots");
    this.manifestPath = path.join(this.runtimeRoot, "local-bots.json");
    this.logRoot = path.join(this.runtimeRoot, "logs");
    this.slots = new Map(options.slots.map((slot) => [slot.botId, slot]));
    this.aiStatus = structuredClone(options.aiStatus);
  }

  async start() {
    await Promise.all([
      mkdir(this.botRoot, { recursive: true }),
      mkdir(this.logRoot, { recursive: true }),
    ]);
    await this.loadManifest();
    this.incidents = new IncidentStore({
      persistPath: process.env.STUDIO_INCIDENT_STORE_PATH?.trim() || path.join(this.runtimeRoot, "incidents.json"),
    });
    this.server = createServer(
      {
        maxHeaderSize: 16_384,
        headersTimeout: 5_000,
        requestTimeout: 10_000,
        keepAliveTimeout: 5_000,
      },
      (request, response) => void this.handleRequest(request, response),
    );
    await new Promise((resolve, reject) => {
      const fail = (error) => reject(error);
      this.server.once("error", fail);
      this.server.listen(
        { host: "127.0.0.1", port: this.options.port, exclusive: true },
        () => {
          this.server.off("error", fail);
          resolve();
        },
      );
    });
    this.aiTimer = setInterval(() => void this.refreshAIStatus(), 10_000);
    this.aiTimer.unref?.();
    for (const botId of this.configs.keys()) {
      await this.startBot(botId);
    }
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Studio Manager did not receive a TCP address.");
    }
    return { host: "127.0.0.1", port: address.port };
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.aiTimer) clearInterval(this.aiTimer);
    this.aiTimer = null;
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server.closeAllConnections();
      this.server = null;
    }
    await Promise.allSettled(
      [...this.processes.keys()].map((botId) => this.stopBot(botId)),
    );
  }

  status() {
    return {
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      ai: structuredClone(this.aiStatus),
      bots: [...this.configs.values()]
        .sort((left, right) => left.botId.localeCompare(right.botId))
        .map((config) => this.publicBot(config)),
      capabilities: {
        createBot: this.configs.size < this.slots.size,
        maxBots: this.slots.size,
      },
    };
  }

  async handleRequest(request, response) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!authorized(request.headers.authorization, this.options.token)) {
      this.writeError(response, 401, "AUTH_REQUIRED", "Studio Manager 需要本机访问令牌。");
      return;
    }
    const url = safeRequestUrl(request.url);
    if (!url) {
      this.writeError(response, 400, "INVALID_REQUEST", "请求地址无效。");
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/v1/incidents") {
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          issues: this.incidents.listIssues(),
        });
        return;
      }
      const incidentMatch = url.pathname.match(/^\/v1\/incidents\/(INC-[0-9]{4})$/u);
      if (request.method === "GET" && incidentMatch) {
        const issue = this.incidents.getIssue(incidentMatch[1]);
        if (!issue) {
          this.writeError(response, 404, "INCIDENT_NOT_FOUND", "未找到该 Incident。");
          return;
        }
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          issue,
          occurrences: this.incidents.listOccurrences(issue.incidentId),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/status") {
        this.writeJson(response, 200, this.status());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/bots") {
        const input = validateCreateBotRequest(await readJson(request));
        const bot = await this.createBot(input);
        this.writeJson(response, 201, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          bot,
        });
        return;
      }
      const action = url.pathname.match(
        /^\/v1\/bots\/(studio-bot-[0-9]{2})\/(start|stop|restart)$/u,
      );
      if (request.method === "POST" && action) {
        const [, botId, operation] = action;
        if (!this.configs.has(botId)) {
          this.writeError(response, 404, "BOT_NOT_FOUND", "未找到该本地 Bot 配置。");
          return;
        }
        if (operation === "stop") {
          await this.stopBot(botId);
          this.writeJson(response, 200, {
            schemaVersion: "1.0",
            generatedAt: new Date().toISOString(),
            bot: this.publicBot(this.configs.get(botId)),
          });
          return;
        }
        if (operation === "restart") await this.stopBot(botId);
        await this.startBot(botId);
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          bot: this.publicBot(this.configs.get(botId)),
        });
        return;
      }
      this.writeError(response, 404, "BOT_NOT_FOUND", "Studio Manager 路由不存在。");
    } catch (cause) {
      const error = managerError(cause);
      this.writeError(response, error.status, error.code, error.message);
    }
  }

  async createBot(input) {
    const duplicate = [...this.configs.values()].find(
      (bot) =>
        bot.username.toLowerCase() === input.username.toLowerCase() &&
        bot.serverHost.toLowerCase() === input.serverHost.toLowerCase() &&
        bot.serverPort === input.serverPort,
    );
    if (duplicate) {
      throw managedError("BOT_CONFLICT", "同一服务器上已经配置了同名 Bot。", 409);
    }
    const slot = [...this.slots.values()].find(
      ({ botId }) => !this.configs.has(botId),
    );
    if (!slot) {
      throw managedError("BOT_LIMIT_REACHED", "本地 Bot 槽位已用完。", 409);
    }
    const now = new Date().toISOString();
    const config = {
      botId: slot.botId,
      username: input.username,
      serverHost: input.serverHost,
      serverPort: input.serverPort,
      minecraftVersion: input.minecraftVersion,
      createdAt: now,
      updatedAt: now,
      processState: "stopped",
      lastError: null,
    };
    const runningPeers = [...this.configs.values()].filter(
      (candidate) =>
        this.sameServer(candidate, config) &&
        this.processes.get(candidate.botId)?.child.exitCode === null,
    );
    this.configs.set(config.botId, config);
    try {
      await this.refreshCombatProfilesForServer(config);
      await this.writeManifest();
      // A running Runtime has already loaded its profile. Restart same-server
      // peers after adding a Bot so their new whitelist is effective now.
      for (const peer of runningPeers) {
        await this.stopBot(peer.botId);
        await this.startBot(peer.botId);
      }
      await this.startBot(config.botId);
    } catch (cause) {
      config.processState = "error";
      config.lastError = boundedError(cause);
      config.updatedAt = new Date().toISOString();
      await this.writeManifest();
      throw managedError("BOT_START_FAILED", "Bot 配置已保存，但 Runtime 启动失败。", 502);
    }
    return this.publicBot(config);
  }

  sameServer(left, right) {
    return (
      left.serverHost.toLowerCase() === right.serverHost.toLowerCase() &&
      left.serverPort === right.serverPort
    );
  }

  async refreshCombatProfilesForServer(config) {
    const matching = [...this.configs.values()].filter((candidate) =>
      this.sameServer(candidate, config),
    );
    await Promise.all(matching.map((candidate) => this.writeProfile(candidate)));
  }

  combatWhitelistFor(config) {
    const usernames = new Map();
    for (const candidate of this.configs.values()) {
      if (
        candidate.botId === config.botId ||
        !this.sameServer(candidate, config)
      ) {
        continue;
      }
      const key = candidate.username.toLowerCase();
      if (!usernames.has(key)) usernames.set(key, candidate.username);
    }
    return [...usernames.values()].sort((left, right) =>
      left.localeCompare(right),
    );
  }

  async startBot(botId) {
    const config = this.configs.get(botId);
    const slot = this.slots.get(botId);
    if (!config || !slot) {
      throw managedError("BOT_NOT_FOUND", "本地 Bot 配置没有可用认证槽位。", 404);
    }
    const running = this.processes.get(botId);
    if (running && running.child.exitCode === null) return;
    await this.writeProfile(config);
    config.processState = "starting";
    config.lastError = null;
    config.updatedAt = new Date().toISOString();
    const profilePath = this.profilePath(botId);
    const entry = path.join(
      this.options.repositoryRoot,
      "apps",
      "bot-runtime",
      "dist",
      "index.js",
    );
    const args = this.options.packagedMode
      ? ["--studio-service", "apps/bot-runtime/dist/index.js"]
      : ["--import", shutdownPreload, entry];
    const child = (this.options.spawn ?? spawn)(process.execPath, args, {
      cwd: this.options.repositoryRoot,
      env: {
        ...this.options.environment,
        BOT_SERVER_PROFILE_PATH: profilePath,
        BOT_RUNTIME_LINK_URL:
          `ws://127.0.0.1:${this.options.runtimeLinkPort}/v1/runtime-link`,
        BOT_RUNTIME_LINK_KEY_ID: slot.keyId,
        BOT_RUNTIME_LINK_SECRET: slot.secret,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const log = createWriteStream(
      path.join(this.logRoot, `bot-${botId}.log`),
      { flags: "a" },
    );
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    this.observeRuntimeOutput(config, child.stdout);
    this.observeRuntimeOutput(config, child.stderr);
    const managed = {
      child,
      log,
      logClosed: false,
      stopping: false,
    };
    this.processes.set(botId, managed);
    config.processState = "running";
    config.updatedAt = new Date().toISOString();
    child.once("error", (cause) => {
      const current = this.processes.get(botId);
      if (current?.child !== child) return;
      config.processState = "error";
      config.lastError = boundedError(cause);
      config.updatedAt = new Date().toISOString();
    });
    child.once("exit", (code, signal) => {
      const current = this.processes.get(botId);
      const isCurrent = current?.child === child;
      if (isCurrent) this.processes.delete(botId);
      closeManagedLog(managed);
      // A forced stop can be followed by a delayed exit event. A newer
      // Runtime must remain authoritative when that old event arrives.
      if (!isCurrent && managed.stopping) return;
      config.updatedAt = new Date().toISOString();
      if (this.stopping || config.processState === "stopping") {
        config.processState = "stopped";
        return;
      }
      config.processState = code === 0 ? "stopped" : "error";
      if (code !== 0) {
        config.lastError = `Bot Runtime 已退出（code=${code ?? "none"}, signal=${signal ?? "none"}）。`;
        // 父进程侧 BOT_CRASH：child 来不及 flush 时也要有证据（十.4）
        this.incidents.report({
          subject: "bot",
          botId,
          failureCode: "BOT_PROCESS_EXITED",
          incidentType: "BOT_CRASH",
          sourceComponent: "studio-local-manager",
          severity: "CRITICAL",
          expected: "bot runtime keeps running or exits 0 after graceful stop",
          actual: `exit code=${code ?? "none"} signal=${signal ?? "none"}`,
          snapshots: { username: config.username, serverHost: config.serverHost, serverPort: config.serverPort },
        });
      }
    });
  }

  async stopBot(botId) {
    const config = this.configs.get(botId);
    const managed = this.processes.get(botId);
    const child = managed?.child;
    if (!config || !managed || child.exitCode !== null) {
      if (managed && this.processes.get(botId) === managed) {
        this.processes.delete(botId);
      }
      if (config) {
        config.processState = "stopped";
        config.updatedAt = new Date().toISOString();
      }
      return;
    }
    managed.stopping = true;
    config.processState = "stopping";
    config.updatedAt = new Date().toISOString();
    await new Promise((resolve) => {
      let settled = false;
      let timer;
      let forceKillTimer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (this.processes.get(botId) === managed) {
          this.processes.delete(botId);
        }
        closeManagedLog(managed);
        resolve();
      };
      const forceKill = () => {
        if (child.exitCode !== null) {
          finish();
          return;
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // The exit event or bounded fallback below still completes cleanup.
        }
        if (!settled) {
          forceKillTimer = setTimeout(
            finish,
            this.options.forceKillWaitMs ?? 2_000,
          );
        }
      };
      timer = setTimeout(() => {
        forceKill();
      }, this.options.stopTimeoutMs ?? 10_000);
      child.once("exit", finish);
      if (child.connected) {
        child.send({ type: "studio.shutdown" }, (error) => {
          if (error && child.exitCode === null) {
            child.kill("SIGTERM");
          }
          disconnectChild(child);
        });
      } else {
        child.kill("SIGTERM");
      }
    });
    if (!this.processes.has(botId) || this.processes.get(botId) === managed) {
      config.processState = "stopped";
      config.updatedAt = new Date().toISOString();
    }
  }

  observeRuntimeOutput(config, stream) {
    let remainder = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const lines = `${remainder}${chunk}`.split(/\r?\n/u);
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try {
          const event = JSON.parse(line);
          if (event?.level === "error") {
            config.lastError = [event.event, event.code]
              .filter((value) => typeof value === "string")
              .join(": ")
              .slice(0, 500) || "Bot Runtime 报告了错误。";
            config.updatedAt = new Date().toISOString();
          }
        } catch {
          // Runtime logs remain useful even when an individual line is not JSON.
        }
      }
    });
  }

  publicBot(config) {
    const process = this.processes.get(config.botId);
    return {
      botId: config.botId,
      username: config.username,
      serverHost: config.serverHost,
      serverPort: config.serverPort,
      minecraftVersion: config.minecraftVersion,
      processState: config.processState,
      pid: process?.child.exitCode === null ? process.child.pid ?? null : null,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
      lastError: config.lastError,
    };
  }

  async refreshAIStatus() {
    const provider = this.aiStatus.provider;
    const baseUrl = this.aiStatus.baseUrl;
    if (!provider || !baseUrl) {
      const discovered = await discoverLocalAI(this.options.environment);
      this.aiStatus = discovered.status;
      return;
    }
    const probe = await probeAIEndpoint({
      provider,
      baseUrl,
      apiKey: this.options.environment.LOCAL_AI_API_KEY?.trim() || undefined,
    }, 2_000);
    if (!probe) {
      const discovered = await discoverLocalAI(this.options.environment);
      this.aiStatus = discovered.config
        ? discovered.status
        : {
            ...this.aiStatus,
            state: "unavailable",
            models: [],
            latencyMs: null,
            lastCheckedAt: new Date().toISOString(),
            message: "Spark 推理服务当前不可达，Studio 会继续检查。",
          };
      return;
    }
    const selection = selectModel(probe.models, this.aiStatus.model ?? "");
  if (selection.error) {
    return { state: "unavailable", message: selection.error, changedAt: new Date().toISOString() };
  }
  const model = selection.model;
    this.aiStatus = {
      ...this.aiStatus,
      state: "connected",
      model,
      models: probe.models,
      latencyMs: probe.latencyMs,
      lastCheckedAt: probe.checkedAt,
      message: "Spark 推理服务在线。",
    };
  }

  async loadManifest() {
    let input;
    try {
      input = JSON.parse(await readFile(this.manifestPath, "utf8"));
    } catch (cause) {
      if (cause?.code === "ENOENT") return;
      throw new Error(`Unable to read local Bot manifest: ${boundedError(cause)}`);
    }
    if (input?.schemaVersion !== "1.0" || !Array.isArray(input.bots)) {
      throw new Error("Local Bot manifest is invalid.");
    }
    for (const value of input.bots) {
      const config = validatePersistedBot(value, this.slots);
      this.configs.set(config.botId, config);
    }
  }

  async writeManifest() {
    const body = {
      schemaVersion: "1.0",
      bots: [...this.configs.values()].map((config) => ({
        botId: config.botId,
        username: config.username,
        serverHost: config.serverHost,
        serverPort: config.serverPort,
        minecraftVersion: config.minecraftVersion,
        createdAt: config.createdAt,
      })),
    };
    await atomicWrite(this.manifestPath, `${JSON.stringify(body, null, 2)}\n`);
  }

  async writeProfile(config) {
    const networkScope = loopbackHost(config.serverHost)
      ? "loopback"
      : "private-lan";
    const profile = {
      schemaVersion: "1.0",
      id: `local-${config.botId}`,
      botId: config.botId,
      // Manager-created profiles are real-server targets. Keeping this
      // separate from isolated-test prevents test-only boundary probing from
      // being enabled by a Dashboard-created Bot.
      purpose: "managed",
      networkScope,
      host: config.serverHost,
      port: config.serverPort,
      minecraftVersion: config.minecraftVersion,
      username: config.username,
      auth: "offline",
      combat: {
        enabled: true,
        stance: "preserve-life",
        whitelist: {
          usernames: this.combatWhitelistFor(config),
          uuids: [],
        },
      },
      statusIntervalMs: 1_000,
      heartbeatIntervalMs: 5_000,
      stopGracePeriodMs: 5_000,
      reconnect: {
        enabled: true,
        maxAttempts: 20,
        baseDelayMs: 2_000,
        maxDelayMs: 30_000,
      },
    };
    await mkdir(path.dirname(this.profilePath(config.botId)), { recursive: true });
    await atomicWrite(
      this.profilePath(config.botId),
      `${JSON.stringify(profile, null, 2)}\n`,
    );
  }

  profilePath(botId) {
    if (!BOT_ID_PATTERN.test(botId)) throw new Error("Bot ID is invalid.");
    return path.join(this.botRoot, botId, "server-profile.json");
  }

  writeJson(response, status, body) {
    response.statusCode = status;
    response.end(JSON.stringify(body));
  }

  writeError(response, status, code, message) {
    this.writeJson(response, status, {
      schemaVersion: "1.0",
      error: { code, message },
    });
  }
}

function closeManagedLog(managed) {
  if (managed.logClosed) return;
  managed.logClosed = true;
  managed.log.end();
}

function disconnectChild(child) {
  if (!child.connected || typeof child.disconnect !== "function") return;
  try {
    child.disconnect();
  } catch {
    // The child may have exited between the connected check and disconnect.
  }
}

async function probeExplicitEndpoint(rawUrl, provider, preferredModel, apiKey, source) {
  const baseUrl = safeOrigin(rawUrl);
  if (!baseUrl) return null;
  const probe = await probeAIEndpoint({ provider, baseUrl, apiKey }, 2_000);
  if (!probe) return null;
  const selection = selectModel(probe.models, preferredModel);
  if (selection.error) {
    return { state: "unavailable", message: selection.error };
  }
  const model = selection.model;
  if (!model) return null;
  return {
    config: { provider, baseUrl, model },
    status: {
      state: "connected",
      source,
      provider,
      baseUrl,
      model,
      models: probe.models,
      latencyMs: probe.latencyMs,
      lastCheckedAt: probe.checkedAt,
      message: "已连接配置的 Local AI 服务。",
    },
  };
}

export async function probeAIEndpoint(candidate, timeoutMs = 1_200) {
  const startedAt = Date.now();
  try {
    const pathname = candidate.provider === "ollama" ? "/api/tags" : "/v1/models";
    const response = await fetch(`${candidate.baseUrl}${pathname}`, {
      headers: {
        Accept: "application/json",
        ...(candidate.apiKey?.trim()
          ? { Authorization: `Bearer ${candidate.apiKey.trim()}` }
          : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const input = await response.json();
    const models = candidate.provider === "ollama"
      ? Array.isArray(input?.models)
        ? input.models.map((entry) => entry?.name)
        : []
      : Array.isArray(input?.data)
        ? input.data.map((entry) => entry?.id)
        : [];
    const validModels = [...new Set(models.filter(
      (model) => typeof model === "string" && MODEL_PATTERN.test(model),
    ))].slice(0, 64);
    if (validModels.length === 0) return null;
    return {
      models: validModels,
      latencyMs: Math.max(0, Date.now() - startedAt),
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function boundedDiscoveryWait(raw, fallback, name) {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 120_000) {
    throw new Error(`${name} must be between 0 and 120000.`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function discoveryHosts(raw) {
  const values = raw?.trim()
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : DEFAULT_SPARK_HOSTS;
  return [...new Set(values)].filter(approvedDiscoveryHost).slice(0, 16);
}

function discoveryPorts(raw) {
  const values = raw?.trim()
    ? raw.split(",").map((value) => Number(value.trim()))
    : DEFAULT_SPARK_PORTS;
  return [...new Set(values)]
    .filter((port) => Number.isSafeInteger(port) && port >= 1 && port <= 65_535)
    .slice(0, 16);
}

function approvedDiscoveryHost(host) {
  return (
    loopbackHost(host) ||
    privateHost(host) ||
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}\.)*local$/iu.test(host)
  );
}

function validateCreateBotRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw managedError("INVALID_REQUEST", "Bot 创建请求必须是对象。", 400);
  }
  const keys = Object.keys(input).sort().join(",");
  if (keys !== "minecraftVersion,schemaVersion,serverHost,serverPort,username") {
    throw managedError("INVALID_REQUEST", "Bot 创建请求包含未知或缺失字段。", 400);
  }
  const serverHost = String(input.serverHost ?? "").trim();
  const minecraftVersion = String(input.minecraftVersion ?? "").trim();
  if (
    input.schemaVersion !== "1.0" ||
    typeof input.username !== "string" ||
    !USERNAME_PATTERN.test(input.username) ||
    (!loopbackHost(serverHost) && !privateHost(serverHost) && serverHost !== "host.docker.internal") ||
    !Number.isSafeInteger(input.serverPort) ||
    input.serverPort < 1 ||
    input.serverPort > 65_535 ||
    (minecraftVersion !== "auto" && !/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u.test(minecraftVersion))
  ) {
    throw managedError(
      "INVALID_REQUEST",
      "Bot 字段无效；服务器必须是本机或私有局域网地址。",
      400,
    );
  }
  return {
    username: input.username,
    serverHost,
    serverPort: input.serverPort,
    minecraftVersion,
  };
}

function validatePersistedBot(input, slots) {
  const createdAt = typeof input?.createdAt === "string" && Number.isFinite(Date.parse(input.createdAt))
    ? new Date(input.createdAt).toISOString()
    : null;
  const normalized = validateCreateBotRequest({
    schemaVersion: "1.0",
    username: input?.username,
    serverHost: input?.serverHost,
    serverPort: input?.serverPort,
    minecraftVersion: input?.minecraftVersion,
  });
  if (!createdAt || typeof input?.botId !== "string" || !slots.has(input.botId)) {
    throw new Error("Persisted local Bot entry is invalid.");
  }
  return {
    botId: input.botId,
    ...normalized,
    createdAt,
    updatedAt: new Date().toISOString(),
    processState: "stopped",
    lastError: null,
  };
}

async function readJson(request) {
  const declared = request.headers["content-length"];
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
    throw managedError("INVALID_REQUEST", "请求正文过大。", 413);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw managedError("INVALID_REQUEST", "请求正文过大。", 413);
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw managedError("INVALID_REQUEST", "请求正文不是有效 JSON。", 400);
  }
}

async function atomicWrite(destination, content) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function normalizedProvider(value) {
  return value?.trim().toLowerCase() === "ollama" ? "ollama" : "vllm";
}

/**
 * 模型选择（fail closed，禁止 fallback models[0]）：
 *  - preferred 明确配置且存在 → 使用之
 *  - preferred 配置但不存在 → MODEL_NOT_AVAILABLE（fail closed）
 *  - 未配置且恰好一个模型 → 自动使用当前模型
 *  - 未配置且多个模型 → MODEL_SELECTION_REQUIRED（要求用户选择）
 *  - 未配置且零个 → MODEL_NOT_AVAILABLE
 * 返回 { model } 或 { error: "MODEL_NOT_AVAILABLE" | "MODEL_SELECTION_REQUIRED", models }。
 */
function selectModel(models, preferred) {
  if (preferred) {
    if (models.includes(preferred)) return { model: preferred };
    return { error: "MODEL_NOT_AVAILABLE", models };
  }
  if (models.length === 1) return { model: models[0] };
  if (models.length === 0) return { error: "MODEL_NOT_AVAILABLE", models };
  return { error: "MODEL_SELECTION_REQUIRED", models };
}

function safeOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) return null;
    if (
      !url.hostname ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function unavailableAiStatus(source, provider, baseUrl, model, checkedAt, message) {
  return {
    state: "unavailable",
    source,
    provider,
    baseUrl,
    model,
    models: [],
    latencyMs: null,
    lastCheckedAt: checkedAt,
    message,
  };
}

function loopbackHost(host) {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function privateHost(host) {
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
    );
  }
  if (version === 6) {
    const normalized = host.toLowerCase();
    return normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized);
  }
  return false;
}

function urlHost(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function authorized(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function safeRequestUrl(value) {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value, "http://studio-manager.local");
    return url.search === "" && url.hash === "" ? url : null;
  } catch {
    return null;
  }
}

function managedError(code, message, status) {
  const error = new Error(message);
  error.managerCode = code;
  error.httpStatus = status;
  return error;
}

function managerError(cause) {
  if (
    cause instanceof Error &&
    typeof cause.managerCode === "string" &&
    Number.isSafeInteger(cause.httpStatus)
  ) {
    return {
      code: cause.managerCode,
      message: cause.message,
      status: cause.httpStatus,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "Studio Manager 处理请求时发生错误。",
    status: 500,
  };
}

function boundedError(cause) {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
}
