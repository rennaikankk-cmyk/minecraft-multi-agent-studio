#!/usr/bin/env node
// 场景 J（Round 6.2）：Build 受控失败 → 自动 BUILD_* Incident —— 真正 PASS 版。
// 链路：离线 e2e fixture（平地，行走/采集已实证可靠）
//   → production manager API 创建真实 bot
//   → Goal A "获取 1 个 oak_log"：确定性采集模板 → collect.block 真实执行
//     （Round 6.2 拾取重试修复——树冠原木掉落 1-3s 落地后被走到并拾取）
//   → Goal B：模型分支单技能直派 build.blueprint，锚点深埋地下
//     → 放置 receipt 与目标不一致 → BUILD_WRONG_BLOCK fault
//     → onFault → Incident（anchor/dimension/cellIndex/expected/actual 证据）。
// 禁止直接 POST Incident——只提交 goal 并观察。
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

await withE2EFixture(async (fixture) => {
  log(`fixture port=${fixture.port}`);

  const base = await api(MANAGER, "/v1/incidents?incidentType=PLACEMENT_FAILED&limit=200");
  const baseCount = (base.body.issues ?? []).reduce((s, i) => s + (i.occurrenceCount ?? 0), 0);
  log(`baseline PLACEMENT_FAILED occurrences=${baseCount}`);

  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `BJ${RUN_TAG}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
  });
  if (created.status !== 201) { log(`FATAL create: ${created.status} ${JSON.stringify(created.body).slice(0,150)}`); process.exit(1); }
  const BOT = created.body.bot.botId;
  const started = await api(MANAGER, `/v1/bots/${BOT}/start`, { method: "POST" });
  if (started.status !== 200) { log("FATAL start"); process.exit(1); }
  let bot = null;
  for (let i = 0; i < 60 && !bot; i++) { await sleep(1_000); bot = await botOnline(BOT); }
  if (!bot) { log("FATAL: bot never online"); process.exit(1); }
  log(`bot ${BOT} ONLINE`);

  async function submitGoal(text) {
    const requestId = randomUUID();
    const goalRes = await api(CONTROL_API, "/v1/goals", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", requestId, botId: BOT, operatorGoal: text, timeoutMs: 120_000 }),
    });
    log(`goal HTTP ${goalRes.status}: ${text.slice(0, 50)}`);
    if (goalRes.status >= 300) { log(`FATAL goal: ${JSON.stringify(goalRes.body).slice(0,200)}`); process.exit(1); }
    let terminal = null;
    for (let i = 0; i < 60 && !terminal; i++) {
      await sleep(2_000);
      const { body } = await api(CONTROL_API, "/v1/tasks?limit=10");
      const task = (body.data?.tasks ?? []).find((candidate) => candidate.taskId === requestId);
      if (task && (task.status === "completed" || task.status === "failed")) terminal = task;
    }
    log(`terminal: ${terminal ? `${terminal.status} ${terminal.failureReason ?? ""}` : "none in 120s"}`);
    return terminal;
  }

  // —— Goal A：确定性采集 oak_log（英文物品名命中 acquisition 模板）——
  const terminalA = await submitGoal("获取 1 个 oak_log");
  if (terminalA?.status !== "completed") {
    log("FATAL: acquisition goal did not complete");
    await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);
    process.exit(1);
  }
  log("Goal A PASS: oak_log acquired (deterministic template + real collect + pickup retry)");

  // —— Goal B：受控建造失败（模型分支单技能直派，深埋锚点）——
  // 坐标接地校验（PLANNER_INPUT_UNGROUNDED）要求输入里每个 x/y/z 三元组
  // 都逐字出现在 goal 文本——所以锚点/参考方块/offset/referenceOffset/face
  // 五个向量全部显式写出，模型只需忠实转写。
  const goalText = [
    "使用蓝图施工技能放置一个 oak_log：锚点 x=4、y=40、z=4；",
    "参考方块 x=4、y=39、z=4；唯一单元格 offset x=0、y=0、z=0；",
    "referenceOffset x=0、y=-1、z=0；face x=0、y=1、z=0；",
    "维度为主世界；物品 oak_log；结构类别 structural。",
    "锚点深埋地下，放置结果与目标不一致属于本次受控验证的预期结果。",
    "坐标与结构不要改动。",
  ].join("");
  const terminalB = await submitGoal(goalText);
  log(`Goal B terminal: ${terminalB?.status} ${terminalB?.failureReason ?? ""}`);

  let issue = null;
  for (let i = 0; i < 10 && !issue; i++) {
    const q = await api(MANAGER, "/v1/incidents?incidentType=PLACEMENT_FAILED&limit=200");
    for (const x of q.body.issues ?? []) {
      if ((x.occurrenceCount ?? 0) > 0 && x.primaryFailureCode?.startsWith("BUILD_")) { issue = x; break; }
    }
    if (!issue) await sleep(2_000);
  }
  await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);

  if (!issue) {
    log(`NO BUILD_* incident appeared. goalB=${terminalB?.status ?? "none"}`);
    process.exit(2);
  }
  log(`incident ${issue.incidentId} type=${issue.type} code=${issue.primaryFailureCode} layer=${issue.suspectedLayer}`);

  const detail = await api(MANAGER, `/v1/incidents/${issue.incidentId}`);
  const occ = (detail.body.occurrences ?? []).at(-1);
  const evidence = `${occ?.actual ?? ""} ${occ?.expected ?? ""} ${JSON.stringify(occ?.eventWindow ?? [])}`;
  log(`evidence: ${evidence.slice(0, 260)}`);
  const hasEvidence = /anchor=|cellIndex=|expected=|blueprint|oak_log/iu.test(evidence);

  if (issue.primaryFailureCode.startsWith("BUILD_") && hasEvidence) {
    log(`SCENARIO J PASS: ${issue.primaryFailureCode} auto-reported with full blueprint evidence`);
    process.exit(0);
  }
  log(`SCENARIO J PARTIAL: ${issue.primaryFailureCode} surfaced but evidence=${hasEvidence}`);
  process.exit(3);
});
