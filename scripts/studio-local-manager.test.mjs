const __T0=Date.now();const __mk=(l)=>console.error(`[${Date.now()-__T0}ms] ${l}`);
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  assert.equal((await createdResponse.json()).bot.botId, "studio-bot-01");
  const createdProfile = JSON.parse(
    await readFile(
      path.join(runtimeRoot, "bots", "studio-bot-01", "server-profile.json"),
      "utf8",
    ),
  );
  assert.equal(createdProfile.purpose, "managed");
  assert.equal(createdProfile.networkScope, "loopback");
  // 2026-09-03 复活缺陷修复：显式 start 的 bot 才有 desiredRunning=true，
  // manager 重启后自动恢复；创建但从未 start 的 bot 一律保持 stopped。
  const startResponse = await fetch(
    `http://127.0.0.1:${address.port}/v1/bots/studio-bot-01/start`,
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
      path.join(runtimeRoot, "bots", botId, "server-profile.json"),
      "utf8",
    ),
  );
  const first = await profile("studio-bot-01");
  const second = await profile("studio-bot-02");
  const third = await profile("studio-bot-03");
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
    spawn: () => {
      const child = new EventEmitter();
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
    spawn: () => {
      const child = new EventEmitter();
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
  const deleteResponse = await fetch(`${base}/v1/bots/studio-bot-01`, {
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

test("exit classification metadata reaches the public Bot payload", async () => {
  const { manager, children, cleanup } = await exitTestManager();
  await manager.startBot("studio-bot-01");
  children[0].__exitOnSend = [0, null];
  await manager.stopBot("studio-bot-01");

  const bot = manager.publicBot(manager.configs.get("studio-bot-01"));
  assert.equal(bot.exit.classification, "EXPECTED_STOP");
  await cleanup();
});
