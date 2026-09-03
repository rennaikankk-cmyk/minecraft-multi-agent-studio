#!/usr/bin/env node
// 外部灰度 Canary —— luv.mc6.cn:22936（Server Profile SSOT：configs/servers/luv-anarchy.json）
// 只读链路验证：登录在场 → 轻量观察 goal → 重连 → 干净退出。
// 纪律：不做任何破坏性动作；host/port 只从 profile 读（不硬编码）；
// 服务器文本 = UNTRUSTED_EXTERNAL_TEXT（不解析不回显到日志）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "..", "..", "..");
const secrets = JSON.parse(readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"));
// 灰度目标从 Server Profile SSOT 读取（默认 simpfun-gray；CANARY_PROFILE 可换）。
const PROFILE_FILE = process.env.CANARY_PROFILE ?? "simpfun-gray.json";
const profile = JSON.parse(readFileSync(path.join(ROOT, "configs", "servers", PROFILE_FILE), "utf8"));
const MANAGER = `http://127.0.0.1:${process.env.STUDIO_MANAGER_PORT ?? "3230"}`;
const CONTROL_API = `http://127.0.0.1:${process.env.CONTROL_API_PORT ?? "3210"}`;
const HEADERS = { Authorization: `Bearer ${secrets.dashboardToken}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function api(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function botOnline(botId) {
  const { body } = await api(CONTROL_API, `/v1/bots/${botId}`);
  return body.data?.bot?.connectionState === "online";
}

const RESULTS = { profileId: profile.id, host: profile.host, port: profile.port };

async function main() {
  // —— (1) 登录在场 ——
  const username = `StudioCanary${Date.now().toString(36).slice(-4)}`.slice(0, 16);
  // 2026-09-03 simpfun canary：本机 tun 代理把域名解析成 fake-ip（198.18.x），
  // MC 长连接经代理出口被服务端 4s 内踢。CANARY_CONNECT_IP 提供"真 IP 直连"
  // 通道（域名仍来自 profile SSOT；真 IP 由 DoH 解析并记录在 _profileStatus）。
  const connectHost = process.env.CANARY_CONNECT_IP ?? profile.host;
  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: "1.0",
      username,
      serverHost: connectHost,
      serverPort: profile.port,
      minecraftVersion: "auto",
      purpose: "anarchy",
    }),
  });
  const botId = created.body.bot?.botId;
  if (!botId) { console.log("create failed", JSON.stringify(created.body).slice(0, 200)); process.exit(2); }
  await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });

  let online = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    if (await botOnline(botId)) { online = true; break; }
  }
  RESULTS.loginPresence = online;
  log(`login presence: ${online}`);

  // —— (2) 轻量观察 goal（无破坏：观察周围方块） ——
  let observeStatus = null;
  if (online) {
    const { status, body } = await api(CONTROL_API, "/v1/goals", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: crypto.randomUUID(),
        botId,
        operatorGoal: "观察周围方块并汇报看到的地形",
        timeoutMs: 90_000,
      }),
    }).catch(() => ({ status: 0, body: {} }));
    observeStatus = status;
    // 同步结果即真值；202/超时都如实记录（外部服不可控，只验证链路不翻车）
    await sleep(15_000);
  }
  RESULTS.observeGoalStatus = observeStatus;
  log(`observe goal submit: ${observeStatus}`);

  // —— (3) 重连（restart bot，验证 canary 掉线重连链路） ——
  let reconnectOnline = false;
  if (online) {
    await api(MANAGER, `/v1/bots/${botId}/restart`, { method: "POST" });
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (await botOnline(botId)) { reconnectOnline = true; break; }
    }
  }
  RESULTS.reconnectPresence = reconnectOnline;
  log(`reconnect presence: ${reconnectOnline}`);

  // —— (4) 干净退出（EXPECTED_STOP 语义） ——
  await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);
  await sleep(6000);
  const statusAfter = await api(MANAGER, "/v1/status").then((r) =>
    (r.body.bots ?? []).find((b) => b.botId === botId),
  );
  RESULTS.cleanStop = statusAfter?.processState === "stopped";
  RESULTS.exitClassification = statusAfter?.exit?.classification ?? null;

  await api(MANAGER, `/v1/bots/${botId}`, { method: "DELETE" }).catch(() => undefined);

  // canary 通过标准：登录在场 + 干净退出 + 退出分类 EXPECTED_*；观察 goal 尽力而为
  RESULTS.passed =
    RESULTS.loginPresence &&
    RESULTS.cleanStop &&
    (RESULTS.exitClassification === "EXPECTED_STOP" || RESULTS.exitClassification === "EXPECTED_RESTART");

  console.log("\n========== LUV CANARY RESULTS ==========");
  console.log(JSON.stringify(RESULTS, null, 2));
  console.log(`CANARY: ${RESULTS.passed ? "PASS" : "FAIL"}`);
  process.exit(RESULTS.passed ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(2); });
