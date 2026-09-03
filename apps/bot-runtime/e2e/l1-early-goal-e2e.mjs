#!/usr/bin/env node
// L1 Early Goal — 创建 Bot 后立即提交 Goal（不等待 READY）。
// 验收：
//   A. POST /v1/goals 在 bot 未 ready 时返回 202 + waiting_for_bot
//   B. Bot ready 后 goal 自动执行一次
//   C. 用户不重复提交
//   D. Server truth 验证执行（RCON 位置确认）
//   E. 正常停止零 BOT_CRASH
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withE2EFixture } from "./fixture-manager.mjs";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "..", "..", "..");
const secrets = JSON.parse(readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"));
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

const RESULTS = {};

await withE2EFixture(async (fixture) => {
  const fixturePort = fixture.port;
  const startedAt = new Date().toISOString();

  // ===== 1. 创建 Bot（不等待 online）=====
  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `L1E${Date.now().toString(36).slice(-5)}`, serverHost: "127.0.0.1", serverPort: fixturePort, minecraftVersion: "auto" }),
  });
  const botId = created.body.bot?.botId;
  const username = created.body.bot?.username;
  if (!botId) { log("FATAL: create bot failed"); process.exitCode = 1; return; }
  log(`bot ${username} created (${botId}) — NOT waiting for ready`);

  // ===== 2. 立即提交 Goal（bot 刚创建，肯定未 ready）=====
  const requestId = randomUUID();
  const goalText = "移动到坐标 x=0 y=70 z=0 附近";
  const submitRes = await api(CONTROL_API, "/v1/goals", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", requestId, botId, operatorGoal: goalText, timeoutMs: 120_000 }),
  });
  log(`goal submitted immediately: HTTP ${submitRes.status}`);
  log(`body: ${JSON.stringify(submitRes.body).slice(0, 300)}`);

  // 验收 A：202 + waiting_for_bot
  RESULTS.A_waiting = {
    httpStatus: submitRes.status,
    action: submitRes.body?.data?.action,
    is202: submitRes.status === 202,
    isWaiting: submitRes.body?.data?.action === "waiting_for_bot",
  };
  log(`A: HTTP=${submitRes.status} action=${submitRes.body?.data?.action} → ${RESULTS.A_waiting.is202 && RESULTS.A_waiting.isWaiting ? "PASS" : "CHECK"}`);

  // ===== 3. 启动 Bot（goal 已经在等了）=====
  await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });
  log("bot start requested");

  // ===== 4. 等 goal 终态（不重提）=====
  let task = null;
  for (let i = 0; i < 120; i++) {
    await sleep(2_000);
    const { body } = await api(CONTROL_API, "/v1/tasks?limit=20");
    const t = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
    if (t && (t.status === "completed" || t.status === "failed")) { task = t; break; }
    if (i % 15 === 0) log(`polling... ${i * 2}s elapsed`);
  }

  // 验收 B：goal 自动执行（有终态且不是 expired）
  RESULTS.B_autoExecute = {
    taskFound: task !== null,
    status: task?.status,
    failureReason: task?.failureReason ?? null,
    completed: task?.status === "completed",
  };
  log(`B: task=${task?.status} failure=${task?.failureReason} → ${RESULTS.B_autoExecute.completed ? "PASS" : task?.status === "failed" ? "FAIL" : "TIMEOUT"}`);

  // ===== 5. Server truth：RCON 确认 bot 在目标附近 =====
  const posRaw = await fixture.rcon(`data get entity ${username} Pos`).catch(() => "");
  const posMatch = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(posRaw);
  const pos = posMatch ? { x: Number(posMatch[1]), y: Number(posMatch[2]), z: Number(posMatch[3]) } : null;
  const nearTarget = pos !== null && Math.abs(pos.x) <= 8 && Math.abs(pos.z) <= 8 && Math.abs(pos.y - 70) <= 8;
  RESULTS.D_serverTruth = { position: pos, nearTarget, rconResponse: posRaw.slice(0, 100) };
  log(`D: position=${JSON.stringify(pos)} near(0,70,0)=${nearTarget}`);

  // ===== 6. 正常停止 =====
  const crashBefore = await countBotCrashes();
  await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);
  await sleep(6_000);
  const crashAfter = await countBotCrashes();
  RESULTS.E_cleanStop = { crashDelta: crashAfter - crashBefore };
  log(`E: BOT_CRASH delta=${crashAfter - crashBefore}`);

  // ===== 最终判定 =====
  const passed = RESULTS.A_waiting.is202 && RESULTS.A_waiting.isWaiting && RESULTS.B_autoExecute.completed && nearTarget && (crashAfter - crashBefore) === 0;
  const endedAt = new Date().toISOString();

  console.log("\n========== L1 RESULTS ==========");
  console.log(JSON.stringify({ startedAt, endedAt, fixturePort, botId, username, goalId: requestId, ...RESULTS, passed }, null, 2));
  console.log(`L1: ${passed ? "PASS" : "FAIL"}`);
  process.exitCode = passed ? 0 : 2;
});

async function countBotCrashes() {
  const { body } = await api(MANAGER, "/v1/incidents?limit=200");
  return (body.issues ?? [])
    .filter((i) => (i.primaryFailureCode ?? "") === "BOT_PROCESS_EXITED" && (i.classification ?? "") === "UNEXPECTED_CRASH")
    .reduce((s, i) => s + (i.occurrenceCount ?? 0), 0);
}
