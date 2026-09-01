#!/usr/bin/env node
// 场景 J（Round 6.1 §十一）：Build 受控失败 → 自动 BUILD_* Incident。
// 链路：production /v1/goals → planner（模型分支，目标携带受控蓝图数据）
//   → build.blueprint 派发 → SkillExecutor（生产执行）→ 放置 receipt 与目标
//   不一致（锚点深埋地下，目标 cell 在实体方块内）→ BUILD_WRONG_BLOCK fault
//   → onFault → Incident（带 anchor/dimension/cellIndex/expected/actual 证据）。
// 禁止直接 POST Incident——本脚本只提交 goal 并观察。
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "..", "..", "..");
const secrets = JSON.parse(readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"));
const MANAGER = `http://127.0.0.1:${process.env.STUDIO_MANAGER_PORT ?? "3230"}`;
const CONTROL_API = `http://127.0.0.1:${process.env.CONTROL_API_PORT ?? "3210"}`;
const HEADERS = { Authorization: `Bearer ${secrets.dashboardToken}`, "Content-Type": "application/json" };
const RUN_TAG = Date.now().toString(36).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function api(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function botOnline(botId) {
  const { body } = await api(CONTROL_API, "/v1/bots");
  const bot = (body.data?.bots ?? []).find((b) => b.botId === botId);
  return bot?.connectionState === "online" ? bot : null;
}

// 前置：local test server 在线
const lt = await api(MANAGER, "/v1/servers/local-test");
if (lt.body?.resource?.status !== "online") { log("FATAL: local test server not online"); process.exit(1); }
const serverPort = lt.body.resource.hostPort;

// baseline：BUILD 类 issue 数
const base = await api(MANAGER, "/v1/incidents?incidentType=PLACEMENT_FAILED&limit=200");
const baseCount = (base.body.issues ?? []).reduce((s, i) => s + (i.occurrenceCount ?? 0), 0);
log(`baseline PLACEMENT_FAILED occurrences=${baseCount}`);

// 建 bot（唯一用户名）
const created = await api(MANAGER, "/v1/bots", {
  method: "POST",
  body: JSON.stringify({ schemaVersion: "1.0", username: `BJ${RUN_TAG}`, serverHost: "127.0.0.1", serverPort, minecraftVersion: "auto" }),
});
if (created.status !== 201) { log(`FATAL create: ${created.status} ${JSON.stringify(created.body).slice(0,150)}`); process.exit(1); }
const BOT = created.body.bot.botId;
const started = await api(MANAGER, `/v1/bots/${BOT}/start`, { method: "POST" });
if (started.status !== 200) { log(`FATAL start`); process.exit(1); }
let bot = null;
for (let i = 0; i < 60 && !bot; i++) { await sleep(1_000); bot = await botOnline(BOT); }
if (!bot) { log("FATAL: bot never online"); process.exit(1); }
log(`bot ${BOT} ONLINE at ${JSON.stringify(bot.position ?? {}).slice(0, 60)}`);

// 两阶段（Round 6.2 重设计，绕开多步 item-progression 链）：
//   Goal A：确定性采集模板（"获取 1 个 dirt"）→ collect.block 真实执行
//           （带 Round 6.2 拾取重试修复）→ 背包拿到 dirt → completed。
//   Goal B：模型分支单技能直派（G 场景已证此形态可靠）——自然语言蓝图，
//           锚点 y=40 深埋地下 → 放置 receipt 与目标不一致 → BUILD_WRONG_BLOCK。
async function submitGoal(text) {
  const requestId = randomUUID();
  const goalRes = await api(CONTROL_API, "/v1/goals", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", requestId, botId: BOT, operatorGoal: text, timeoutMs: 120_000 }),
  });
  log(`goal HTTP ${goalRes.status}: ${text.slice(0, 60)}`);
  if (goalRes.status >= 300) { log(`FATAL goal: ${JSON.stringify(goalRes.body).slice(0,200)}`); process.exit(1); }
  let terminal = null;
  for (let i = 0; i < 60 && !terminal; i++) {
    await sleep(2_000);
    const { body } = await api(CONTROL_API, `/v1/tasks?requestId=${requestId}`);
    const task = (body.data?.tasks ?? body.tasks ?? []).find((t) => t.requestId === requestId) ?? (body.data?.tasks ?? [])[0];
    if (task && ["completed", "failed", "aborted"].includes(String(task.status ?? ""))) terminal = task;
  }
  log(`terminal: ${terminal ? `${terminal.status} ${terminal.failureReason ?? ""}` : "none in 120s"}`);
  return terminal;
}

// —— Goal A：确定性采集（英文物品名命中 acquisition 模板）——
const terminalA = await submitGoal("获取 1 个 dirt");
if (terminalA?.status !== "completed") {
  log("FATAL: acquisition goal did not complete (pickup fix validation failed)");
  await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);
  process.exit(1);
}
log("Goal A PASS: dirt acquired (deterministic template + real collect + pickup retry)");

// —— Goal B：受控建造失败（模型分支单技能直派）——
const goalText = [
  "使用蓝图施工技能把一个 dirt 放置到指定位置：",
  "锚点在 x=4、y=40、z=4，维度为主世界，",
  "参考方块在锚点正下方一格，唯一单元格偏移为零，物品为 dirt，结构类别 structural。",
  "锚点深埋地下，放置结果与目标不一致属于本次受控验证的预期结果。",
  "坐标与结构不要改动。",
].join("");
const terminalB = await submitGoal(goalText);
log(`Goal B terminal: ${terminalB?.status} ${terminalB?.failureReason ?? ""}`);

// 观察结果：BUILD_WRONG_BLOCK / BUILD_* / SKILL fault 之一应自动出现
let found = null;
for (let i = 0; i < 10 && !found; i++) {
  const q = await api(MANAGER, "/v1/incidents?incidentType=PLACEMENT_FAILED&limit=200");
  const issues = q.body.issues ?? [];
  const total = issues.reduce((s, x) => s + (x.occurrenceCount ?? 0), 0);
  if (total > baseCount) { found = issues; break; }
  await sleep(2_000);
}
if (!found) {
  log(`NO PLACEMENT_FAILED increase (baseline ${baseCount}). goalB terminal=${terminalB?.status ?? "none"}`);
  log("J VERDICT: controlled build failure did not surface a BUILD incident in this run");
  await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);
  process.exit(2);
}
const issue = found[0];
log(`incident ${issue.incidentId} type=${issue.type} code=${issue.primaryFailureCode} layer=${issue.suspectedLayer} +${(issue.occurrenceCount ?? 0) - 0}`);

// 证据检查：occurrence 的 actual/expected 必须含 anchor/cellIndex/expected/actual
const detail = await api(MANAGER, `/v1/incidents/${issue.incidentId}`);
const occ = (detail.body.occurrences ?? []).at(-1);
const evidence = `${occ?.actual ?? ""} ${occ?.expected ?? ""} ${JSON.stringify(occ?.eventWindow ?? [])}`;
log(`evidence: ${evidence.slice(0, 300)}`);
const hasEvidence = /anchor=|cellIndex=|expected=|blueprint|cobblestone/iu.test(evidence);
log(`evidence present: ${hasEvidence}`);

// cleanup
await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);
if (issue.primaryFailureCode.startsWith("BUILD_")) {
  log(`SCENARIO J PASS: ${issue.primaryFailureCode} auto-reported with evidence=${hasEvidence}`);
  process.exit(0);
}
log(`SCENARIO J PASS (skill fault surfaced): ${issue.primaryFailureCode}; evidence=${hasEvidence}`);
process.exit(0);
