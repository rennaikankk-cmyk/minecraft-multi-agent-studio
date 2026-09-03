#!/usr/bin/env node
// L5 — Manual goal preempts autonomy, then policy correctly recovers.
// 前置：studio 以 STUDIO_AUTONOMY_ENABLED=1 启动（interval 调小加速 tick）。
// 断言：
//   1) bot 上线后 autonomy director 自主派发任务（currentTask 出现 active 任务）
//   2) 手动 goal 提交 → autonomy run 被 manual_control_requested 打断（coordinator 日志）
//   3) 手动 goal completed
//   4) 手动 goal 终态后 autonomy 恢复：出现新的 active 任务且 taskId ≠ 手动 taskId
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
const COORD_LOG = path.join(ROOT, "runtime-data", "logs", "coordinator.log");
const HEADERS = { Authorization: `Bearer ${secrets.dashboardToken}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const ACTIVE = new Set(["queued", "assigned", "running", "blocked", "waiting", "paused"]);

async function api(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function botState(botId) {
  // currentTask 只在详情端点：列表端点的 summary 投影不含任务字段。
  const { body } = await api(CONTROL_API, `/v1/bots/${botId}`);
  return body.data?.bot ?? null;
}

async function currentTaskOf(botId) {
  const b = await botState(botId);
  return b?.currentTask ?? null;
}

async function waitTaskTerminal(requestId, timeoutMs) {
  for (let i = 0; i < Math.floor(timeoutMs / 2000); i++) {
    await sleep(2000);
    const { body } = await api(CONTROL_API, "/v1/tasks?limit=50");
    const t = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
    if (t && !ACTIVE.has(t.status)) return t;
  }
  return null;
}

const RESULTS = {};

await withE2EFixture(async (fixture) => {
  log(`fixture port=${fixture.port}`);
  const logStartBytes = readFileSync(COORD_LOG).byteLength;

  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `L5A${Date.now().toString(36).slice(-5)}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
  });
  const botId = created.body.bot?.botId;
  await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if ((await botState(botId))?.connectionState === "online") break;
  }
  log(`bot online: ${botId}`);

  // (1) 等 autonomy 自主派发（未提交任何手动 goal，active currentTask 即自主任务）
  let autoTask = null;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const t = await currentTaskOf(botId);
    if (t && ACTIVE.has(t.status)) { autoTask = t; break; }
  }
  RESULTS.autonomyTaskSeen = autoTask !== null;
  RESULTS.autonomyTaskTitle = autoTask?.title ?? null;
  log(`autonomy task: ${autoTask ? `${autoTask.taskId} "${autoTask.title}" (${autoTask.status})` : "NOT SEEN"}`);

  // (2) 提交手动 goal（应抢占 autonomy）
  const goalId = randomUUID();
  const submit = await api(CONTROL_API, "/v1/goals", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", requestId: goalId, botId, operatorGoal: "移动到坐标 x=2 y=70 z=2 附近", timeoutMs: 120_000 }),
  });
  RESULTS.manualSubmitStatus = submit.status;
  RESULTS.manualSubmitAction = submit.body?.data?.action ?? null;
  log(`manual goal submitted: HTTP ${submit.status} action=${RESULTS.manualSubmitAction}`);

  // (3) 手动 goal 终态：同步完成（200+skill_result）直接成立；
  //     202/waiting 走任务轮询到终态。
  let manualTask = null;
  if (submit.status === 200 && RESULTS.manualSubmitAction === "skill_result") {
    manualTask = { status: "completed" };
  } else {
    manualTask = await waitTaskTerminal(goalId, 180_000);
  }
  RESULTS.manualTaskStatus = manualTask?.status ?? "not_found";
  log(`manual goal terminal: ${manualTask?.status}`);

  // (4) 等 autonomy 恢复：新的 active 任务且 ≠ 手动 taskId
  let resumed = null;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const t = await currentTaskOf(botId);
    if (t && ACTIVE.has(t.status) && t.taskId !== goalId) { resumed = t; break; }
  }
  RESULTS.autonomyResumed = resumed !== null;
  RESULTS.resumedTaskTitle = resumed?.title ?? null;
  RESULTS.resumedAfterManual = resumed !== null && autoTask !== null && resumed.taskId !== autoTask.taskId;
  log(`autonomy resumed: ${resumed ? `${resumed.taskId} "${resumed.title}"` : "NOT RESUMED"}`);

  // 日志证据：manual_control_requested 打断了自主 run
  const tail = readFileSync(COORD_LOG).subarray(logStartBytes).toString("utf8");
  RESULTS.preemptEvidenceInLog = tail.includes("manual_control_requested");
  RESULTS.needSelectedInLog = tail.includes("coordinator_autonomous_need_selected");

  RESULTS.passed =
    RESULTS.autonomyTaskSeen &&
    (submit.status === 200 || submit.status === 202) &&
    RESULTS.manualTaskStatus === "completed" &&
    RESULTS.autonomyResumed &&
    RESULTS.preemptEvidenceInLog;

  await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);
  await sleep(3000);

  console.log("\n========== L5 RESULTS ==========");
  console.log(JSON.stringify(RESULTS, null, 2));
  console.log(`L5: ${RESULTS.passed ? "PASS" : "FAIL"}`);
  process.exitCode = RESULTS.passed ? 0 : 2;
});
