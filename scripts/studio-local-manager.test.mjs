import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalBotSlots,
  discoverLocalAI,
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

function fakeStart(manager) {
  return async (botId) => {
    const config = manager.configs.get(botId);
    assert(config);
    config.processState = "running";
    config.updatedAt = new Date().toISOString();
  };
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
