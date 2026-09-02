import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { IncidentStore, occurrenceToMarkdown, buildRepairPrompt, safeExportText, redactSecrets } from "../packages/skills/dist/incidents.js";
import { GameplayPolicyError, resolveGameplayPolicy } from "../packages/protocol/dist/gameplay-policy.js";
import {
  evaluateAdaptation,
  evaluateFeatureGates,
  newBehaviorProfile,
  resolveCompatibilityMode,
} from "../packages/skills/dist/compat/index.js";
import { buildZip } from "./zip-writer.mjs";
import {
  observeLocalTestServer,
  startLocalTestServer,
  stopLocalTestServer,
  resetLocalTestWorld,
  readLocalTestServerLog,
  LOCAL_TEST_VOLUME,
} from "./local-test-server.mjs";
import { execFileSync } from "node:child_process";

function readGitMetadata() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" }).trim();
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" }).trim();
    return { commit, branch };
  } catch {
    return { commit: null, branch: null };
  }
}
const GIT_METADATA = readGitMetadata();
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
      status: {
        state: "unavailable",
        source: "explicit",
        provider: result.candidate.provider,
        baseUrl: result.candidate.baseUrl,
        model: null,
        models: selection.models ?? [],
        latencyMs: result.probe.latencyMs ?? null,
        lastCheckedAt: new Date().toISOString(),
        message: selection.error,
      },
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
    // 本 manager 进程的 ownership 身份（local test server labels / incident 元数据）
    this.sessionId = process.env.STUDIO_SESSION_ID?.trim() || `studio-manager-${Date.now().toString(36)}`;
    this.localTestDesired = process.env.STUDIO_STARTUP_LOCAL_TEST_DESIRED === "session" ? "on" : "off";
    this.localTestShutdownPolicy = process.env.STUDIO_LOCAL_TEST_SHUTDOWN_POLICY?.trim() === "stop" ? "stop" : "keep";
    // lifecycle operation registry：start/stop/restart/reset 返回 operationId，
    // 前端轮询最终 observed result（不做乐观成功）
    this.operations = new Map();
    // reporterEventId → 已记录结果（spool 重放幂等去重；有界 LRU）
    this.incidentEventCache = new Map();
  }

  async start() {
    await Promise.all([
      mkdir(this.botRoot, { recursive: true }),
      mkdir(this.logRoot, { recursive: true }),
    ]);
    await this.loadManifest();
    // Round 8: gameplay profile fails closed — an invalid value refuses to start.
    try {
      resolveGameplayPolicy({ environment: this.options.environment });
    } catch (cause) {
      if (cause instanceof GameplayPolicyError) throw cause;
      throw new GameplayPolicyError(String(cause?.message ?? cause));
    }
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
    // IncidentStore graceful shutdown：有 deadline 的 flush（超时记录未写盘事实）
    if (this.incidents) {
      const flushDeadline = 3_000;
      let flushTimeoutTimer = null;
      try {
        await Promise.race([
          this.incidents.flush(),
          new Promise((resolve) => { flushTimeoutTimer = setTimeout(resolve, flushDeadline); }),
        ]);
        // race 输家 timer 若不清理会拖住事件循环整个 flushDeadline（进程退出晚 3s）
        if (flushTimeoutTimer !== null) clearTimeout(flushTimeoutTimer);
        const health = this.incidents.writerHealth();
        if (health.dirty) {
          console.warn(JSON.stringify({
            timestamp: new Date().toISOString(), level: "warn", service: "studio-local-manager",
            event: "incident_flush_deadline_exceeded", dirty: health.dirty,
            droppedWriteCount: health.droppedWriteCount,
          }));
        }
      } catch {
        // flush 失败不阻塞关闭（store 内部已计数）
      }
    }
    // 本 manager 拥有的 local test server：按 shutdownPolicy 处理（keep=保留供手工调试）
    if (this.localTestShutdownPolicy === "stop") {
      const result = await stopLocalTestServer({ sessionId: this.sessionId }).catch(() => null);
      if (result?.status === "refused") {
        console.warn(JSON.stringify({
          timestamp: new Date().toISOString(), level: "warn", service: "studio-local-manager",
          event: "local_test_stop_refused", detail: result.error,
        }));
      }
    }
  }

  status() {
    return {
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      ai: { ...structuredClone(this.aiStatus), concurrency: this.buildAiConcurrencyInfo() },
      gameplayPolicy: this.gameplayPolicyInfo(),
      compatibility: this.compatibilityStatus(),
      bots: [...this.configs.values()]
        .sort((left, right) => left.botId.localeCompare(right.botId))
        .map((config) => this.publicBot(config)),
      sessionId: this.sessionId,
      capabilities: {
        createBot: this.configs.size < this.slots.size,
        maxBots: this.slots.size,
        // capability honesty：前端按这里声明渲染，不自行猜测
        incidentExport: { json: true, markdown: true, zipBundle: true, repairPrompt: true },
        localTestServer: { start: true, stop: true, restart: true, resetWorld: true, logs: true },
        incidentQuery: { filters: true, issueOccurrences: true, occurrenceDetail: true, statusTransition: true },
      },
      incidents: this.incidents ? this.incidents.writerHealth() : null,
    };
  }

  async readRequestBody(request) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      if (bytes > 256 * 1024) throw new Error("body too large");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
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
      // -----------------------------------------------------------------
      // Incidents：查询 API（Issue 聚合 + Occurrence drill-down）
      // -----------------------------------------------------------------
      if (request.method === "GET" && url.pathname === "/v1/incidents/health") {
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          writer: this.incidents.writerHealth(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/incidents/export") {
        await this.handleIncidentExport(request, response, url);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/incidents") {
        await this.handleIncidentList(request, response, url);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/incidents") {
        await this.handleIncidentReport(request, response);
        return;
      }
      const exportMatch = url.pathname.match(/^\/v1\/incidents\/(INC-[0-9]{4,})\/export$/u);
      if (request.method === "GET" && exportMatch) {
        await this.handleIncidentExport(request, response, url, exportMatch[1]);
        return;
      }
      const occurrenceMatch = url.pathname.match(/^\/v1\/incidents\/(INC-[0-9]{4,})\/occurrences\/(OCC-[0-9]{4,})$/u);
      if (request.method === "GET" && occurrenceMatch) {
        const occurrence = this.incidents.getOccurrence(occurrenceMatch[1], occurrenceMatch[2]);
        if (!occurrence) {
          this.writeError(response, 404, "OCCURRENCE_NOT_FOUND", "未找到该 Occurrence。");
          return;
        }
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          occurrence: structuredClone(occurrence),
        });
        return;
      }
      const statusMatch = url.pathname.match(/^\/v1\/incidents\/(INC-[0-9]{4,})\/status$/u);
      if (request.method === "POST" && statusMatch) {
        const body = await readJson(request);
        const to = typeof body?.status === "string" ? body.status : null;
        const allowed = ["open", "investigating", "known_issue", "fixed", "ignored"];
        if (!allowed.includes(to)) {
          this.writeError(response, 400, "INVALID_STATUS", `status 必须是 ${allowed.join("/")}`);
          return;
        }
        const result = this.incidents.transitionStatus(statusMatch[1], to, {
          fixedByCommit: typeof body?.fixedByCommit === "string" ? body.fixedByCommit.slice(0, 40) : undefined,
          actor: typeof body?.actor === "string" ? body.actor.slice(0, 60) : "dashboard-operator",
        });
        if (!result.ok) {
          this.writeError(response, 409, "STATUS_TRANSITION_REJECTED", result.reason ?? "非法状态迁移。");
          return;
        }
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          issue: structuredClone(this.incidents.getIssue(statusMatch[1])),
        });
        return;
      }
      const verificationMatch = url.pathname.match(/^\/v1\/incidents\/(INC-[0-9]{4,})\/verification$/u);
      if (request.method === "POST" && verificationMatch) {
        const body = await readJson(request);
        let ok = false;
        if (body?.action === "request") ok = this.incidents.requestVerification(verificationMatch[1]);
        else if (body?.action === "record" && (body?.result === "passed" || body?.result === "failed")) {
          ok = this.incidents.recordVerificationResult(verificationMatch[1], body.result);
        } else {
          this.writeError(response, 400, "INVALID_REQUEST", "action 必须是 request 或 record(result=passed|failed)。");
          return;
        }
        if (!ok) {
          this.writeError(response, 409, "VERIFICATION_REJECTED", "验证请求被拒绝（Issue 不存在或状态不允许）。");
          return;
        }
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          issue: structuredClone(this.incidents.getIssue(verificationMatch[1])),
        });
        return;
      }
      const incidentMatch = url.pathname.match(/^\/v1\/incidents\/(INC-[0-9]{4,})$/u);
      if (request.method === "GET" && incidentMatch) {
        const issue = this.incidents.getIssue(incidentMatch[1]);
        if (!issue) {
          this.writeError(response, 404, "INCIDENT_NOT_FOUND", "未找到该 Incident。");
          return;
        }
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          issue: structuredClone(issue),
          occurrences: structuredClone(this.incidents.listOccurrences(issue.incidentId)),
        });
        return;
      }
      // -----------------------------------------------------------------
      // Local Test Server lifecycle（ownership 守卫 + operationId 异步语义）
      // -----------------------------------------------------------------
      if (request.method === "GET" && url.pathname === "/v1/servers/local-test") {
        const observed = await observeLocalTestServer();
        observed.desiredState = this.localTestDesired === "on" || this.localTestRunningOps() ? "on" : "off";
        observed.shutdownPolicy = this.localTestShutdownPolicy;
        observed.ownerManagerSessionId = this.sessionId;
        observed.capabilities = { start: true, stop: true, restart: true, resetWorld: true, logs: true };
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          resource: observed,
        });
        return;
      }
      const localTestAction = url.pathname.match(/^\/v1\/servers\/local-test\/(start|stop|restart|reset)$/u);
      if (request.method === "POST" && localTestAction) {
        await this.handleLocalTestAction(request, response, localTestAction[1]);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/servers/local-test/logs") {
        const q = url.searchParams;
        const tail = Math.min(500, Math.max(1, Number.parseInt(q.get("tail") ?? "200", 10) || 200));
        const result = await readLocalTestServerLog(tail);
        if (!result.available) {
          this.writeError(response, 404, "LOCAL_TEST_LOGS_UNAVAILABLE", result.reason);
          return;
        }
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          tail: result.tail,
          logs: redactServerLogText(result.logs),
        });
        return;
      }
      const operationMatch = url.pathname.match(/^\/v1\/operations\/(op-[0-9a-z-]+)$/u);
      if (request.method === "GET" && operationMatch) {
        const operation = this.operations.get(operationMatch[1]);
        if (!operation || Date.now() - operation.createdAt > 10 * 60_000) {
          this.operations.delete(operationMatch[1]);
          this.writeError(response, 404, "OPERATION_NOT_FOUND", "未找到该操作（或已过期）。");
          return;
        }
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          operation: { ...operation },
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
        if (operation === "restart") await this.stopBot(botId, { purpose: "restart", requestedBy: "studio-api" });
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

  // -------------------------------------------------------------------
  // Incident query/report/export handlers
  // -------------------------------------------------------------------

  async handleIncidentList(request, response, url) {
    void request;
    const q = url.searchParams;
    const limit = Math.min(200, Math.max(1, Number.parseInt(q.get("limit") ?? "50", 10) || 50));
    const offset = Math.max(0, Number.parseInt(q.get("offset") ?? "0", 10) || 0);
    const filters = {};
    for (const key of ["status", "severity", "suspectedLayer", "failureCode", "botId", "serverProfileId", "skillId", "incidentType", "fingerprint", "minecraftVersion"]) {
      const value = q.get(key);
      if (value !== null && value.length > 0) filters[key] = value.slice(0, 200);
    }
    const from = q.get("from");
    const to = q.get("to");
    const since = q.get("since");
    for (const [name, value] of [["from", from], ["to", to], ["since", since]]) {
      if (value === null) continue;
      if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/u.test(value)) {
        this.writeError(response, 400, "INVALID_TIME_FILTER", `${name} 必须是 ISO 时间（YYYY-MM-DD 或完整 ISO）。`);
        return;
      }
    }
    // 超大时间范围上限（from-to ≤ 366 天）
    if (from && to) {
      const span = Date.parse(to.endsWith("Z") ? to : `${to}T23:59:59Z`) - Date.parse(from);
      if (span > 366 * 86_400_000) {
        this.writeError(response, 400, "TIME_RANGE_TOO_LARGE", "时间范围不能超过 366 天。");
        return;
      }
    }
    const filtered = this.incidents.listIssues().filter((issue) => {
      if (filters.status && issue.status !== filters.status) return false;
      if (filters.severity && issue.maxSeverity !== filters.severity) return false;
      if (filters.suspectedLayer && issue.suspectedLayer !== filters.suspectedLayer) return false;
      if (filters.failureCode && issue.primaryFailureCode !== filters.failureCode) return false;
      if (filters.incidentType && issue.type !== filters.incidentType) return false;
      if (filters.fingerprint && issue.fingerprint !== filters.fingerprint) return false;
      if (filters.botId && !issue.affectedBotIds.includes(filters.botId)) return false;
      if (filters.serverProfileId && !issue.affectedServerProfileIds.includes(filters.serverProfileId)) return false;
      if (since && issue.lastSeenAt < since) return false;
      if (from && issue.lastSeenAt < from) return false;
      if (to && issue.lastSeenAt > `${to}T23:59:59.999Z`.replace(" T", "T") && issue.lastSeenAt.slice(0, 10) > to) return false;
      return true;
    });
    // skillId filter 需要看 occurrences（issue 行不存 skillId 列表）
    if (filters.skillId) {
      const matchingIds = new Set();
      for (const issue of filtered) {
        if (this.incidents.listOccurrences(issue.incidentId).some((occurrence) => occurrence.skillId === filters.skillId)) {
          matchingIds.add(issue.incidentId);
        }
      }
      for (const issue of filtered) {
        if (!matchingIds.has(issue.incidentId)) filtered.splice(filtered.indexOf(issue), 1);
      }
    }
    const page = filtered.slice(offset, offset + limit);
    this.writeJson(response, 200, {
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      total: filtered.length,
      limit,
      offset,
      nextOffset: offset + page.length < filtered.length ? offset + page.length : null,
      filters,
      issues: structuredClone(page),
    });
  }

  async handleIncidentReport(request, response) {
    // Bot runtime 上报入口；token 已在上面统一校验
    let body;
    try {
      body = JSON.parse(await this.readRequestBody(request));
    } catch {
      this.writeError(response, 400, "INVALID_REQUEST", "请求正文不是有效 JSON。");
      return;
    }
    // 幂等：reporterEventId 去重（spool 重放不产生重复 occurrence）
    const eventId = typeof body?.reporterEventId === "string" ? body.reporterEventId.slice(0, 64) : null;
    if (eventId) {
      const cached = this.incidentEventCache.get(eventId);
      if (cached) {
        this.writeJson(response, 200, {
          schemaVersion: "1.0",
          generatedAt: new Date().toISOString(),
          replayed: true,
          ...cached,
        });
        return;
      }
    }
    try {
      const result = this.incidents.report({
        subject: body.subject === "process_group" || body.subject === "server" || body.subject === "service" ? body.subject : "bot",
        botId: typeof body.botId === "string" ? body.botId : null,
        sessionId: typeof body.sessionId === "string" ? body.sessionId.slice(0, 120) : null,
        runtimeInstanceId: typeof body.runtimeInstanceId === "string" ? body.runtimeInstanceId.slice(0, 120) : null,
        correlationId: typeof body.correlationId === "string" ? body.correlationId.slice(0, 120) : null,
        goalId: typeof body.goalId === "string" ? body.goalId.slice(0, 120) : null,
        taskId: typeof body.taskId === "string" ? body.taskId.slice(0, 120) : null,
        serverProfileId: typeof body.serverProfileId === "string" ? body.serverProfileId.slice(0, 120) : null,
        minecraftVersion: typeof body.minecraftVersion === "string" ? body.minecraftVersion.slice(0, 40) : null,
        protocolVersion: typeof body.protocolVersion === "number" ? body.protocolVersion : null,
        gitCommit: typeof body.gitCommit === "string" ? body.gitCommit.slice(0, 40) : null,
        branch: typeof body.branch === "string" ? body.branch.slice(0, 120) : null,
        buildVersion: typeof body.buildVersion === "string" ? body.buildVersion.slice(0, 40) : null,
        dirtyBuild: typeof body.dirtyBuild === "boolean" ? body.dirtyBuild : null,
        goal: typeof body.goal === "string" ? body.goal.slice(0, 300) : null,
        skillId: typeof body.skillId === "string" ? body.skillId.slice(0, 120) : null,
        skillStep: typeof body.skillStep === "string" ? body.skillStep.slice(0, 120) : null,
        phase: typeof body.phase === "string" ? body.phase.slice(0, 120) : null,
        position: body.position && Number.isFinite(body.position.x) ? body.position : null,
        dimension: typeof body.dimension === "string" ? body.dimension.slice(0, 120) : null,
        failureCode: typeof body.failureCode === "string" ? body.failureCode : "UNKNOWN_FAILURE",
        terminalFailureCode: typeof body.terminalFailureCode === "string" ? body.terminalFailureCode : null,
        causedByFailureCodes: Array.isArray(body.causedByFailureCodes)
          ? body.causedByFailureCodes.filter((code) => typeof code === "string").slice(0, 8)
          : undefined,
        incidentType: typeof body.incidentType === "string" ? body.incidentType : "UNKNOWN_FAILURE",
        sourceComponent: typeof body.sourceComponent === "string" ? body.sourceComponent.slice(0, 120) : "bot-runtime",
        severity: body.severity === "INFO" || body.severity === "WARNING" || body.severity === "CRITICAL" ? body.severity : "ERROR",
        expected: typeof body.expected === "string" ? body.expected.slice(0, 600) : null,
        actual: typeof body.actual === "string" ? body.actual.slice(0, 600) : null,
        eventWindow: Array.isArray(body.eventWindow) ? body.eventWindow.slice(-60) : [],
        snapshots: body.snapshots && typeof body.snapshots === "object" ? body.snapshots : {},
        normalizedErrorSignature: typeof body.normalizedErrorSignature === "string" ? body.normalizedErrorSignature.slice(0, 200) : undefined,
        actionFamily: typeof body.actionFamily === "string" ? body.actionFamily.slice(0, 120) : undefined,
      });
      const payload = {
        incidentId: result.issue.incidentId,
        occurrenceId: result.occurrence.occurrenceId,
        createdIssue: result.createdIssue,
        occurrenceCount: result.issue.occurrenceCount,
      };
      if (eventId) {
        this.incidentEventCache.set(eventId, payload);
        if (this.incidentEventCache.size > 512) {
          const oldest = this.incidentEventCache.keys().next().value;
          this.incidentEventCache.delete(oldest);
        }
      }
      this.writeJson(response, 201, {
        schemaVersion: "1.0",
        generatedAt: new Date().toISOString(),
        ...payload,
      });
    } catch (error) {
      this.writeError(response, 400, "INVALID_REQUEST", error instanceof Error ? error.message.slice(0, 200) : "invalid incident");
    }
  }

  /**
   * 导出（服务端生成 + redaction + secret scan fail-closed + 正确 headers）。
   * 单 Incident：format=json|markdown|zip|repair-prompt
   * 批量：scope=open|last24h|bot:<botId>|skill:<skillId>|selected:<INC-...,INC-...>
   */
  async handleIncidentExport(request, response, url, singleIncidentId = null) {
    void request;
    const format = url.searchParams.get("format") ?? "json";
    const scope = url.searchParams.get("scope");
    const MAX_EXPORT_ISSUES = 200;
    let issues;
    if (singleIncidentId) {
      const issue = this.incidents.getIssue(singleIncidentId);
      if (!issue) {
        this.writeError(response, 404, "INCIDENT_NOT_FOUND", "未找到该 Incident。");
        return;
      }
      issues = [issue];
    } else if (!scope) {
      this.writeError(response, 400, "INVALID_REQUEST", "缺少 scope（open|last24h|bot:<id>|skill:<id>|selected:<INC-...>）。");
      return;
    } else if (scope === "open") {
      issues = this.incidents.listIssues().filter((issue) => issue.status === "open" || issue.status === "investigating");
    } else if (scope === "last24h") {
      const cutoff = new Date(Date.now() - 86_400_000).toISOString();
      issues = this.incidents.listIssues().filter((issue) => issue.lastSeenAt >= cutoff);
    } else if (scope.startsWith("bot:")) {
      const botId = scope.slice(4);
      issues = this.incidents.listIssues().filter((issue) => issue.affectedBotIds.includes(botId));
    } else if (scope.startsWith("skill:")) {
      const skillId = scope.slice(6);
      issues = this.incidents.listIssues().filter((issue) =>
        this.incidents.listOccurrences(issue.incidentId).some((occurrence) => occurrence.skillId === skillId));
    } else if (scope.startsWith("selected:")) {
      const ids = scope.slice(9).split(",").map((id) => id.trim()).filter((id) => /^INC-[0-9]{4,}$/u.test(id)).slice(0, MAX_EXPORT_ISSUES);
      issues = ids.map((id) => this.incidents.getIssue(id)).filter(Boolean);
    } else {
      this.writeError(response, 400, "INVALID_SCOPE", "不支持的导出范围。");
      return;
    }
    issues = issues.slice(0, MAX_EXPORT_ISSUES);
    if (issues.length === 0) {
      this.writeError(response, 404, "NOTHING_TO_EXPORT", "范围内没有可导出的 Issue。");
      return;
    }

    if (format === "zip") {
      // 单 Incident bundle（多 issue 时打包为 issues-<n>.zip 同结构）
      const files = [];
      const manifestEntries = [];
      for (const issue of issues) {
        const occurrences = this.incidents.listOccurrences(issue.incidentId);
        const occurrence = occurrences[occurrences.length - 1] ?? null;
        const incidentJson = JSON.stringify({ issue: redactSecrets(structuredClone(issue)), occurrences: redactSecrets(structuredClone(occurrences)) }, null, 2);
        if (!safeExportText(incidentJson)) {
          this.writeError(response, 500, "EXPORT_SECRET_SCAN_FAILED", `导出 ${issue.incidentId} 的 JSON 未通过 secret 扫描（fail closed）。`);
          return;
        }
        files.push({ name: `${issue.incidentId}.incident.json`, content: incidentJson });
        if (occurrence) {
          const { markdown } = occurrenceToMarkdown(issue, occurrence);
          const safeMarkdown = safeExportText(markdown);
          if (!safeMarkdown) {
            this.writeError(response, 500, "EXPORT_SECRET_SCAN_FAILED", `导出 ${issue.incidentId} 的 Markdown 未通过 secret 扫描（fail closed）。`);
            return;
          }
          files.push({ name: `${issue.incidentId}.summary.md`, content: safeMarkdown });
          const { prompt, promptVersion } = buildRepairPrompt(issue, occurrence, {
            repository: "rennaikankk-cmyk/minecraft-multi-agent-studio",
            bundleFiles: ["incident.json", "summary.md", "repair-prompt.txt", "events.jsonl", "manifest.json"],
          });
          const safePrompt = safeExportText(prompt);
          if (!safePrompt) {
            this.writeError(response, 500, "EXPORT_SECRET_SCAN_FAILED", `导出 ${issue.incidentId} 的 repair prompt 未通过 secret 扫描（fail closed）。`);
            return;
          }
          files.push({ name: `${issue.incidentId}.repair-prompt.txt`, content: `${safePrompt}\n(promptVersion=${promptVersion})\n` });
          if (occurrence.eventWindow.length > 0) {
            const eventsJsonl = occurrence.eventWindow.map((entry) => JSON.stringify(redactSecrets(entry))).join("\n");
            if (!safeExportText(eventsJsonl)) {
              this.writeError(response, 500, "EXPORT_SECRET_SCAN_FAILED", `导出 ${issue.incidentId} 的事件窗口未通过 secret 扫描（fail closed）。`);
              return;
            }
            files.push({ name: `${issue.incidentId}.events.jsonl`, content: `${eventsJsonl}\n` });
          }
          manifestEntries.push({
            incidentId: issue.incidentId,
            occurrenceId: occurrence.occurrenceId,
            fingerprint: issue.fingerprint,
            evidenceStripped: occurrence.evidenceStripped,
            eventWindowEvents: occurrence.eventWindow.length,
          });
        } else {
          manifestEntries.push({ incidentId: issue.incidentId, occurrenceId: null, note: "no retained occurrences (retention)" });
        }
      }
      const exportManifest = JSON.stringify({
        exportSchemaVersion: "1.0",
        repairPromptVersion: "repair-v1",
        generatedAt: new Date().toISOString(),
        scope: singleIncidentId ? `incident:${singleIncidentId}` : scope,
        issueCount: issues.length,
        issues: manifestEntries,
        sourceGitCommit: GIT_METADATA.commit,
        redactionVersion: "redact-v1",
        unavailable: [
          { file: "bot.log", reason: "per-bot logs not included in bundle export (bounded tail available via bot log files)" },
          { file: "screenshot.png", reason: "screenshot capability not implemented" },
        ],
        secretScan: "pass",
      }, null, 2);
      if (!safeExportText(exportManifest)) {
        this.writeError(response, 500, "EXPORT_SECRET_SCAN_FAILED", "manifest 未通过 secret 扫描（fail closed）。");
        return;
      }
      files.push({ name: "manifest.json", content: exportManifest });
      let zip;
      try {
        zip = buildZip(files);
      } catch (error) {
        this.writeError(response, 500, "EXPORT_ZIP_FAILED", error instanceof Error ? error.message : "zip build failed");
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/zip");
      response.setHeader("Content-Disposition", `attachment; filename="${singleIncidentId ? `incident-${singleIncidentId}` : `studio-incidents-${issues.length}`}.zip"`);
      response.end(zip);
      return;
    }

    // json / markdown / repair-prompt（文本导出）
    let text;
    let contentType = "application/json; charset=utf-8";
    let filename;
    if (format === "json") {
      text = JSON.stringify({
        exportSchemaVersion: "1.0",
        generatedAt: new Date().toISOString(),
        scope: singleIncidentId ? `incident:${singleIncidentId}` : scope,
        redactionVersion: "redact-v1",
        issues: issues.map((issue) => ({
          issue: redactSecrets(structuredClone(issue)),
          occurrences: redactSecrets(structuredClone(this.incidents.listOccurrences(issue.incidentId))),
        })),
      }, null, 2);
      filename = `incidents-${singleIncidentId ?? scope.replace(/[^a-z0-9-]/giu, "-")}.json`;
    } else if (format === "markdown") {
      const parts = [];
      for (const issue of issues) {
        const occurrences = this.incidents.listOccurrences(issue.incidentId);
        const occurrence = occurrences[occurrences.length - 1];
        if (occurrence) parts.push(occurrenceToMarkdown(issue, occurrence).markdown);
        else parts.push(`# ${issue.incidentId} — ${issue.type}\n\n(no retained occurrences)\n`);
      }
      text = parts.join("\n\n---\n\n");
      contentType = "text/markdown; charset=utf-8";
      filename = `incidents-${singleIncidentId ?? scope.replace(/[^a-z0-9-]/giu, "-")}.md`;
    } else if (format === "repair-prompt") {
      const parts = [];
      for (const issue of issues) {
        const occurrences = this.incidents.listOccurrences(issue.incidentId);
        const occurrence = occurrences[occurrences.length - 1];
        if (occurrence) parts.push(buildRepairPrompt(issue, occurrence, { repository: "rennaikankk-cmyk/minecraft-multi-agent-studio" }).prompt);
      }
      text = parts.join("\n\n====\n\n");
      contentType = "text/plain; charset=utf-8";
      filename = `repair-prompts-${singleIncidentId ?? scope.replace(/[^a-z0-9-]/giu, "-")}.txt`;
    } else {
      this.writeError(response, 400, "INVALID_FORMAT", "format 必须是 json|markdown|zip|repair-prompt。");
      return;
    }
    // 最终 secret scan：fail closed（宁可拒绝导出也不泄漏）
    const safe = safeExportText(text);
    if (safe === null) {
      this.writeError(response, 500, "EXPORT_SECRET_SCAN_FAILED", "导出内容未通过最终 secret 扫描，已拒绝（fail closed）。");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    response.end(safe);
  }

  // -------------------------------------------------------------------
  // Local Test Server lifecycle operations（operationId 异步语义）
  // -------------------------------------------------------------------

  localTestRunningOps() {
    for (const operation of this.operations.values()) {
      if (operation.kind === "local-test" && operation.status === "running") return true;
    }
    return false;
  }

  async handleLocalTestAction(request, response, action) {
    const body = await readJson(request).catch(() => ({}));
    const operationId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const operation = {
      operationId,
      kind: "local-test",
      action,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
    };
    this.operations.set(operationId, operation);
    // Reset World 二次确认：必须携带精确 world identity（卷名）
    if (action === "reset") {
      const confirm = typeof body?.confirmWorldIdentity === "string" ? body.confirmWorldIdentity : null;
      if (confirm !== LOCAL_TEST_VOLUME) {
        operation.status = "failed";
        operation.error = "RESET_CONFIRMATION_REQUIRED";
        this.writeError(response, 400, "RESET_CONFIRMATION_REQUIRED",
          `Reset World 需要二次确认：confirmWorldIdentity 必须精确等于 "${LOCAL_TEST_VOLUME}"。`);
        return;
      }
    }
    this.writeJson(response, 202, {
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      operationId,
      status: "running",
      note: "轮询 GET /v1/operations/<operationId> 获取最终 observed result。",
    });
    // 后台执行（不阻塞 HTTP；operation 状态由后台更新）
    void (async () => {
      try {
        let result;
        if (action === "start" || action === "restart") {
          if (action === "restart") {
            await stopLocalTestServer({ sessionId: this.sessionId });
          }
          result = await startLocalTestServer({ sessionId: this.sessionId, reason: `ui:${action}` });
        } else if (action === "stop") {
          result = await stopLocalTestServer({ sessionId: this.sessionId });
        } else {
          result = await resetLocalTestWorld({ sessionId: this.sessionId });
        }
        operation.status = result?.status === "refused" ? "failed" : "succeeded";
        operation.result = result;
        if (result?.status === "refused") operation.error = result.error;
        operation.updatedAt = new Date().toISOString();
        if (action === "start" || action === "restart") this.localTestDesired = result?.status === "ready" ? "on" : "off";
      } catch (cause) {
        operation.status = "failed";
        operation.error = cause instanceof Error ? cause.message.slice(0, 300) : String(cause);
        operation.updatedAt = new Date().toISOString();
      }
    })();
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
      ...(input.purpose === "anarchy" ? { purpose: "anarchy" } : {}),
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
        // Bot runtime 的非阻塞 Incident 上报入口（stuck/oscillation 等）
        STUDIO_INCIDENT_ENDPOINT: `http://127.0.0.1:${this.options.port}/v1/incidents`,
        STUDIO_INCIDENT_TOKEN: this.options.token,
        // crash-safe spool：manager 不可达时的有界本地缓冲（重放幂等）
        STUDIO_INCIDENT_SPOOL_PATH: path.join(this.runtimeRoot, "incident-spool", `${botId}.jsonl`),
        ...(GIT_METADATA.commit ? { STUDIO_RUNTIME_COMMIT: GIT_METADATA.commit } : {}),
        ...(GIT_METADATA.branch ? { STUDIO_RUNTIME_BRANCH: GIT_METADATA.branch } : {}),
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
    const managed = {
      child,
      log,
      logClosed: false,
      stopping: false,
      // P0-2 退出分类：expected-exit 标记绑定本 child 对象（不可被 PID 复用/
      // 旧 session 污染——spawn 的 exit handler 以 current?.child === child 判同）。
      startedAtMs: Date.now(),
      readyAtMs: null,
      expectedExit: null,
      forcedKill: null,
    };
    this.observeRuntimeOutput(config, child.stdout, managed);
    this.observeRuntimeOutput(config, child.stderr, managed);
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
      const classification = this.classifyBotExit(managed, code, signal);
      config.exit = {
        classification: classification.classification,
        requestedAction: managed.expectedExit?.action ?? null,
        requestedBy: managed.expectedExit?.requestedBy ?? null,
        requestedAt: managed.expectedExit?.requestedAt ?? null,
        shutdownDeadlineMs: managed.expectedExit?.deadlineMs ?? null,
        forcedKillAt: managed.forcedKill?.at ?? null,
        pid: child.pid ?? null,
        exitCode: code,
        exitSignal: signal,
        ready: managed.readyAtMs !== null,
        uptimeMs: managed.readyAtMs !== null ? Date.now() - managed.startedAtMs : null,
        observedAt: new Date().toISOString(),
      };
      config.processState =
        classification.classification === "UNEXPECTED_CRASH" ||
        classification.classification === "STARTUP_FAILURE" ||
        classification.classification === "EXTERNAL_TERMINATION" ||
        classification.classification === "FORCED_STOP_TIMEOUT"
          ? "error"
          : "stopped";
      if (classification.incident) {
        const incident = classification.incident;
        const sig = `exit-class:${classification.classification}/${code ?? "none"}/${signal ?? "none"}`;
        const actual = `exit classification=${classification.classification} code=${code ?? "none"} signal=${signal ?? "none"} ready=${managed.readyAtMs !== null ? "yes" : "no"}`;
        this.incidents.report({
          subject: "bot",
          botId,
          failureCode: incident.failureCode,
          incidentType: incident.incidentType,
          sourceComponent: "studio-local-manager",
          normalizedErrorSignature: sig,
          actionFamily: "bot-runtime-process",
          severity: incident.severity,
          expected: "bot runtime keeps running or exits 0 after graceful stop",
          actual,
          ...(GIT_METADATA.commit ? { gitCommit: GIT_METADATA.commit } : {}),
          ...(GIT_METADATA.branch ? { gitCommitBranch: GIT_METADATA.branch } : {}),
          snapshots: {
            username: config.username,
            serverHost: config.serverHost,
            serverPort: config.serverPort,
            exit: config.exit,
          },
        });
      }
    });
  }

  /**
   * P0-2 退出分类（退出语义模型）：
   * EXPECTED_STOP / EXPECTED_RESTART —— 本 manager 请求的停止/重启（优雅或超时强停），
   *   不产生 BOT_CRASH。此前正常 stop 常以 code!=0 退出被误记为 crash。
   * GRACEFUL_SHUTDOWN —— manager 自身关闭中（this.stopping）。
   * FORCED_STOP_TIMEOUT —— 优雅停止超 deadline 后本 manager SIGKILL：记 WARNING 级
   *   BOT_LIFECYCLE Incident（graceful 停止失败是真实可靠性信号，但不是 crash）。
   * STARTUP_FAILURE —— 从未 ready（未观测到 runtime_link_authenticated/bot_runtime_online）
   *   就退出且非本 manager 请求；重启场景中新进程失败不与旧进程退出混淆。
   * EXTERNAL_TERMINATION —— 被本 manager 未发出的 signal 终止（POSIX 侧证据；
   *   Windows signal 语义弱化为 code，不可分辨时按下面的顺序落到 crash/startup）。
   * UNEXPECTED_CRASH —— ready 后非预期非零退出；唯一映射 BOT_CRASH/CRITICAL 的分类。
   */
  classifyBotExit(managed, code, signal) {
    const expectedAction = managed.expectedExit?.action;
    if (this.stopping) return { classification: "GRACEFUL_SHUTDOWN" };
    if (expectedAction === "restart") return { classification: "EXPECTED_RESTART" };
    if (expectedAction === "stop") {
      if (managed.forcedKill) {
        return {
          classification: "FORCED_STOP_TIMEOUT",
          incident: {
            failureCode: "BOT_FORCED_STOP_TIMEOUT",
            incidentType: "BOT_LIFECYCLE",
            severity: "WARNING",
          },
        };
      }
      return { classification: "EXPECTED_STOP" };
    }
    if (code === 0) return { classification: "EXPECTED_STOP" };
    if (signal && !managed.forcedKill) {
      return {
        classification: "EXTERNAL_TERMINATION",
        incident: {
          failureCode: "BOT_EXTERNAL_TERMINATION",
          incidentType: "BOT_LIFECYCLE",
          severity: "ERROR",
        },
      };
    }
    if (managed.readyAtMs === null) {
      return {
        classification: "STARTUP_FAILURE",
        incident: {
          failureCode: "BOT_STARTUP_FAILED",
          incidentType: "BOT_LIFECYCLE",
          severity: "ERROR",
        },
      };
    }
    return {
      classification: "UNEXPECTED_CRASH",
      incident: {
        failureCode: "BOT_PROCESS_EXITED",
        incidentType: "BOT_CRASH",
        severity: "CRITICAL",
      },
    };
  }

  async stopBot(botId, options = undefined) {
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
    // P0-2：发信号前先标记 expected exit（绑定本 child 对象 + botId + 请求者/期限）。
    managed.expectedExit = {
      action: options?.purpose ?? "stop",
      requestedBy: options?.requestedBy ?? "studio-manager",
      requestedAt: new Date().toISOString(),
      deadlineMs: this.options.stopTimeoutMs ?? 10_000,
      pid: child.pid ?? null,
      botId,
    };
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
          managed.forcedKill = { at: new Date().toISOString(), by: "stop-timeout" };
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

  observeRuntimeOutput(config, stream, currentManaged = null) {
    let remainder = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const lines = `${remainder}${chunk}`.split(/\r?\n/u);
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try {
          const event = JSON.parse(line);
          // P0-2：首个 ready 信号（runtime link 认证或 bot 上线）标记进程已就绪，
          // 用于区分 STARTUP_FAILURE 与 UNEXPECTED_CRASH。
          if (
            currentManaged?.readyAtMs === null &&
            (event?.event === "runtime_link_authenticated" || event?.event === "bot_runtime_online")
          ) {
            currentManaged.readyAtMs = Date.now();
          }
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
      // P0-2：最近一次退出的显式分类（EXPECTED_STOP/EXPECTED_RESTART/GRACEFUL_SHUTDOWN/
      // FORCED_STOP_TIMEOUT/STARTUP_FAILURE/EXTERNAL_TERMINATION/UNEXPECTED_CRASH）
      exit: config.exit ?? null,
    };
  }

  /**
   * P0-5 并发可观测性：configured（显式 env 值）/ effective（实际生效）/
   * capacityProfileSource（measured@N 实测 | explicit-config | conservative-default）。
   * capacity profile 由 scripts/benchmark-spark-capacity.mjs 写入（非秘密）。
   */
  buildAiConcurrencyInfo() {
    const raw = this.options.environment.AI_MAX_CONCURRENCY?.trim() ?? '';
    const configured = Number.isSafeInteger(Number(raw)) && Number(raw) >= 1 && Number(raw) <= 64
      ? Number(raw)
      : 2; // 与 coordinator DEFAULT_MAX_CONCURRENCY 一致：唯一实测安全值
    let profile = null;
    try {
      const profilePath = this.options.environment.STUDIO_AI_CAPACITY_PROFILE_PATH?.trim()
        || path.join(this.options.repositoryRoot, 'runtime-data', 'ai-capacity-profile.json');
      if (existsSync(profilePath)) {
        profile = JSON.parse(readFileSync(profilePath, 'utf8'));
      }
    } catch {
      profile = null; // profile 损坏不影响状态主链路
    }
    const explicit = raw.length > 0;
    let source;
    if (Number.isSafeInteger(profile?.testedConcurrency) && profile.testedConcurrency >= 1) {
      source = 'measured@' + profile.testedConcurrency + (profile.testedModel ? ':' + profile.testedModel : '');
    } else if (explicit) {
      source = 'explicit-config';
    } else {
      source = 'conservative-default: only concurrency=2 measured-safe (Round 6); benchmark before raising';
    }
    return {
      configuredMaxConcurrency: configured,
      effectiveMaxConcurrency: configured,
      capacityProfileSource: source,
      testedConcurrency: Number.isSafeInteger(profile?.testedConcurrency) ? profile.testedConcurrency : null,
      testedAt: typeof profile?.testedAt === 'string' ? profile.testedAt : null,
      testedModel: typeof profile?.testedModel === 'string' ? profile.testedModel : null,
    };
  }
  /**
   * Round 8: Gameplay Policy SSOT (desired==effective==single-process resolution).
   * Invalid STUDIO_GAMEPLAY_PROFILE fails closed in start(); this path is post-validation.
   */
  gameplayPolicyInfo() {
    try {
      const policy = resolveGameplayPolicy({ environment: this.options.environment });
      return { desired: policy.profile, effective: policy.profile, source: policy.source, policy };
    } catch (cause) {
      return { desired: "invalid", effective: "invalid", source: "invalid", error: String(cause?.message ?? cause) };
    }
  }

  /**
   * Round 7: anti-cheat compatibility status (SSOT read from the compat layer).
   * Per-bot desired modes come from profile purpose (anarchy -> operator
   * EXPLICIT_UNRESTRICTED desire; managed/其他 -> default UNKNOWN fail-closed).
   * Observer/机器在本进程为演示性空窗口——真实信号由 bot-runtime 上报链
   * 接入后填充（如实暴露，不伪造样本）。
   */
  compatibilityStatus() {
    try {
      const global = resolveCompatibilityMode({
        operatorConfigured: this.options.environment.STUDIO_SERVER_COMPATIBILITY ?? null,
      });
      const profiles = [...this.configs.values()].map((config) => {
        const operatorExplicit = config.purpose === "anarchy";
        const perBot = operatorExplicit
          ? resolveCompatibilityMode({
              operatorConfigured: "EXPLICIT_UNRESTRICTED",
              operatorAllowsUnrestricted: true,
            })
          : resolveCompatibilityMode({});
        const profile = newBehaviorProfile({
          serverProfileId: `local-${config.botId}`,
          desired: perBot.desired,
          effective: perBot.effective,
          source: perBot.source,
          minecraftVersion: config.minecraftVersion ?? null,
          featureGates: [
            { feature: "NO_HUNGER", desiredState: operatorExplicit },
            { feature: "PACKET_MINE", desiredState: operatorExplicit },
          ],
        });
        const gated = evaluateFeatureGates(profile);
        return {
          botId: config.botId,
          desiredMode: perBot.desired,
          effectiveMode: perBot.effective,
          modeSource: perBot.source,
          featureGates: gated.map((gate) => ({ feature: gate.feature, effective: gate.effectiveState, disableReason: gate.disableReason })),
        };
      });
      return {
        global: { desired: global.desired, effective: global.effective, source: global.source },
        bots: profiles,
        observer: { state: "wiring-pending", note: "signals report from bot-runtime; no fabricated samples" },
      };
    } catch (cause) {
      return { error: String(cause?.message ?? cause).slice(0, 200) };
    }
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
    return { state: "misconfigured", message: selection.error, changedAt: new Date().toISOString() };
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
    const networkScope = config.purpose === "anarchy" && !loopbackHost(config.serverHost) && !privateHost(config.serverHost)
      ? "public"
      : loopbackHost(config.serverHost)
        ? "loopback"
        : "private-lan";
    const profile = {
      schemaVersion: "1.0",
      id: `local-${config.botId}`,
      botId: config.botId,
      // Manager-created profiles are real-server targets. Keeping this
      // separate from isolated-test prevents test-only boundary probing from
      // being enabled by a Dashboard-created Bot.
      purpose: config.purpose === "anarchy" ? "anarchy" : "managed",
      // 章程 §6：anarchy purpose 默认导航档（沿途挖掘/疾跑/跑酷/搭高）
      ...(config.purpose === "anarchy" ? { navigation: "anarchy" } : {}),
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
    return {
      config: null,
      status: {
        state: "unavailable",
        source,
        provider,
        baseUrl,
        model: null,
        models: selection.models ?? [],
        latencyMs: probe.latencyMs,
        lastCheckedAt: probe.checkedAt,
        message: selection.error,
      },
    };
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
  const allowed = input.purpose === "anarchy"
    ? "minecraftVersion,purpose,schemaVersion,serverHost,serverPort,username"
    : "minecraftVersion,schemaVersion,serverHost,serverPort,username";
  if (keys !== allowed) {
    throw managedError("INVALID_REQUEST", "Bot 创建请求包含未知或缺失字段。", 400);
  }
  const serverHost = String(input.serverHost ?? "").trim();
  const minecraftVersion = String(input.minecraftVersion ?? "").trim();
  if (
    input.schemaVersion !== "1.0" ||
    typeof input.username !== "string" ||
    !USERNAME_PATTERN.test(input.username) ||
    (input.purpose !== "anarchy" && !loopbackHost(serverHost) && !privateHost(serverHost) && serverHost !== "host.docker.internal") ||
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
    ...(input.purpose === "anarchy" ? { purpose: "anarchy" } : {}),
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
    ...(input?.purpose === "anarchy" ? { purpose: "anarchy" } : {}),
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
  const declared = request.headers["content-length"];  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
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
    // 允许查询串（incidents 筛选用），仍拒绝 hash
    return url.hash === "" ? url : null;
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

/** local test server 日志脱敏：服务器输出按 UNTRUSTED_EXTERNAL_TEXT 处理，secret 模式统一遮蔽。 */
function redactServerLogText(text) {
  const marked = `[UNTRUSTED_EXTERNAL_TEXT] ${text}`;
  return redactSecrets(marked);
}
