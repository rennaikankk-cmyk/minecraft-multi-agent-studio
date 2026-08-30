// ---------------------------------------------------------------------------
// 真实 goal 全链 Incident 闭环 E2E（Round 5 主线验收）
//
// 链路（全部生产组件，无脚本绕行）：
//   隔离 fixture（唯一容器/动态端口/独立 world）
//   → 经 manager API 创建真实 bot runtime（连接 fixture 服务器）
//   → control-api /v1/goals 提交确定性 movement goal（"移动到坐标…"）
//   → Coordinator control-link → Local Planner → skill dispatch（invoke-goto）
//   → Runtime watchdog（MOVE_TO_TARGET 契约）判无 material progress
//   → IncidentReporter POST → manager IncidentStore（去重聚合/异步持久化）
//   → 服务端 Incident API 查询 + 元数据断言
//
// RCON 只用于准备世界（实心箱困住 bot），不触发 watchdog/Incident。
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { randomUUID } from "node:crypto";
import { withE2EFixture } from "./fixture-manager.mjs";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const RUN_LOG = join(E2E_DIR, "logs", "goal-incident-e2e.log");
mkdirSync(dirname(RUN_LOG), { recursive: true });
const MANAGER_PORT = process.env.STUDIO_MANAGER_PORT ?? "3230";
const CONTROL_API_PORT = process.env.CONTROL_API_PORT ?? "3210";
const RUNS = Number(process.env.GOAL_RUNS ?? 5);
const secrets = JSON.parse(
  readFileSync(join(E2E_DIR, "..", "..", "..", "runtime-data", "local-control-secrets.json"), "utf8"),
);

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(RUN_LOG, `${stamped}\n`, "utf8");
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function managerApi(path, init) {
  const { headers: extraHeaders, ...rest } = init ?? {};
  const response = await fetch(`http://127.0.0.1:${MANAGER_PORT}${path}`, {
    ...rest,
    headers: { Authorization: `Bearer ${secrets.dashboardToken}`, ...(extraHeaders ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** 创建 bot 并等待 control-api 显示 online。 */
async function createBotOnline(username, port) {
  const created = await managerApi("/v1/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "1.0",
      username,
      serverHost: "127.0.0.1",
      serverPort: port,
      minecraftVersion: "auto",
    }),
  });
  if (created.status !== 201) throw new Error(`create bot failed: ${JSON.stringify(created.body).slice(0, 200)}`);
  const botId = created.body.bot.botId;
  log(`bot ${botId} (${username}) created, connecting to fixture :${port}`);
  for (let i = 0; i < 40; i += 1) {
    await sleep(1_500);
    const list = await fetch(`http://127.0.0.1:${CONTROL_API_PORT}/v1/bots`, {
      headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
    }).then((r) => r.json()).catch(() => null);
    const entry = (list?.data?.bots ?? []).find((bot) => bot.botId === botId);
    if (entry?.connectionState === "online") {
      log(`bot ${botId} ONLINE`);
      return botId;
    }
    if (i === 39) throw new Error(`bot never online (last=${entry?.connectionState ?? "unknown"})`);
  }
}

/** 经生产 control-api 提交 movement goal。 */
async function submitGoal(botId, x, y, z) {
  const requestId = randomUUID();
  const response = await fetch(`http://127.0.0.1:${CONTROL_API_PORT}/v1/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secrets.dashboardToken}` },
    body: JSON.stringify({
      schemaVersion: "1.0",
      requestId,
      botId,
      operatorGoal: `移动到坐标 x=${x} y=${y} z=${z} 附近`,
      timeoutMs: 30_000,
    }),
  });
  const body = await response.json().catch(() => ({}));
  log(`goal submit → HTTP ${response.status} ${JSON.stringify(body).slice(0, 220)}`);
  if (!response.ok) throw new Error(`goal rejected: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  return requestId;
}

let runCounter = 0;
let aggregateBefore = null;

const result = await withE2EFixture(async (fixture) => {
  log(`fixture: container=${fixture.containerName} port=${fixture.port} world=${fixture.volumeName}`);

  // 基线：本轮之前的 PATH_NO_PROGRESS 聚合计数
  const before = await managerApi("/v1/incidents?failureCode=PATH_NO_PROGRESS");
  aggregateBefore = before.body.issues?.[0]?.occurrenceCount ?? 0;
  log(`baseline PATH_NO_PROGRESS occurrences=${aggregateBefore}`);

  const stuckRuns = [];
  for (let run = 1; run <= RUNS; run += 1) {
    const username = `goal_stuck_${run}`;
    const botId = await createBotOnline(username, fixture.port);
    runCounter = run;

    // 实心箱困住 bot（世界准备；不触碰 watchdog/Incident）
    await fixture.rcon(`execute as ${username} at @s run fill ~-2 ~-1 ~-2 ~2 ~4 ~2 minecraft:cobblestone`).catch((error) => log(`box wall: ${error.message}`));
    await fixture.rcon(`execute as ${username} at @s run fill ~-1 ~ ~-1 ~1 ~3 ~1 minecraft:air`).catch(() => {});
    await fixture.rcon(`execute as ${username} at @s run fill ~-1 ~-1 ~-1 ~1 ~-1 ~1 minecraft:cobblestone`).catch(() => {});
    const pos = await fixture.rcon(`data get entity ${username} Pos`).catch(() => "?");
    log(`run ${run}: bot boxed at ${String(pos).slice(0, 80)}`);

    // 真实 goal：远处坐标（箱内不可达）
    const match = String(pos).match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/);
    const bx = match ? Math.floor(Number(match[1])) : 0;
    const bz = match ? Math.floor(Number(match[3])) : 0;
    await submitGoal(botId, bx + 80, 70, bz + 80);

    // 等 watchdog stuck → reporter → manager（阈值 8s + 余量）
    await sleep(25_000);

    // 服务端查询本 run 的新 occurrence
    const after = await managerApi("/v1/incidents?failureCode=PATH_NO_PROGRESS");
    const issue = after.body.issues?.[0];
    const newCount = issue?.occurrenceCount ?? 0;
    if (newCount <= aggregateBefore) {
      throw new Error(`run ${run}: no new incident occurrence (count ${newCount} <= baseline ${aggregateBefore})`);
    }
    aggregateBefore = newCount;
    stuckRuns.push({ run, botId, count: newCount });
    log(`run ${run}: STUCK incident aggregated, occurrenceCount=${newCount}`);

    // 停 bot，避免占位
    await managerApi(`/v1/bots/${botId}/stop`, { method: "POST", headers: { "X-Studio-Action": "stop-bot" } });
    await sleep(2_000);
  }

  // 详情断言：元数据（MC version/position/skill/commit）
  const detail = await managerApi("/v1/incidents?failureCode=PATH_NO_PROGRESS");
  const issue = detail.body.issues?.[0];
  const detailResponse = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents/${issue.incidentId}`, {
    headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
  });
  const detailBody = await detailResponse.json();
  const lastOcc = (detailBody.occurrences ?? []).at(-1);
  log(`last occurrence: pos=${JSON.stringify(lastOcc?.position)} skill=${lastOcc?.skillId} mc=${lastOcc?.minecraftVersion} proto=${lastOcc?.protocolVersion} commit=${lastOcc?.gitCommit} session=${lastOcc?.sessionId}`);
  const metaOk = lastOcc?.minecraftVersion != null && lastOcc?.position != null && lastOcc?.skillId != null;

  // 持久化重启校验：直接读 manager 的 incidents.json
  const fs = await import("node:fs");
  const persisted = JSON.parse(fs.readFileSync(join(E2E_DIR, "..", "..", "..", "runtime-data", "incidents.json"), "utf8"));
  const persistedIssue = (persisted.issues ?? []).find((candidate) => candidate.incidentId === issue.incidentId);
  log(`persisted on disk: ${persistedIssue ? `count=${persistedIssue.occurrenceCount}` : "MISSING"}`);

  return {
    stuckRuns,
    finalCount: issue?.occurrenceCount,
    incidentId: issue?.incidentId,
    metaOk,
    persistedOk: Boolean(persistedIssue),
  };
});

log(`=== GOAL CHAIN RESULT: ${JSON.stringify(result)}`);
const pass = result.stuckRuns.length === RUNS && result.metaOk && result.persistedOk;
log(`=== GOAL CHAIN: ${pass ? "PASS" : "FAIL"} ===`);
process.exit(pass ? 0 : 1);
