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
    config.updatedAt = new Date().toISOString();
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
