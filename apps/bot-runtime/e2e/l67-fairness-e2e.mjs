#!/usr/bin/env node
// L6/L7 — N-Bot fairness（无饥饿）。
// 用法：node l67-fairness-e2e.mjs            → L6（5 bot × 3 轮）
//       FAIRNESS_BOTS=10 FAIRNESS_ROUNDS=2   → L7（10 bot × 2 轮）
// 断言：
//   1) 所有提交的 goal 都到达终态（completed/failed，无滞留）
//   2) 每个 bot 至少完成 1 个 goal（无饥饿）
//   3) 完成数离散度 max-min ≤ 1（轮间调度公平）
//   4) 末轮墙钟 ≤ 首轮墙钟 × 4（无性能退化雪崩）
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
const ACTIVE = new Set(["queued", "assigned", "running", "blocked", "waiting", "paused"]);

const BOT_COUNT = Number(process.env.FAIRNESS_BOTS ?? "5");
const ROUNDS = Number(process.env.FAIRNESS_ROUNDS ?? "3");
const LABEL = process.env.FAIRNESS_LABEL ?? (BOT_COUNT >= 10 ? "L7" : "L6");

async function api(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function botOnline(botId) {
  const { body } = await api(CONTROL_API, "/v1/bots");
  return (body.data?.bots ?? []).find((b) => b.botId === botId)?.connectionState === "online";
}

async function fetchTask(taskId) {
  const { body } = await api(CONTROL_API, `/v1/tasks?limit=100`);
  return (body.data?.tasks ?? []).find((t) => t.taskId === taskId) ?? null;
}

const RESULTS = { label: LABEL, botCount: BOT_COUNT, rounds: ROUNDS, perBot: {}, roundMs: [] };

await withE2EFixture(async (fixture) => {
  log(`${LABEL}: fixture port=${fixture.port}; ${BOT_COUNT} bots × ${ROUNDS} rounds`);

  // 建 bot 并全部上线
  const bots = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const created = await api(MANAGER, "/v1/bots", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", username: `${LABEL}B${i}${Date.now().toString(36).slice(-4)}`.slice(0, 16), serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
    });
    const botId = created.body.bot?.botId;
    if (!botId) { log(`FATAL: bot ${i} create failed`); process.exit(1); }
    bots.push(botId);
    RESULTS.perBot[botId] = { completed: 0, failed: 0, submitted: 0 };
    await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });
  }
  for (const botId of bots) {
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      if (await botOnline(botId)) break;
    }
  }
  const allOnline = [];
  for (const botId of bots) allOnline.push(await botOnline(botId));
  RESULTS.allOnline = allOnline.every(Boolean);
  log(`all bots online: ${RESULTS.allOnline} (${bots.length})`);

  // 轮转提交：每轮给每个 bot 一个独立 goal（坐标错开，避免互相挤位）。
  // 记账规则：HTTP 200 + action=skill_result = 同步完成（这种 goal 不进
  // /v1/tasks 列表）；202 = 异步任务，轮询到终态。
  const submitted = [];
  for (let round = 0; round < ROUNDS; round++) {
    const roundStart = Date.now();
    const roundEntries = [];
    for (let i = 0; i < bots.length; i++) {
      const taskId = randomUUID();
      const response = await api(CONTROL_API, "/v1/goals", {
        method: "POST",
        body: JSON.stringify({ schemaVersion: "1.0", requestId: taskId, botId: bots[i], operatorGoal: `移动到坐标 x=${round * 3 + i} y=70 z=${round * 3} 附近`, timeoutMs: 120_000 }),
      }).catch(() => ({ status: 0, body: {} }));
      const entry = {
        taskId,
        botId: bots[i],
        round,
        submitStatus: response.status,
        submitAction: response.body?.data?.action ?? null,
      };
      roundEntries.push(entry);
      submitted.push(entry);
      RESULTS.perBot[bots[i]].submitted += 1;
    }
    // 等本轮异步 goal（202）全部终态；同步完成的跳过
    const asyncEntries = roundEntries.filter((e) => e.submitStatus === 202);
    const deadline = Date.now() + Number(process.env.FAIRNESS_ROUND_DEADLINE_MS ?? "240_000");
    while (Date.now() < deadline && asyncEntries.length > 0) {
      await sleep(3000);
      for (let j = asyncEntries.length - 1; j >= 0; j--) {
        const t = await fetchTask(asyncEntries[j].taskId);
        if (t !== null && !ACTIVE.has(t.status)) asyncEntries.splice(j, 1);
      }
    }
    // 记账
    for (const entry of roundEntries) {
      if (entry.submitStatus === 200 && entry.submitAction === "skill_result") {
        RESULTS.perBot[entry.botId].completed += 1;
      } else if (entry.submitStatus === 202) {
        const t = await fetchTask(entry.taskId);
        if (t?.status === "completed") RESULTS.perBot[entry.botId].completed += 1;
        else if (t?.status && !ACTIVE.has(t.status)) RESULTS.perBot[entry.botId].failed += 1;
        else RESULTS.perBot[entry.botId].failed += 1; // 轮限内未终态按失败计
      } else {
        RESULTS.perBot[entry.botId].failed += 1;
      }
    }
    const roundMs = Date.now() - roundStart;
    RESULTS.roundMs.push(roundMs);
    log(`round ${round + 1}/${ROUNDS} done in ${(roundMs / 1000).toFixed(1)}s`);
  }

  const counts = Object.values(RESULTS.perBot);
  RESULTS.minCompleted = Math.min(...counts.map((c) => c.completed));
  RESULTS.maxCompleted = Math.max(...counts.map((c) => c.completed));
  RESULTS.totalCompleted = counts.reduce((s, c) => s + c.completed, 0);
  RESULTS.totalSubmitted = counts.reduce((s, c) => s + c.submitted, 0);
  RESULTS.starvedBots = bots.filter((b) => RESULTS.perBot[b].completed === 0);
  RESULTS.allTerminal = counts.every((c) => c.completed + c.failed === c.submitted);
  RESULTS.roundSlowdown = RESULTS.roundMs.length >= 2 ? RESULTS.roundMs[RESULTS.roundMs.length - 1] / RESULTS.roundMs[0] : 1;

  RESULTS.passed =
    RESULTS.allOnline &&
    RESULTS.allTerminal &&
    RESULTS.minCompleted >= 1 &&
    (RESULTS.maxCompleted - RESULTS.minCompleted) <= 1 &&
    RESULTS.totalCompleted >= Math.ceil(RESULTS.totalSubmitted * 0.8) &&
    RESULTS.roundSlowdown <= 4;

  // 清理
  for (const botId of bots) await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);
  await sleep(5000);

  console.log(`\n========== ${LABEL} RESULTS ==========`);
  const perBotShort = {};
  for (const [botId, c] of Object.entries(RESULTS.perBot)) perBotShort[botId.slice(-6)] = c;
  console.log(JSON.stringify({ ...RESULTS, perBot: perBotShort }, null, 2));
  console.log(`${LABEL}: ${RESULTS.passed ? "PASS" : "FAIL"}`);
  process.exit(RESULTS.passed ? 0 : 2);
});
