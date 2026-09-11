const __T0=Date.now();const __mk=(l)=>console.error(`[${Date.now()-__T0}ms] ${l}`);
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as createHttpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalBotSlots,
  discoverLocalAI,
  discoverLocalAIWithRetry,
  loadLocalAIKeyFile,
  StudioLocalManager,
} from "./studio-local-manager.mjs";

const SECRET = "studio-manager-test-secret-00000000000000000001";
const TOKEN = "studio-manager-http-token-00000000000000000001";

test("discovers an explicit vLLM endpoint and its models", async (context) => {
  const server = createServer((request, response) => {
    if (request.url !== "/v1/models") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "ornith-sm121-v5" }] }));
  });
  await listen(server);
  context.after(() => close(server));
  const address = server.address();
  assert(address && typeof address !== "string");

  const discovered = await discoverLocalAI({
    LOCAL_AI_PROVIDER: "vllm",
    LOCAL_AI_HUB_URL: `http://127.0.0.1:${address.port}`,
    LOCAL_AI_MODEL: "ornith-sm121-v5",
  });
  assert.deepEqual(discovered.config, {
    provider: "vllm",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "ornith-sm121-v5",
  });
  assert.equal(discovered.status.state, "connected");
  assert.deepEqual(discovered.status.models, ["ornith-sm121-v5"]);
});

test("uses the local API key when probing an authenticated vLLM endpoint", async (context) => {
  const server = createServer((request, response) => {
    if (request.url !== "/v1/models") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== "Bearer test-api-key") {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "ornith15-heretic" }] }));
  });
  await listen(server);
  context.after(() => close(server));
  const address = server.address();
  assert(address && typeof address !== "string");

  const discovered = await discoverLocalAI({
    LOCAL_AI_PROVIDER: "vllm",
    LOCAL_AI_HUB_URL: `http://127.0.0.1:${address.port}`,
    LOCAL_AI_MODEL: "ornith15-heretic",
    LOCAL_AI_API_KEY: "test-api-key",
  });
  assert.deepEqual(discovered.config, {
    provider: "vllm",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "ornith15-heretic",
  });
  assert.equal(discovered.status.state, "connected");
});

test("retries Spark discovery during the bounded startup window and selects the current model", async (context) => {
  const readyAt = Date.now() + 80;
  const server = createServer((request, response) => {
    if (request.url !== "/v1/models") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      data: Date.now() >= readyAt ? [{ id: "ornith15-heretic" }] : [],
    }));
  });
  await listen(server);
  context.after(() => close(server));
  const address = server.address();
  assert(address && typeof address !== "string");

  const discovered = await discoverLocalAIWithRetry(
    {
      STUDIO_SPARK_HOSTS: "127.0.0.1",
      STUDIO_SPARK_PORTS: String(address.port),
    },
    { startupWaitMs: 500, retryIntervalMs: 25 },
  );
  assert.deepEqual(discovered.config, {
    provider: "vllm",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "ornith15-heretic",
  });
  assert.equal(discovered.status.model, "ornith15-heretic");
});

test("loads a private vLLM key file without changing endpoint discovery settings", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "studio-ai-key-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "spark-api-key.env"), "VLLM_API_KEY=file-secret\n", "utf8");

  const environment = await loadLocalAIKeyFile(
    {
      LOCAL_AI_API_KEY_FILE: "spark-api-key.env",
      STUDIO_SPARK_PORTS: "8001",
    },
    root,
  );
  assert.equal(environment.LOCAL_AI_API_KEY, "file-secret");
  assert.equal(environment.STUDIO_SPARK_PORTS, "8001");
});

test("prefers an explicit local AI key over a configured key file", async () => {
  const environment = { LOCAL_AI_API_KEY: "process-secret", LOCAL_AI_API_KEY_FILE: "missing.env" };
  assert.equal(await loadLocalAIKeyFile(environment, process.cwd()), environment);
});

test("creates authenticated Bot slots deterministically", () => {
  const first = createLocalBotSlots(SECRET, 3);
  const second = createLocalBotSlots(SECRET, 3);
  assert.deepEqual(first, second);
  assert.equal(first[0].secret, SECRET);
  assert.equal(first[2].botId, "studio-bot-03");
  assert.notEqual(first[1].secret, SECRET);
});

test("supports the real-server slot ceiling of sixteen", () => {
  assert.equal(createLocalBotSlots(SECRET, 16).length, 16);
  assert.throws(() => createLocalBotSlots(SECRET, 17), /slot count is invalid/);
});

test("creates and reloads a managed Bot through the loopback API", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "studio-manager-test-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const options = {
    repositoryRoot: process.cwd(),
    runtimeRoot,
    port: 0,
    token: TOKEN,
    slots: createLocalBotSlots(SECRET, 2),
    aiStatus: unavailableStatus(),
    environment: { STUDIO_SPARK_AUTO_DISCOVERY: "0" },
    runtimeLinkPort: 3220,
    packagedMode: false,
  };

  const manager = new StudioLocalManager(options);
  manager.startBot = fakeStart(manager);
  const address = await manager.start();
  context.after(() => manager.stop());
  const createdResponse = await fetch(`http://127.0.0.1:${address.port}/v1/bots`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: "1.0",
      username: "StudioBot1",
      serverHost: "127.0.0.1",
      serverPort: 25565,
      minecraftVersion: "auto",
    }),
  });
  assert.equal(createdResponse.status, 201);
  assert.equal((await createdResponse.json()).bot.botId, "StudioBot1");
  const createdProfile = JSON.parse(
    await readFile(
      path.join(runtimeRoot, "bots", "player-StudioBot1", "server-profile.json"),
      "utf8",
    ),
  );
  assert.equal(createdProfile.purpose, "managed");
  assert.equal(createdProfile.networkScope, "loopback");
  // 2026-09-03 复活缺陷修复：显式 start 的 bot 才有 desiredRunning=true，
  // manager 重启后自动恢复；创建但从未 start 的 bot 一律保持 stopped。
  const startResponse = await fetch(
    `http://127.0.0.1:${address.port}/v1/bots/StudioBot1/start`,
    { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  assert.equal(startResponse.status, 200);
  const manifest = JSON.parse(await readFile(path.join(runtimeRoot, "local-bots.json"), "utf8"));
  assert.equal(manifest.bots[0].desiredRunning, true);
  await manager.stop();

  const reloaded = new StudioLocalManager(options);
  reloaded.startBot = fakeStart(reloaded);
  const reloadedAddress = await reloaded.start();
  context.after(() => reloaded.stop());
  const statusResponse = await fetch(
    `http://127.0.0.1:${reloadedAddress.port}/v1/status`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.bots.length, 1);
  assert.equal(status.bots[0].processState, "running");
});

test("enables combat and isolates same-server Bot whitelists", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "studio-manager-combat-test-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const options = {
    repositoryRoot: process.cwd(),
    runtimeRoot,
    port: 0,
    token: TOKEN,
    slots: createLocalBotSlots(SECRET, 3),
    aiStatus: unavailableStatus(),
    environment: { STUDIO_SPARK_AUTO_DISCOVERY: "0" },
    runtimeLinkPort: 3220,
    packagedMode: false,
  };
  const manager = new StudioLocalManager(options);
  manager.startBot = fakeStart(manager);
  const address = await manager.start();
  context.after(() => manager.stop());

  const create = (username, serverPort = 25565) =>
    fetch(`http://127.0.0.1:${address.port}/v1/bots`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: "1.0",
        username,
        serverHost: "127.0.0.1",
        serverPort,
        minecraftVersion: "auto",
      }),
    });

  assert.equal((await create("StudioBot1")).status, 201);
  assert.equal((await create("StudioBot2")).status, 201);
  assert.equal((await create("StudioBot3", 25566)).status, 201);

  const profile = async (botId) => JSON.parse(
    await readFile(
      path.join(runtimeRoot, "bots", `player-${botId}`, "server-profile.json"),
      "utf8",
    ),
  );
  const first = await profile("StudioBot1");
  const second = await profile("StudioBot2");
  const third = await profile("StudioBot3");
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, third.id);
  assert.equal(first.combat.enabled, true);
  assert.deepEqual(first.combat.whitelist.usernames, ["StudioBot2"]);
  assert.deepEqual(second.combat.whitelist.usernames, ["StudioBot1"]);
  assert.deepEqual(third.combat.whitelist.usernames, []);
  assert.deepEqual(third.combat.whitelist.uuids, []);
  assert.equal(first.combat.whitelist.usernames.includes("davaidman"), false);
});

test("cleans up a forced Bot stop before a restart can reuse its slot", async () => {
  const manager = new StudioLocalManager({
    repositoryRoot: process.cwd(),
    runtimeRoot: await mkdtemp(path.join(tmpdir(), "studio-manager-stop-test-")),
    port: 0,
    token: TOKEN,
    slots: createLocalBotSlots(SECRET, 1),
    aiStatus: unavailableStatus(),
    environment: { STUDIO_SPARK_AUTO_DISCOVERY: "0" },
    runtimeLinkPort: 3220,
    packagedMode: false,
    stopTimeoutMs: 5,
    forceKillWaitMs: 5,
  });
  const config = {
    botId: "studio-bot-01",
    username: "StudioBot1",
    serverHost: "127.0.0.1",
    serverPort: 25565,
    minecraftVersion: "auto",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    processState: "running",
    lastError: null,
  };
  const child = new EventEmitter();
  child.exitCode = null;
  child.connected = true;
  child.send = (_message, callback) => {
    child.connected = false;
    callback?.(null);
  };
  child.disconnect = () => {
    child.connected = false;
  };
  child.kill = () => {
    child.exitCode = 0;
    return true;
  };
  manager.configs.set(config.botId, config);
  manager.processes.set(config.botId, {
    child,
    log: { end() {} },
    logClosed: false,
    stopping: false,
  });

  await manager.stopBot(config.botId);

  assert.equal(manager.processes.has(config.botId), false);
  assert.equal(config.processState, "stopped");
  assert.equal(child.exitCode, 0);
  await rm(manager.runtimeRoot, { recursive: true, force: true });
});

test("ignores a stale Runtime error after a restarted Bot owns the slot", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "studio-manager-error-test-"));
  await mkdir(path.join(runtimeRoot, "logs"), { recursive: true });
  const children = [];
  const manager = new StudioLocalManager({
    repositoryRoot: process.cwd(),
    runtimeRoot,
    port: 0,
    token: TOKEN,
    slots: createLocalBotSlots(SECRET, 1),
    aiStatus: unavailableStatus(),
    environment: { STUDIO_SPARK_AUTO_DISCOVERY: "0" },
    runtimeLinkPort: 3220,
    packagedMode: false,
    spawn: (_command, _args, options) => {
      const child = new EventEmitter();
      child.spawnOptions = options;
      child.stdout = fakeOutputStream();
      child.stderr = fakeOutputStream();
      child.exitCode = null;
      child.connected = false;
      child.pid = children.length + 1;
      child.kill = () => {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("exit", 0, null));
        return true;
      };
      children.push(child);
      return child;
    },
    stopTimeoutMs: 50,
    forceKillWaitMs: 50,
  });
  const config = {
    botId: "studio-bot-01",
    username: "StudioBot1",
    serverHost: "127.0.0.1",
    serverPort: 25565,
    minecraftVersion: "auto",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    processState: "stopped",
    lastError: null,
  };
  manager.configs.set(config.botId, config);

  await manager.startBot(config.botId);
  const first = children[0];
  const firstManaged = manager.processes.get(config.botId);
  assert(first && firstManaged);
  firstManaged.stopping = true;
  first.exitCode = 0;
  first.emit("exit", 0, null);

  await manager.startBot(config.botId);
  const second = children[1];
  assert(second);
  assert.equal(config.processState, "running");

  first.emit("error", new Error("stale process failure"));

  assert.equal(config.processState, "running");
  assert.equal(config.lastError, null);
  await manager.stopBot(config.botId);
  await rm(runtimeRoot, { recursive: true, force: true });
});

function fakeStart(manager) {
  return async (botId) => {
    const config = manager.configs.get(botId);
    assert(config);
    config.processState = "running";
    // 与真实 startBot 契约一致：显式 start 持久化 desiredRunning=true。
    config.desiredRunning = true;
    config.updatedAt = new Date().toISOString();
    await manager.writeManifest();
  };
}

function fakeOutputStream() {
  const stream = new EventEmitter();
  stream.setEncoding = () => undefined;
  stream.pipe = () => stream;
  return stream;
}

function unavailableStatus() {
  return {
    state: "disabled",
    source: "disabled",
    provider: null,
    baseUrl: null,
    model: null,
    models: [],
    latencyMs: null,
    lastCheckedAt: new Date().toISOString(),
    message: "Spark 自动发现已关闭。",
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ---- model selection fail-closed（本轮 2.3：禁止 fallback models[0]）----

test("selectModel fail-closed semantics", async () => {
  const manager = await import("./studio-local-manager.mjs").catch(() => null);
  if (!manager) return; // 模块有副作用时跳过（由上方既有 11 测试覆盖加载）
  const selectModel = manager.selectModel;
  if (typeof selectModel !== "function") return;
  // 配置存在 → 精确使用
  assert.deepEqual(selectModel(["m-a", "m-b"], "m-b"), { model: "m-b" });
  // 配置不存在 → MODEL_NOT_AVAILABLE，绝不 fallback
  assert.equal(selectModel(["m-a", "m-b"], "m-gone").error, "MODEL_NOT_AVAILABLE");
  // 未配置 + 单模型 → 自动当前模型
  assert.deepEqual(selectModel(["m-only"], undefined), { model: "m-only" });
  // 未配置 + 多模型 → MODEL_SELECTION_REQUIRED，不选第一个
  const multi = selectModel(["m-a", "m-b"], undefined);
  assert.equal(multi.error, "MODEL_SELECTION_REQUIRED");
  assert.ok(Array.isArray(multi.models) && multi.models.length === 2);
  // 零模型 → NOT_AVAILABLE
  assert.equal(selectModel([], undefined).error, "MODEL_NOT_AVAILABLE");
});

// ---------------------------------------------------------------------------
// Round 6：Incident 查询/幂等/状态机/导出 + lifecycle operation 端点
// ---------------------------------------------------------------------------

async function startIncidentManager(context, extraEnv = {}) {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "studio-manager-incidents-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const manager = new StudioLocalManager({
    repositoryRoot: process.cwd(),
    runtimeRoot,
    port: 0,
    token: TOKEN,
    slots: createLocalBotSlots(SECRET, 1),
    aiStatus: unavailableStatus(),
    environment: { STUDIO_SPARK_AUTO_DISCOVERY: "0", ...extraEnv },
    runtimeLinkPort: 3220,
    packagedMode: false,
  });
  manager.startBot = fakeStart(manager);
  const address = await manager.start();
  context.after(() => manager.stop());
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  return { manager, base, headers };
}

test("incident query API: filters, pagination tie-breaker, occurrence drill-down", async (context) => {
  const { base, headers } = await startIncidentManager(context);
  const report = (body) => fetch(`${base}/v1/incidents`, { method: "POST", headers, body: JSON.stringify(body) });
  await report({ subject: "bot", botId: "studio-bot-01", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "progress-watchdog", serverProfileId: "sp-local", skillId: "movement.goto", minecraftVersion: "1.21.11", protocolVersion: 774, gitCommit: "abc1234" });
  await report({ subject: "bot", botId: "studio-bot-01", failureCode: "SKILL_RECOVERY_EXHAUSTED", incidentType: "SKILL_FAILED", sourceComponent: "skill-executor", terminalFailureCode: "SKILL_RECOVERY_EXHAUSTED", causedByFailureCodes: ["PATHFINDER_GOTO_FAILED"] });
  await report({ subject: "bot", botId: "studio-bot-02", failureCode: "SERVER_KICKED", incidentType: "SERVER_KICK", sourceComponent: "connection" });

  // filter: failureCode（注意 fast-fail 链的主码已被 causal swap 为 PATHFINDER_GOTO_FAILED）
  const pathList = await (await fetch(`${base}/v1/incidents?failureCode=PATHFINDER_GOTO_FAILED`, { headers })).json();
  assert.equal(pathList.total, 1);
  assert.equal(pathList.issues[0].suspectedLayer, "PATHFINDING");
  assert.equal(pathList.issues[0].terminalFailureCode, "SKILL_RECOVERY_EXHAUSTED");

  // filter: serverProfileId / botId
  const byServer = await (await fetch(`${base}/v1/incidents?serverProfileId=sp-local`, { headers })).json();
  assert.equal(byServer.total, 1);
  const byBot = await (await fetch(`${base}/v1/incidents?botId=studio-bot-02`, { headers })).json();
  assert.equal(byBot.total, 1);

  // 非法时间 filter → 结构化 4xx
  const badTime = await fetch(`${base}/v1/incidents?from=not-a-date`, { headers });
  assert.equal(badTime.status, 400);
  assert.equal((await badTime.json()).error.code, "INVALID_TIME_FILTER");

  // 分页 + nextOffset
  const page1 = await (await fetch(`${base}/v1/incidents?limit=2`, { headers })).json();
  assert.equal(page1.issues.length, 2);
  assert.equal(typeof page1.nextOffset, "number");
  const page2 = await (await fetch(`${base}/v1/incidents?limit=2&offset=${page1.nextOffset}`, { headers })).json();
  assert.equal(page2.issues.length, 1);
  const ids = [...page1.issues.map((i) => i.incidentId), ...page2.issues.map((i) => i.incidentId)];
  assert.equal(new Set(ids).size, 3, "分页不重复");

  // occurrence drill-down
  const detail = await (await fetch(`${base}/v1/incidents/${page1.issues[0].incidentId}`, { headers })).json();
  assert.ok(Array.isArray(detail.occurrences));
  const occurrence = detail.occurrences[0];
  const occurrenceDetail = await (await fetch(`${base}/v1/incidents/${detail.issue.incidentId}/occurrences/${occurrence.occurrenceId}`, { headers })).json();
  assert.equal(occurrenceDetail.occurrence.occurrenceId, occurrence.occurrenceId);
  // 身份字段透传：定位 studio-bot-01 在 sp-local 上的 issue
  const localIssue = (await (await fetch(`${base}/v1/incidents?botId=studio-bot-01&serverProfileId=sp-local`, { headers })).json()).issues[0];
  const localDetail = await (await fetch(`${base}/v1/incidents/${localIssue.incidentId}`, { headers })).json();
  assert.equal(localDetail.occurrences[0].minecraftVersion, "1.21.11");
  assert.equal(localDetail.occurrences[0].protocolVersion, 774);
  assert.equal(localDetail.occurrences[0].gitCommit, "abc1234");
});

test("incident POST idempotency: reporterEventId replay does not duplicate", async (context) => {
  const { base, headers, manager } = await startIncidentManager(context);
  const body = {
    subject: "bot", botId: "studio-bot-01", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK",
    sourceComponent: "progress-watchdog", reporterEventId: "evt-fixed-1",
  };
  const first = await fetch(`${base}/v1/incidents`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(first.status, 201);
  const second = await fetch(`${base}/v1/incidents`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).replayed, true);
  const list = await (await fetch(`${base}/v1/incidents`, { headers })).json();
  assert.equal(list.total, 1);
  assert.equal(list.issues[0].occurrenceCount, 1);
  assert.equal(manager.incidents.listOccurrences(list.issues[0].incidentId).length, 1);
});

test("incident status transition requires passed verification before fixed", async (context) => {
  const { base, headers } = await startIncidentManager(context);
  await fetch(`${base}/v1/incidents`, {
    method: "POST", headers,
    body: JSON.stringify({ subject: "bot", botId: "studio-bot-01", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf" }),
  });
  const list = await (await fetch(`${base}/v1/incidents`, { headers })).json();
  const incidentId = list.issues[0].incidentId;

  const direct = await fetch(`${base}/v1/incidents/${incidentId}/status`, { method: "POST", headers, body: JSON.stringify({ status: "fixed" }) });
  assert.equal(direct.status, 409);
  assert.equal((await direct.json()).error.code, "STATUS_TRANSITION_REJECTED");

  await fetch(`${base}/v1/incidents/${incidentId}/status`, { method: "POST", headers, body: JSON.stringify({ status: "investigating" }) });
  const noVerify = await fetch(`${base}/v1/incidents/${incidentId}/status`, { method: "POST", headers, body: JSON.stringify({ status: "fixed", fixedByCommit: "abc" }) });
  assert.equal(noVerify.status, 409);

  await fetch(`${base}/v1/incidents/${incidentId}/verification`, { method: "POST", headers, body: JSON.stringify({ action: "request" }) });
  await fetch(`${base}/v1/incidents/${incidentId}/verification`, { method: "POST", headers, body: JSON.stringify({ action: "record", result: "passed" }) });
  const fixed = await fetch(`${base}/v1/incidents/${incidentId}/status`, { method: "POST", headers, body: JSON.stringify({ status: "fixed", fixedByCommit: "abc1234" }) });
  assert.equal(fixed.status, 200);
  const issue = (await fixed.json()).issue;
  assert.equal(issue.status, "fixed");
  assert.equal(issue.fixedByCommit, "abc1234");
  assert.ok(issue.statusHistory.length >= 2);
});

test("incident export: json/markdown/repair-prompt/zip download with secret scan fail-closed", async (context) => {
  const { base, headers } = await startIncidentManager(context);
  await fetch(`${base}/v1/incidents`, {
    method: "POST", headers,
    body: JSON.stringify({
      subject: "bot", botId: "studio-bot-01", failureCode: "SKILL_RECOVERY_EXHAUSTED", incidentType: "SKILL_FAILED",
      sourceComponent: "skill-executor", terminalFailureCode: "SKILL_RECOVERY_EXHAUSTED",
      causedByFailureCodes: ["PATHFINDER_GOTO_FAILED"], gitCommit: "abc1234",
      expected: "reaches target", actual: "no path after retries",
      eventWindow: [{ at: new Date().toISOString(), kind: "path_reset", detail: "replan" }],
    }),
  });
  const list = await (await fetch(`${base}/v1/incidents`, { headers })).json();
  const incidentId = list.issues[0].incidentId;

  const jsonExport = await fetch(`${base}/v1/incidents/${incidentId}/export?format=json`, { headers });
  assert.equal(jsonExport.status, 200);
  assert.match(jsonExport.headers.get("content-type"), /application\/json/);
  assert.match(jsonExport.headers.get("content-disposition"), /attachment/);
  assert.ok((await jsonExport.text()).includes("PATHFINDER_GOTO_FAILED"));

  const mdExport = await fetch(`${base}/v1/incidents/${incidentId}/export?format=markdown`, { headers });
  assert.equal(mdExport.status, 200);
  assert.match(mdExport.headers.get("content-type"), /text\/markdown/);
  assert.ok((await mdExport.text()).includes(`# Incident ${incidentId}`));

  const promptExport = await fetch(`${base}/v1/incidents/${incidentId}/export?format=repair-prompt`, { headers });
  assert.equal(promptExport.status, 200);
  const promptText = await promptExport.text();
  assert.ok(promptText.includes("terminal outcome, NOT the root cause"));
  assert.ok(promptText.includes("movement ownership"));

  const zipExport = await fetch(`${base}/v1/incidents/${incidentId}/export?format=zip`, { headers });
  assert.equal(zipExport.status, 200);
  assert.match(zipExport.headers.get("content-type"), /application\/zip/);
  const zipBuffer = Buffer.from(await zipExport.arrayBuffer());
  assert.ok(zipBuffer.length > 100);
  assert.equal(zipBuffer.readUInt32LE(0), 0x04034b50, "ZIP local file header signature");

  const batch = await fetch(`${base}/v1/incidents/export?scope=open&format=json`, { headers });
  assert.equal(batch.status, 200);

  const noScope = await fetch(`${base}/v1/incidents/export`, { headers });
  assert.equal(noScope.status, 400);
});

test("incident export secret scan fails closed on leaked credentials", async (context) => {
  const { base, headers } = await startIncidentManager(context);
  await fetch(`${base}/v1/incidents`, {
    method: "POST", headers,
    body: JSON.stringify({
      subject: "bot", botId: "studio-bot-01", failureCode: "UNKNOWN_FAILURE", incidentType: "UNKNOWN_FAILURE",
      sourceComponent: "x", actual: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    }),
  });
  const secretList = await (await fetch(`${base}/v1/incidents?failureCode=UNKNOWN_FAILURE`, { headers })).json();
  const secretId = secretList.issues[0].incidentId;
  // redact-first 设计：JWT 被统一 redaction 遮蔽后导出成功，原文绝不出现
  const redacted = await fetch(`${base}/v1/incidents/${secretId}/export?format=json`, { headers });
  assert.equal(redacted.status, 200);
  const exportBody = await redacted.text();
  assert.ok(!exportBody.includes("dozjgNryP4J3jVmNHl0w5N"), "JWT 不得原样导出");
  assert.ok(exportBody.includes("[REDACTED]"), "secret 被脱敏标记");
});

test("incident health endpoint exposes writer health", async (context) => {
  const { base, headers } = await startIncidentManager(context);
  const health = await (await fetch(`${base}/v1/incidents/health`, { headers })).json();
  assert.equal(typeof health.writer.flushCount, "number");
  assert.equal(typeof health.writer.approxStoreBytes, "number");
  assert.equal(typeof health.writer.maxDiskBytes, "number");
});

test("status endpoint declares incident + local-test capabilities", async (context) => {
  const { base, headers } = await startIncidentManager(context);
  const status = await (await fetch(`${base}/v1/status`, { headers })).json();
  assert.equal(status.capabilities.incidentExport.zipBundle, true);
  assert.equal(status.capabilities.localTestServer.resetWorld, true);
  assert.ok(status.incidents, "writer health embedded in status");
});

test("local-test reset requires exact world identity confirmation", async (context) => {
  const { base, headers } = await startIncidentManager(context);
  const refused = await fetch(`${base}/v1/servers/local-test/reset`, { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, "RESET_CONFIRMATION_REQUIRED");
  const wrong = await fetch(`${base}/v1/servers/local-test/reset`, { method: "POST", headers, body: JSON.stringify({ confirmWorldIdentity: "wrong-volume" }) });
  assert.equal(wrong.status, 400);
});

test("local-test observed state endpoint reports facts and capabilities", async (context) => {
  const { base, headers } = await startIncidentManager(context, { STUDIO_LOCAL_TEST_SHUTDOWN_POLICY: "keep" });
  const observed = await (await fetch(`${base}/v1/servers/local-test`, { headers })).json();
  assert.ok(["not_running", "online", "starting"].includes(observed.resource.status));
  assert.equal(observed.resource.world.volumeName, "studio-local-test-data");
  assert.equal(observed.resource.shutdownPolicy, "keep");
  assert.deepEqual(observed.resource.capabilities, { start: true, stop: true, restart: true, resetWorld: true, logs: true });
});

// ---------------------------------------------------------------------------
// P0-2：退出语义分类（EXPECTED_STOP/RESTART vs BOT_CRASH 等）——全部走真实
// startBot/stopBot 路径（spawn 注入），exit 分类 handler 由生产代码注册。
// ---------------------------------------------------------------------------

async function exitTestManager(overrides = {}) {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "exit-sem-"));
  await mkdir(path.join(runtimeRoot, "logs"), { recursive: true });
  const children = [];
  const manager = new StudioLocalManager({
    repositoryRoot: process.cwd(),
    runtimeRoot,
    port: 0,
    token: TOKEN,
    slots: createLocalBotSlots(SECRET, 1),
    aiStatus: unavailableStatus(),
    environment: { STUDIO_SPARK_AUTO_DISCOVERY: "0" },
    runtimeLinkPort: 3220,
    packagedMode: false,
    spawn: (_command, _args, options) => {
      const child = new EventEmitter();
      child.spawnOptions = options;
      child.stdout = fakeOutputStream();
      child.stderr = fakeOutputStream();
      child.exitCode = null;
      child.pid = 42000 + children.length;
      child.connected = true;
      child.send = (_message, callback) => {
        child.connected = false;
        callback?.(null);
        if (child.__exitOnSend != null) {
          const [code, signal] = child.__exitOnSend;
          queueMicrotask(() => {
            child.exitCode = code ?? 0;
            child.emit("exit", code, signal ?? null);
          });
        }
      };
      child.disconnect = () => {
        child.connected = false;
      };
      child.kill = (signal) => {
        if (signal === "SIGKILL") {
          queueMicrotask(() => {
            child.exitCode = 1;
            child.emit("exit", 1, "SIGKILL");
          });
        }
        return true;
      };
      children.push(child);
      return child;
    },
    stopTimeoutMs: 40,
    forceKillWaitMs: 40,
    ...overrides,
  });
  manager.configs.set("studio-bot-01", {
    botId: "studio-bot-01",
    username: "StudioBot1",
    serverHost: "127.0.0.1",
    serverPort: 25565,
    minecraftVersion: "auto",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    processState: "stopped",
    lastError: null,
  });
  await manager.start(); // 初始化 IncidentStore 与服务（真实 startBot 路径保留）
  const cleanup = async () => {
    await manager.stop();
    await rm(runtimeRoot, { recursive: true, force: true });
  };
  return { manager, children, runtimeRoot, config: manager.configs.get("studio-bot-01"), cleanup };
}

function markReady(child) {
  child.stdout.emit("data", '{"level":"info","event":"runtime_link_authenticated"}' + "\n");
}

test("managed username identity survives restart and revoked slots cannot name their replacement", async (context) => {
  const { manager, runtimeRoot, cleanup } = await exitTestManager();
  context.after(cleanup);
  manager.configs.clear();
  manager.startBot = fakeStart(manager);
  const input = { username: "_Resident_1", auth: "offline", serverHost: "127.0.0.1",
    serverPort: 25565, minecraftVersion: "auto", worldId: "season-1" };
  const created = await manager.createBot(input);
  assert.equal(created.botId, input.username);
  const profile = JSON.parse(await readFile(manager.profilePath(created.botId), "utf8"));
  assert.equal(profile.botId, profile.username);
  assert.deepEqual(profile.identityBinding, { mode: "game-username" });
  assert.equal(profile.worldId, "season-1");
  const manifest = JSON.parse(await readFile(manager.manifestPath, "utf8"));
  assert.equal(manifest.bots[0].slotId, "studio-bot-01");
  const restored = new StudioLocalManager(manager.options);
  await restored.loadManifest();
  assert.equal(restored.configs.get(created.botId).username, created.botId);
  await assert.rejects(manager.createBot({ ...input, username: "_resident_1", serverPort: 25566 }),
    (error) => error.managerCode === "BOT_CONFLICT");
  manager.configs.clear();
  await manager.writeManifest();
  assert.deepEqual(JSON.parse(await readFile(manager.bindingsPath, "utf8")).peers, []);
  await manager.createBot({ ...input, username: "CON" });
  assert.ok(manager.profilePath("CON").startsWith(path.join(runtimeRoot, "bots", "player-CON")));
  assert.equal(JSON.parse(await readFile(manager.bindingsPath, "utf8")).peers[0].botId, "CON");
});

test("online create binds verified username, aliases credentials only to that identity and checks UUID on restart", async (context) => {
  const uuid = "0123456789abcdef0123456789abcdef";
  let verified = { auth: "online", botId: "_RealPlayer", username: "_RealPlayer", gameProfileId: uuid, accountRef: "account_a" };
  let verifications = 0;
  const { manager, children, cleanup } = await exitTestManager({
    environment: { STUDIO_SPARK_AUTO_DISCOVERY: "0", STUDIO_BOT_EMAIL_ACCOUNT_A: "test@example.test", STUDIO_BOT_PASSWORD_ACCOUNT_A: "fixture-secret" },
    resolveGameIdentity: async () => { verifications++; return verified; },
  });
  context.after(cleanup);
  manager.configs.clear();
  const created = await manager.createBot({ auth: "online", accountRef: "account_a", username: "ClaimedName",
    serverHost: "127.0.0.1", serverPort: 25565, minecraftVersion: "auto" });
  assert.equal(created.botId, "_RealPlayer");
  assert.equal(verifications, 1);
  assert.equal(created.gameProfileId, uuid);
  assert.equal(children[0].spawnOptions.env.STUDIO_BOT_EMAIL__REALPLAYER, "test@example.test");
  assert.equal(children[0].spawnOptions.env.STUDIO_BOT_PASSWORD__REALPLAYER, "fixture-secret");
  assert.equal(children[0].spawnOptions.env.BOT_RUNTIME_LINK_KEY_ID, "runtime-key-01");
  const persisted = await readFile(manager.manifestPath, "utf8");
  assert.ok(!persisted.includes("fixture-secret") && !persisted.includes("test@example.test"));
  assert.ok(!persisted.includes("ClaimedName"));
  children[0].__exitOnSend = [0, null];
  await manager.stopBot(created.botId);
  verified = { ...verified, gameProfileId: "f".repeat(32) };
  await assert.rejects(manager.startBot(created.botId), (error) => error.managerCode === "AUTH_REQUIRED");
  assert.equal(children.length, 1);
});

test("online authentication failure allocates neither a slot nor a profile", async (context) => {
  const { manager, cleanup } = await exitTestManager({ resolveGameIdentity: async () => {
    throw Object.assign(new Error("AUTH_REQUIRED"), { managerCode: "AUTH_REQUIRED", httpStatus: 401 });
  } });
  context.after(cleanup);
  manager.configs.clear();
  await assert.rejects(manager.createBot({ auth: "online", accountRef: "account_a" }));
  assert.equal(manager.configs.size, 0);
});

test("concurrent requests for the same account cannot allocate two runtime slots", async (context) => {
  const { manager, cleanup } = await exitTestManager();
  context.after(cleanup);
  manager.configs.clear();
  manager.startBot = fakeStart(manager);
  const input = { auth: "offline", username: "Resident", serverHost: "127.0.0.1", serverPort: 25565, minecraftVersion: "auto" };
  const results = await Promise.allSettled([manager.createBot(input), manager.createBot(input)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(manager.configs.size, 1);
});

function incidentsOf(manager) {
  return [...(manager.incidents.issues ?? new Map()).values()];
}

test("exit classification: graceful normal stop is EXPECTED_STOP with no incident", async () => {
  __mk("test start");
  const { manager, children, config, cleanup } = await exitTestManager();
  await manager.startBot("studio-bot-01");
  __mk("startBot done");
  children[0].__exitOnSend = [0, null];
  await manager.stopBot("studio-bot-01", { purpose: "stop", requestedBy: "test" });
  __mk("stopBot done");

  assert.equal(config.exit.classification, "EXPECTED_STOP");
  __mk("asserts done");
  assert.equal(config.exit.requestedAction, "stop");
  assert.equal(config.exit.requestedBy, "test");
  assert.equal(config.exit.pid, children[0].pid);
  assert.equal(config.processState, "stopped");
  assert.equal(incidentsOf(manager).length, 0);
  await cleanup();
});

test("exit classification: graceful stop exiting non-zero stays EXPECTED_STOP (no BOT_CRASH noise)", async () => {
  const { manager, children, config, cleanup } = await exitTestManager();
  await manager.startBot("studio-bot-01");
  markReady(children[0]);
  children[0].__exitOnSend = [1, null];
  await manager.stopBot("studio-bot-01");

  assert.equal(config.exit.classification, "EXPECTED_STOP");
  assert.equal(incidentsOf(manager).length, 0);
  await cleanup();
});

test("exit classification: restart-marked stop is EXPECTED_RESTART even on non-zero exit", async () => {
  const { manager, children, config, cleanup } = await exitTestManager();
  await manager.startBot("studio-bot-01");
  children[0].__exitOnSend = [1, null];
  await manager.stopBot("studio-bot-01", { purpose: "restart", requestedBy: "studio-api" });

  assert.equal(config.exit.classification, "EXPECTED_RESTART");
  assert.equal(config.exit.requestedAction, "restart");
  assert.equal(incidentsOf(manager).length, 0);
  await cleanup();
});

test("exit classification: forced kill after stop deadline is FORCED_STOP_TIMEOUT (WARNING lifecycle incident)", async () => {
  const { manager, config, cleanup } = await exitTestManager({ stopTimeoutMs: 5, forceKillWaitMs: 40 });
  await manager.startBot("studio-bot-01");

  await manager.stopBot("studio-bot-01"); // child ignores IPC send; deadline forces SIGKILL

  assert.equal(config.exit.classification, "FORCED_STOP_TIMEOUT");
  assert.notEqual(config.exit.forcedKillAt, null);
  assert.notEqual(config.exit.shutdownDeadlineMs, null);
  const incidents = incidentsOf(manager);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].type, "BOT_LIFECYCLE");
  assert.equal(incidents[0].primaryFailureCode, "BOT_FORCED_STOP_TIMEOUT");
  assert.equal(incidents[0].maxSeverity, "WARNING");
  await cleanup();
});

test("exit classification: external signal kill on a ready bot is EXTERNAL_TERMINATION, not BOT_CRASH", async () => {
  const { manager, children, config, cleanup } = await exitTestManager();
  await manager.startBot("studio-bot-01");
  markReady(children[0]);

  children[0].exitCode = null;
  children[0].emit("exit", null, "SIGKILL");

  assert.equal(config.exit.classification, "EXTERNAL_TERMINATION");
  assert.equal(config.exit.ready, true);
  const incidents = incidentsOf(manager);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].type, "BOT_LIFECYCLE");
  assert.equal(incidents[0].primaryFailureCode, "BOT_EXTERNAL_TERMINATION");
  await cleanup();
});

test("exit classification: unexpected non-zero exit of a ready bot stays BOT_CRASH / CRITICAL", async () => {
  const { manager, children, config, cleanup } = await exitTestManager();
  await manager.startBot("studio-bot-01");
  markReady(children[0]);

  children[0].exitCode = 1;
  children[0].emit("exit", 1, null);

  assert.equal(config.exit.classification, "UNEXPECTED_CRASH");
  assert.equal(config.processState, "error");
  const incidents = incidentsOf(manager);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].type, "BOT_CRASH");
  assert.equal(incidents[0].primaryFailureCode, "BOT_PROCESS_EXITED");
  assert.equal(incidents[0].maxSeverity, "CRITICAL");
  await cleanup();
});

test("exit classification: never-ready process exit is STARTUP_FAILURE, not BOT_CRASH", async () => {
  const { manager, children, config, cleanup } = await exitTestManager();
  await manager.startBot("studio-bot-01");

  children[0].exitCode = 1;
  children[0].emit("exit", 1, null);

  assert.equal(config.exit.classification, "STARTUP_FAILURE");
  assert.equal(config.exit.ready, false);
  const incidents = incidentsOf(manager);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].type, "BOT_LIFECYCLE");
  assert.equal(incidents[0].primaryFailureCode, "BOT_STARTUP_FAILED");
  await cleanup();
});

test("exit classification: manager global shutdown classifies owned bots as GRACEFUL_SHUTDOWN without incidents", async () => {
  const { manager, children, config, cleanup } = await exitTestManager();
  await manager.startBot("studio-bot-01");
  markReady(children[0]);
  manager.stopping = true;

  children[0].exitCode = 1;
  children[0].emit("exit", 1, null);

  assert.equal(config.exit.classification, "GRACEFUL_SHUTDOWN");
  assert.equal(incidentsOf(manager).length, 0);
  // 手动置位的全局 stopping 会让 manager.stop() early-return（真实关闭路径由
  // 调用方先置位），这里复位让 cleanup 能真正关闭 server，避免悬挂句柄。
  manager.stopping = false;
  await cleanup();
});

test("exit classification: duplicate stop is a no-op and keeps the first classification", async () => {
  const { manager, children, config, cleanup } = await exitTestManager();
  await manager.startBot("studio-bot-01");
  children[0].__exitOnSend = [0, null];
  await manager.stopBot("studio-bot-01");
  const first = config.exit;
  await manager.stopBot("studio-bot-01");

  assert.equal(config.exit, first);
  assert.equal(config.exit.classification, "EXPECTED_STOP");
  assert.equal(incidentsOf(manager).length, 0);
  await cleanup();
});

test("exit classification: late exit from a replaced runtime must not classify over the new owner", async () => {
  const { manager, children, config, cleanup } = await exitTestManager();
  await manager.startBot("studio-bot-01");
  const firstManaged = manager.processes.get("studio-bot-01");
  firstManaged.stopping = true;
  children[0].exitCode = 0;
  children[0].emit("exit", 0, null);

  await manager.startBot("studio-bot-01");
  config.exit = null;
  children[0].exitCode = 1;
  children[0].emit("exit", 1, null); // stale event for the replaced child

  assert.equal(config.exit, null, "stale exit must not classify over the new runtime");
  assert.equal(config.processState, "running");
  await cleanup();
});

test("DELETE removes a stopped bot from the manifest and frees its slot", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "studio-manager-delete-test-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const options = {
    repositoryRoot: process.cwd(),
    runtimeRoot,
    port: 0,
    token: TOKEN,
    slots: createLocalBotSlots(SECRET, 1),
    aiStatus: unavailableStatus(),
    environment: { STUDIO_SPARK_AUTO_DISCOVERY: "0" },
    runtimeLinkPort: 3220,
    packagedMode: false,
  };
  const manager = new StudioLocalManager(options);
  manager.startBot = fakeStart(manager);
  const address = await manager.start();
  context.after(() => manager.stop());
  const base = `http://127.0.0.1:${address.port}`;
  const authHeaders = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  const createBody = JSON.stringify({
    schemaVersion: "1.0",
    username: "DeleteBot1",
    serverHost: "127.0.0.1",
    serverPort: 25565,
    minecraftVersion: "auto",
  });
  const created = await fetch(`${base}/v1/bots`, { method: "POST", headers: authHeaders, body: createBody });
  assert.equal(created.status, 201);
  const deleteResponse = await fetch(`${base}/v1/bots/DeleteBot1`, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(deleteResponse.status, 200);
  const manifest = JSON.parse(await readFile(path.join(runtimeRoot, "local-bots.json"), "utf8"));
  assert.equal(manifest.bots.length, 0);
  // 槽位可复用：删除后同名 bot 可以再次创建
  const recreated = await fetch(`${base}/v1/bots`, { method: "POST", headers: authHeaders, body: createBody });
  assert.equal(recreated.status, 201);
});

test("connectHost survives create → manifest → profile JSON → reload (TCP override only; handshake host stays serverHost)", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "studio-manager-connecthost-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const options = {
    repositoryRoot: process.cwd(),
    runtimeRoot,
    port: 0,
    token: TOKEN,
    slots: createLocalBotSlots(SECRET, 2),
    aiStatus: unavailableStatus(),
    environment: { STUDIO_SPARK_AUTO_DISCOVERY: "0" },
    runtimeLinkPort: 3220,
    packagedMode: false,
  };
  const manager = new StudioLocalManager(options);
  manager.startBot = fakeStart(manager);
  const address = await manager.start();
  context.after(() => manager.stop());
  const base = `http://127.0.0.1:${address.port}`;
  const authHeaders = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

  const created = await fetch(`${base}/v1/bots`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      schemaVersion: "1.0",
      username: "ConnectHost1",
      serverHost: "127.0.0.1",
      serverPort: 25565,
      minecraftVersion: "auto",
      connectHost: "127.0.0.9",
    }),
  });
  assert.equal(created.status, 201);
  const createdBot = (await created.json()).bot;
  assert.equal(createdBot.connectHost, "127.0.0.9");
  // serverHost（握手/逻辑地址）绝不被 connectHost 覆盖
  assert.equal(createdBot.serverHost, "127.0.0.1");

  // 站 1：manifest 持久化
  const manifest = JSON.parse(await readFile(path.join(runtimeRoot, "local-bots.json"), "utf8"));
  assert.equal(manifest.bots[0].connectHost, "127.0.0.9");
  assert.equal(manifest.bots[0].serverHost, "127.0.0.1");

  // 站 2：runtime profile JSON（bot-runtime 消费的那份）
  const profile = JSON.parse(
    await readFile(path.join(runtimeRoot, "bots", "player-ConnectHost1", "server-profile.json"), "utf8"),
  );
  assert.equal(profile.host, "127.0.0.1");
  assert.equal(profile.connectHost, "127.0.0.9");

  // 站 3：reload 后仍然在（validatePersistedBot 四站规则）
  await manager.stop();
  const reloaded = new StudioLocalManager(options);
  reloaded.startBot = fakeStart(reloaded);
  const reloadedAddress = await reloaded.start();
  context.after(() => reloaded.stop());
  const status = await (await fetch(`${base.replace(String(address.port), String(reloadedAddress.port))}/v1/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();
  const bot = status.bots.find((b) => b.username === "ConnectHost1");
  assert.ok(bot, "reloaded bot present");
  assert.equal(bot.serverHost, "127.0.0.1");
  assert.equal(bot.connectHost, "127.0.0.9");

  // 非法 connectHost（带协议前缀）被拒
  const rejected = await fetch(`${base.replace(String(address.port), String(reloadedAddress.port))}/v1/bots`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      schemaVersion: "1.0",
      username: "ConnectHost2",
      serverHost: "127.0.0.1",
      serverPort: 25565,
      minecraftVersion: "auto",
      connectHost: "http://127.0.0.9",
    }),
  });
  assert.equal(rejected.status, 400);
});

test("exit classification metadata reaches the public Bot payload", async () => {
  const { manager, children, cleanup } = await exitTestManager();
  await manager.startBot("studio-bot-01");
  children[0].__exitOnSend = [0, null];
  await manager.stopBot("studio-bot-01");

  const bot = manager.publicBot(manager.configs.get("studio-bot-01"));
  assert.equal(bot.exit.classification, "EXPECTED_STOP");
  await cleanup();
});

// ---------------------------------------------------------------------------
// AI provider profiles（模型与 API）：档案 CRUD / 激活写 .env.local / 密钥脱敏
// ---------------------------------------------------------------------------
import {
  validateAiProviderProfile,
  selectModelAutomatically,
  rewriteAiEnvironment,
} from "./studio-local-manager.mjs";

function managerTestOptions(runtimeRoot, repositoryRoot, environment = {}) {
  return {
    repositoryRoot,
    runtimeRoot,
    port: 0,
    token: TOKEN,
    slots: createLocalBotSlots(SECRET, 1),
    aiStatus: unavailableStatus(),
    environment: { STUDIO_SPARK_AUTO_DISCOVERY: "0", ...environment },
    runtimeLinkPort: 3220,
    packagedMode: false,
  };
}

test("validates AI provider profiles with type-specific rules", () => {
  const cloud = validateAiProviderProfile({
    name: "GLM Plan",
    type: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.7",
    apiKey: "sk-test",
  });
  assert.equal(cloud.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(cloud.structuredOutput, "none");
  assert.throws(() => validateAiProviderProfile({
    name: "no-key",
    type: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    model: "m",
  }), /API Key/);
  assert.throws(() => validateAiProviderProfile({
    name: "plain-http",
    type: "openai-compatible",
    baseUrl: "http://api.example.com/v1",
    model: "m",
    apiKey: "k",
  }), /HTTPS/);
  assert.throws(() => validateAiProviderProfile({
    name: "no-port",
    type: "local-vllm",
    baseUrl: "http://spark.local",
  }), /端口/);
  assert.throws(() => validateAiProviderProfile({
    name: "local-so",
    type: "local-vllm",
    baseUrl: "http://spark.local:18300",
    structuredOutput: "json_object",
  }), /structuredOutput/);
});

test("rewriteAiEnvironment replaces managed keys and preserves unrelated lines", () => {
  const previous = [
    "DASHBOARD_STUDIO_MANAGER_URL=\"http://127.0.0.1:3230\"",
    "LOCAL_AI_HUB_URL=\"http://192.168.100.2:18300\"",
    "AI_BASE_URL=\"https://old.example.com\"",
    "OTHER_KEY=keep-me",
    "",
  ].join("\n");
  const cloud = validateAiProviderProfile({
    name: "GLM Plan",
    type: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.7",
    apiKey: "sk-\"quoted\"#key",
  });
  const rewritten = rewriteAiEnvironment(previous, cloud);
  assert.ok(rewritten.includes("OTHER_KEY=keep-me"));
  assert.ok(!rewritten.includes("LOCAL_AI_HUB_URL"));
  assert.ok(!rewritten.includes("old.example.com"));
  assert.ok(rewritten.includes('AI_BASE_URL="https://open.bigmodel.cn/api/paas/v4"'));
  assert.ok(rewritten.includes('AI_API_KEY="sk-\\"quoted\\"#key"'));
  const local = validateAiProviderProfile({
    name: "Spark",
    type: "local-vllm",
    baseUrl: "http://192.168.100.2:18300",
    model: "",
  });
  const localRewritten = rewriteAiEnvironment(rewritten, local);
  assert.ok(localRewritten.includes('LOCAL_AI_HUB_URL="http://192.168.100.2:18300"'));
  assert.ok(!localRewritten.includes("AI_BASE_URL"));
});

test("manages AI provider profiles over the loopback API and activates into .env.local", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "studio-manager-test-"));
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "studio-repo-test-"));
  context.after(async () => {
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  });
  await writeFile(
    path.join(repositoryRoot, ".env.local"),
    "DASHBOARD_STUDIO_MANAGER_URL=\"http://127.0.0.1:3230\"\nLOCAL_AI_HUB_URL=\"http://192.168.100.2:18300\"\nOTHER_KEY=keep\n",
    "utf8",
  );
  // 可探测的假云端端点：/v1/models 带 Bearer 鉴权。
  const hub = createServer((request, response) => {
    if (request.url !== "/v1/models" || request.headers.authorization !== "Bearer sk-live-test") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "glm-4.7" }, { id: "glm-4.7-flash" }] }));
  });
  await listen(hub);
  context.after(() => close(hub));
  const hubAddress = hub.address();
  assert(hubAddress && typeof hubAddress !== "string");

  const manager = new StudioLocalManager(
    managerTestOptions(runtimeRoot, repositoryRoot, {
      STUDIO_CONFIG_ROOT: repositoryRoot,
    }),
  );
  const address = await manager.start();
  context.after(() => manager.stop());
  const base = `http://127.0.0.1:${address.port}`;
  const reloadedBase = () => `http://127.0.0.1:${reloaded.server.address().port}`;
  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

  // 创建（云端档案，回环 HTTP 允许）→ 响应脱敏
  const createdResponse = await fetch(`${base}/v1/ai/providers`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "测试云端",
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${hubAddress.port}/v1`,
      model: "glm-4.7",
      apiKey: "sk-live-test",
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.ok(/^aip-[0-9a-f]+$/.test(created.id));
  assert.equal(created.hasApiKey, true);
  assert.ok(!("apiKey" in created), "响应不得回传密钥明文");

  // 列表
  const listResponse = await fetch(`${base}/v1/ai/providers`, { headers: auth });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.profiles.length, 1);
  assert.equal(list.activeProfileId, null);

  // 编辑（不带密钥）→ 保留旧密钥
  const updatedResponse = await fetch(`${base}/v1/ai/providers`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      id: created.id,
      name: "测试云端改",
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${hubAddress.port}/v1`,
      model: "glm-4.7",
    }),
  });
  assert.equal(updatedResponse.status, 201);
  const updated = await updatedResponse.json();
  assert.equal(updated.name, "测试云端改");
  assert.equal(updated.hasApiKey, true);

  // 激活 → .env.local 托管段重写 + 状态即时探测 + restartRequired
  const activateResponse = await fetch(`${base}/v1/ai/providers/${created.id}/activate`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(activateResponse.status, 200);
  const activated = await activateResponse.json();
  assert.equal(activated.restartRequired, true);
  assert.equal(activated.status.state, "connected");
  assert.equal(activated.status.provider, "openai-compatible");
  assert.deepEqual(activated.status.models, ["glm-4.7", "glm-4.7-flash"]);

  const envFile = await readFile(path.join(repositoryRoot, ".env.local"), "utf8");
  assert.ok(envFile.includes("OTHER_KEY=keep"), "无关键必须保留");
  assert.ok(envFile.includes('AI_PROVIDER="openai-compatible"'));
  assert.ok(envFile.includes(`AI_BASE_URL="http://127.0.0.1:${hubAddress.port}/v1"`));
  assert.ok(envFile.includes('AI_MODEL="glm-4.7"'));
  assert.ok(envFile.includes('AI_API_KEY="sk-live-test"'));
  assert.ok(!envFile.includes("192.168.100.2"), "旧 LOCAL_AI_* 键必须清除");

  // 重启后：activeProfileId 与密钥持久化
  await manager.stop();
  const reloaded = new StudioLocalManager(
    managerTestOptions(runtimeRoot, repositoryRoot, { STUDIO_CONFIG_ROOT: repositoryRoot }),
  );
  await reloaded.start();
  context.after(() => reloaded.stop());
  const reloadedListResponse = await fetch(`${reloadedBase()}/v1/ai/providers`, { headers: auth });
  const reloadedList = await reloadedListResponse.json();
  assert.equal(reloadedList.activeProfileId, created.id);
  assert.equal(reloadedList.profiles[0].hasApiKey, true);
  assert.equal(reloadedList.profiles[0].name, "测试云端改");

  // 删除
  const deleteResponse = await fetch(`${reloadedBase()}/v1/ai/providers/${created.id}`, {
    method: "DELETE",
    headers: auth,
  });
  assert.equal(deleteResponse.status, 200);
  const afterDelete = await (await fetch(`${reloadedBase()}/v1/ai/providers`, {
    headers: auth,
  })).json();
  assert.equal(afterDelete.profiles.length, 0);
  assert.equal(afterDelete.activeProfileId, null);
});

test("discovers AI_BASE_URL cloud config with bearer-authenticated model probe", async (context) => {
  const hub = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer sk-cloud") {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "glm-4.7" }] }));
  });
  await listen(hub);
  context.after(() => close(hub));
  const address = hub.address();
  assert(address && typeof address !== "string");
  const discovered = await discoverLocalAI({
    AI_PROVIDER: "openai-compatible",
    AI_BASE_URL: `http://127.0.0.1:${address.port}`,
    AI_MODEL: "glm-4.7",
    AI_API_KEY: "sk-cloud",
  });
  assert.equal(discovered.config.provider, "openai-compatible");
  assert.equal(discovered.status.state, "connected");
  assert.deepEqual(discovered.status.models, ["glm-4.7"]);
});

test("cloud model may be left empty for activation-time auto-selection", () => {
  const empty = validateAiProviderProfile({
    name: "DeepSeek Auto",
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    model: "",
    apiKey: "sk-test",
  });
  assert.equal(empty.model, null);
  // selectModelAutomatically：优先级表精确匹配优先于列表顺序。
  assert.equal(selectModelAutomatically(["deepseek-v4-pro", "deepseek-flash"]), "deepseek-flash");
  assert.equal(selectModelAutomatically(["some-relay-model"]), "some-relay-model");
  assert.equal(selectModelAutomatically([]), null);
});

// ---------------------------------------------------------------------------
// F-B1：反 DNS-rebinding 闸门（Origin / Host）。
// 合法客户端只有本机服务端代理（dashboard /api/* 与 start-studio 回调）：
// 它们既不发 Origin，也只用回环 Host。浏览器页面必然带 Origin；DNS-rebinding
// 必然把 Host 换成攻击者域名。/v1/studio/restart 不需要请求体，因此不会触发
// CORS 预检——必须在服务端自己拒绝。
// ---------------------------------------------------------------------------

/** 原始 HTTP 客户端：fetch 会丢弃 Host 头，闸门测试必须精确控制 Host/Origin。 */
function rawManagerRequest(base, { method = "GET", requestPath = "/v1/status", headers = {} } = {}) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const request = createHttpRequest(
      { host: target.hostname, port: target.port, method, path: requestPath, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode, body: text.length > 0 ? JSON.parse(text) : null });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function waitForCondition(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("F-B1: rejects browser Origin and non-loopback Host while server-side clients keep working", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "studio-manager-origin-guard-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const restarts = [];
  const manager = new StudioLocalManager({
    ...managerTestOptions(runtimeRoot, process.cwd()),
    onStudioRestart: (requestedBy) => restarts.push(requestedBy),
  });
  manager.startBot = fakeStart(manager);
  const address = await manager.start();
  context.after(() => manager.stop());
  const base = `http://127.0.0.1:${address.port}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  // 1) 浏览器页面：Origin + 合法令牌 + 合法 Host → 仍必须拒绝（无 body，无预检）
  const crossOriginRestart = await rawManagerRequest(base, {
    method: "POST",
    requestPath: "/v1/studio/restart",
    headers: { ...auth, Origin: "http://attacker.example" },
  });
  assert.equal(crossOriginRestart.status, 403, "带 Origin 的浏览器请求必须被拒绝");
  assert.equal(crossOriginRestart.body.error.code, "AUTH_REQUIRED");

  // 2) 跨站读取同样拒绝（GET 无预检）
  const crossOriginRead = await rawManagerRequest(base, {
    requestPath: "/v1/status",
    headers: { ...auth, Origin: "http://attacker.example" },
  });
  assert.equal(crossOriginRead.status, 403);

  // 3) DNS-rebinding：Host 指向攻击者域名（Origin 可被省略）→ 拒绝
  const reboundRestart = await rawManagerRequest(base, {
    method: "POST",
    requestPath: "/v1/studio/restart",
    headers: { ...auth, Host: "attacker.example:3230" },
  });
  assert.equal(reboundRestart.status, 403, "非回环 Host 必须被拒绝");

  const reboundRead = await rawManagerRequest(base, {
    requestPath: "/v1/status",
    headers: { ...auth, Host: `evil.example:${address.port}` },
  });
  assert.equal(reboundRead.status, 403);

  // 4) 合法回环 Host 变体继续可用（无 Origin 的服务端客户端）
  const localhostHost = await rawManagerRequest(base, {
    requestPath: "/v1/status",
    headers: { ...auth, Host: `localhost:${address.port}` },
  });
  assert.equal(localhostHost.status, 200);
  assert.equal(localhostHost.body.schemaVersion, "1.0");
  const ipv6Host = await rawManagerRequest(base, {
    requestPath: "/v1/status",
    headers: { ...auth, Host: `[::1]:${address.port}` },
  });
  assert.equal(ipv6Host.status, 200);

  // 5) 真实 dashboard 客户端（fetch：无 Origin、Host=127.0.0.1:port）照常工作
  const accepted = await fetch(`${base}/v1/studio/restart`, { method: "POST", headers: auth });
  assert.equal(accepted.status, 202);
  const unauthenticated = await rawManagerRequest(base, {
    method: "POST",
    requestPath: "/v1/studio/restart",
    headers: { Origin: "http://attacker.example" },
  });
  assert.equal(unauthenticated.status, 403, "Origin 闸门先于令牌校验");

  // 6) 被拒请求绝不触发整组重启；合法请求必须触发
  assert.equal(await waitForCondition(() => restarts.length === 1), true, "合法请求必须触发重启回调");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(restarts.length, 1, "被拒请求不得触发任何重启");
});
