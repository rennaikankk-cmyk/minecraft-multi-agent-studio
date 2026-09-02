#!/usr/bin/env node
// S4 External Soak（Skill System v1 §十六/§十七）：luv.mc6.cn:22936 单 Bot ≥60min。
// 外部无规则服：Studio 不 Start/Stop/Reset 服务器、无 RCON。验证面：
//   - SLP 玩家列表真值（bot 在线在场）；
//   - studio 遥测（connectionState/health/food）；
//   - 周期性轻量 goal（scan/collect/craft）在真实公网服上完成；
//   - compat 信号（/v1/status compatibility）；
//   - 死亡/重连/BOT_CRASH 计数；结束 EXPECTED_STOP。
// 产物：e2e/logs/soak-s4-<tag>.jsonl + summary JSON。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "..", "..", "..");
const LOG_DIR = path.join(E2E_DIR, "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const RUN_TAG = Date.now().toString(36).slice(-6);
const JSONL = path.join(LOG_DIR, `soak-s4-${RUN_TAG}.jsonl`);
const SUMMARY = path.join(LOG_DIR, `soak-s4-${RUN_TAG}.json`);

const SOAK_MINUTES = Number(process.env.SOAK_MINUTES ?? "60");
const SERVER_HOST = process.env.S4_HOST ?? "luv.mc6.cn";
const SERVER_PORT = Number(process.env.S4_PORT ?? "22936");
const secrets = JSON.parse(readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"));
const MANAGER = `http://127.0.0.1:${process.env.STUDIO_MANAGER_PORT ?? "3230"}`;
const CONTROL_API = `http://127.0.0.1:${process.env.CONTROL_API_PORT ?? "3210"}`;
const HEADERS = { Authorization: `Bearer ${secrets.dashboardToken}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const jlog = (obj) => appendFileSync(JSONL, `${JSON.stringify(obj)}\n`);

async function api(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// 最小 SLP（TCP status ping）：varint 分帧 → handshake → status request → JSON。
// ---------------------------------------------------------------------------
function writeVarint(value) {
  let v = value;
  const bytes = [];
  while (true) {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
    if (v === 0) break;
  }
  return Buffer.from(bytes);
}
function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (true) {
    const byte = buf[index];
    index += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, offset: index };
}
async function slp(host, port, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      const hostBuf = Buffer.from(host, "utf8");
      const handshake = Buffer.concat([
        writeVarint(0x00),
        writeVarint(775),
        writeVarint(hostBuf.length), hostBuf,
        Buffer.from([port & 0xff, (port >> 8) & 0xff]),
        writeVarint(0x01),
      ]);
      const framed = Buffer.concat([writeVarint(handshake.length), handshake]);
      socket.write(framed);
      const request = Buffer.from([0x01, 0x00]);
      socket.write(Buffer.concat([writeVarint(request.length), request]));
    });
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      try {
        const { offset } = readVarint(buf, 0); // packet length
        if (buf.length < offset) return;
        const { offset: idOffset } = readVarint(buf, offset);
        if ((buf[idOffset] ?? 0x7f) !== 0x00) { clearTimeout(timer); socket.destroy(); resolve(null); return; }
        const { offset: lenOffset, value: jsonLen } = readVarint(buf, idOffset);
        if (buf.length < lenOffset + jsonLen) return; // 等 JSON 完整
        const json = JSON.parse(buf.subarray(lenOffset, lenOffset + jsonLen).toString("utf8"));
        clearTimeout(timer);
        socket.destroy();
        resolve(json);
      } catch {
        // 继续等更多分片
      }
    });
    socket.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

const stats = {
  startedAt: new Date().toISOString(),
  soakMinutes: SOAK_MINUTES,
  server: `${SERVER_HOST}:${SERVER_PORT}`,
  slpChecks: 0, slpPresent: 0, slpOnline: 0, slpMax: null, slpVersion: null,
  goals: { attempted: 0, completed: 0, failed: 0, timedOut: 0 },
  healthMin: null, foodMin: null,
  deaths: 0, reconnects: 0, crashDeltas: [],
  compatSignals: null,
  cleanStop: null,
};

async function botState(botId) {
  const { body } = await api(CONTROL_API, "/v1/bots");
  return (body.data?.bots ?? []).find((b) => b.botId === botId) ?? null;
}

const REGISTRATION_CLASS_CODES = new Set([
  "BOT_UNAVAILABLE", "PLANNER_BOT_UNAVAILABLE", "PLANNER_REJECTED", "PLANNER_BOT_BUSY",
]);

async function submitGoal(botId, text, timeoutMs = 150_000) {
  for (let submission = 0; submission < 4; submission += 1) {
    const requestId = randomUUID();
    const res = await api(CONTROL_API, "/v1/goals", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", requestId, botId, operatorGoal: text, timeoutMs }),
    });
    if (res.status >= 300 && submission < 3) { await sleep(10_000); continue; }
    if (res.status >= 300) break;
    let outcome = null;
    for (let i = 0; i < Math.floor(timeoutMs / 2_000); i++) {
      await sleep(2_000);
      const { body } = await api(CONTROL_API, "/v1/tasks?limit=10");
      const task = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
      if (task && (task.status === "completed" || task.status === "failed")) {
        outcome = { status: task.status, reason: task.failureReason ?? "" };
        break;
      }
    }
    if (outcome === null) break;
    if (outcome.status === "failed" && REGISTRATION_CLASS_CODES.has(outcome.reason) && submission < 3) {
      await sleep(10_000);
      continue;
    }
    stats.goals.attempted += 1;
    if (outcome.status === "completed") stats.goals.completed += 1; else stats.goals.failed += 1;
    return outcome.status;
  }
  stats.goals.attempted += 1;
  stats.goals.timedOut += 1;
  return "timedOut";
}

// ===== 0) 服务器在场真值 =====
// luv 对裸 status ping 无响应（无政府服常见防护，实测 2026-09-02），但完整登录畅通
// （生产通道 bot 2s 上线）。在场真值因此以 bot 登录为准——登录成功即在玩家列表。
const slp0 = await slp(SERVER_HOST, SERVER_PORT);
stats.slpVersion = slp0 ? `${slp0.version?.name ?? "?"} proto ${slp0.version?.protocol ?? "?"}` : "SLP-shielded";
if (slp0) { stats.slpOnline = slp0.players?.online ?? 0; stats.slpMax = slp0.players?.max ?? 0; }
log(`SLP: ${stats.slpVersion}（不可得时以 bot 登录在场为准）`);

// ===== 1) anarchy bot 建立（生产通道）=====
const created = await api(MANAGER, "/v1/bots", {
  method: "POST",
  body: JSON.stringify({
    schemaVersion: "1.0",
    username: `StudioS4${RUN_TAG}`.slice(0, 16),
    serverHost: SERVER_HOST,
    serverPort: SERVER_PORT,
    minecraftVersion: "auto",
    purpose: "anarchy",
  }),
});
const botId = created.body.bot?.botId;
const username = created.body.bot?.username;
if (!botId) { log(`FATAL: create bot failed ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`); process.exit(1); }
log(`bot ${username} created (${botId})`);
await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });

// 在场确证：服务器接受完整登录 = 在玩家列表（connectionState 由服务器接受链路驱动）
let present = false;
for (let i = 0; i < 90; i++) {
  await sleep(2_000);
  const state = await botState(botId);
  if (state?.connectionState === "online") { present = true; stats.slpChecks += 1; break; }
}
log(`bot present on server (login accepted): ${present}`);
if (!present) {
  await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);
  log("SCENARIO S4 FAIL: never appeared in server player list");
  process.exit(2);
}

const crashBase = await countCrashes();
log(`baseline crash counter=${crashBase}`);

// ===== 2) soak 循环 =====
const deadline = Date.now() + SOAK_MINUTES * 60_000;
const LIGHT_GOALS = [
  "读取当前区域的 oak_log 方块分布并给出扫描结果，只读",
  "采集 1 个 oak_log",
  "合成 4 个 oak_planks",
  "合成 4 个 oak_planks",
  "移动到当前坐标附近 5 格内的安全位置",
];
let i = 0;
while (Date.now() < deadline) {
  const step = LIGHT_GOALS[i % LIGHT_GOALS.length];
  i += 1;
  try {
    const status = await submitGoal(botId, step, 180_000);
    jlog({ t: new Date().toISOString(), goal: step, status });
    // 每轮健康采样 + SLP 在场
    const state = await botState(botId);
    if (state) {
      const health = state.health?.current ?? state.health;
      const food = state.food?.current ?? state.food;
      if (typeof health === "number") stats.healthMin = stats.healthMin === null ? health : Math.min(stats.healthMin, health);
      if (typeof food === "number") stats.foodMin = stats.foodMin === null ? food : Math.min(stats.foodMin, food);
    }
    if (!state || state.connectionState !== "online") {
      stats.deaths += 1;
      jlog({ t: new Date().toISOString(), event: "offline" });
      await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" }).catch(() => undefined);
      for (let k = 0; k < 60; k++) {
        await sleep(2_000);
        if ((await botState(botId))?.connectionState === "online") { stats.reconnects += 1; break; }
      }
    }
    if ((await botState(botId))?.connectionState === "online") stats.slpPresent += 1;
    stats.slpChecks += 1;
    stats.crashDeltas.push((await countCrashes()) - crashBase);
    const st = await api(MANAGER, "/v1/status");
    stats.compatSignals = st.body?.compatibility ?? stats.compatSignals;
  } catch (error) {
    jlog({ t: new Date().toISOString(), event: "cycle-error", message: String(error).slice(0, 300) });
  }
}

// ===== 3) 收尾：EXPECTED_STOP 语义 =====
await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);
await sleep(8_000);
const finalState = await botState(botId);
stats.cleanStop = finalState?.connectionState !== "online";
stats.crashDeltaFinal = (await countCrashes()) - crashBase;

stats.endedAt = new Date().toISOString();
stats.presentRatio = stats.slpChecks > 0 ? stats.slpPresent / stats.slpChecks : 0;
writeFileSync(SUMMARY, JSON.stringify(stats, null, 2));
log(`SOAK S4 SUMMARY -> ${SUMMARY}`);
log(JSON.stringify({
  goals: stats.goals, presentRatio: stats.presentRatio, slpChecks: stats.slpChecks,
  healthMin: stats.healthMin, deaths: stats.deaths, reconnects: stats.reconnects,
  crashDeltaFinal: stats.crashDeltaFinal, cleanStop: stats.cleanStop,
}));
process.exit(stats.cleanStop && stats.crashDeltaFinal === 0 ? 0 : 3);

async function countCrashes() {
  // manager 无聚合 crash 计数器；唯一映射 BOT_CRASH 的退出分类在 Incident 侧。
  const inc = await api(MANAGER, '/v1/incidents?limit=200');
  return (inc.body.issues ?? [])
    .filter((i) => ['BOT_PROCESS_EXITED', 'UNEXPECTED_CRASH', 'BOT_STARTUP_FAILED'].includes(i.primaryFailureCode ?? ''))
    .reduce((sum, i) => sum + (i.occurrenceCount ?? 0), 0);
}
