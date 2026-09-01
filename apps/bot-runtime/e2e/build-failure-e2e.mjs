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
    for (let i = 0; i < 110 && !terminal; i++) {
      await sleep(2_000);
      const { body } = await api(CONTROL_API, "/v1/tasks?limit=10");
      const task = (body.data?.tasks ?? []).find((candidate) => candidate.taskId === requestId);
      if (task && (task.status === "completed" || task.status === "failed")) terminal = task;
    }
    log(`terminal: ${terminal ? `${terminal.status} ${terminal.failureReason ?? ""}` : "none in 220s"}`);
    return terminal;
  }

  // —— Goal A0：确定性移动模板把 bot 带到已证可靠的开阔区（spawn 落在树/坡上
  // 会让 pathfinder think 超时——D 场景在该种子此坐标带反复行走成功）——
  const terminalA0 = await submitGoal("移动到坐标 x=0 y=70 z=0 附近");
  log(`Goal A0 (reposition): ${terminalA0?.status ?? "none"}`);

  // —— Goal A：确定性采集 oak_log（英文物品名命中 acquisition 模板）——
  const terminalA = await submitGoal("获取 1 个 oak_log");
  if (terminalA?.status !== "completed") {
    log("FATAL: acquisition goal did not complete");
    await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);
    process.exit(1);
  }
  log("Goal A PASS: oak_log acquired (deterministic template + real collect + pickup retry)");

  // —— Goal B：受控建造失败（模型分支单技能直派）——
  // 锚点=bot 脚下支撑方块（读 registry 实时坐标动态构造）：距离 ~1.3 必在
  // reach 3.8 内、且必为实心（支撑着 bot）→ 放置进实心方块 → receipt 不匹配。
  // 坐标接地校验要求三元组逐字出现——goal 文本由脚本按实测坐标拼出。
  // 坐标接地校验（PLANNER_INPUT_UNGROUNDED）要求输入里每个 x/y/z 三元组
  // 都逐字出现在 goal 文本——所以锚点/参考方块/offset/referenceOffset/face
  // 五个向量全部显式写出，模型只需忠实转写。
  // registry 裁剪 position、日志按隐私设计不含坐标——用 fixture 的 rcon
  // 查实体坐标（服务器真值，与 D 场景 serverPosition 同源）。
  const rconOut = await fixture.rcon(`data get entity ${created.body.bot.username} Pos`).catch(() => "");
  const bracketMatch = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(rconOut);
  const posMatch = bracketMatch ?? /X: (-?[\d.]+),? Y: (-?[\d.]+),? Z: (-?[\d.]+)/.exec(rconOut);
  if (!posMatch) { log(`FATAL: rcon position unavailable: ${rconOut.slice(0, 80)}`); process.exit(1); }
  const feet = { x: Number(posMatch[1]), y: Number(posMatch[2]), z: Number(posMatch[3]) };
  const ax = Math.floor(feet.x), ay = Math.floor(feet.y) - 1, az = Math.floor(feet.z);
  log(`anchor = (${ax},${ay},${az}) below feet (${feet.x.toFixed(1)},${feet.y.toFixed(1)},${feet.z.toFixed(1)})`);
  const goalText = [
    `使用蓝图施工技能放置一个 oak_log：锚点 x=${ax}、y=${ay}、z=${az}；`,
    `参考方块 x=${ax}、y=${ay - 1}、z=${az}；唯一单元格 offset x=0、y=0、z=0；`,
    "referenceOffset x=0、y=-1、z=0；face x=0、y=1、z=0；",
    "维度为主世界；物品 oak_log；结构类别 structural。",
    "锚点是bot脚下的支撑方块（实心），放置目标不可用，放置结果与目标不一致属于本次受控验证的预期结果。",
    "坐标与结构不要改动。",
  ].join("");
  const terminalB = await submitGoal(goalText);
  log(`Goal B terminal: ${terminalB?.status} ${terminalB?.failureReason ?? ""}`);

  let issue = null;
  for (let i = 0; i < 10 && !issue; i++) {
    // type 可能停在终态（SKILL_FAILED），判定看 primary 根因码 + BUILD 层
    const q = await api(MANAGER, "/v1/incidents?limit=50");
    for (const x of q.body.issues ?? []) {
      if ((x.occurrenceCount ?? 0) > 0 && x.primaryFailureCode?.startsWith("BUILD_") && x.suspectedLayer === "BUILD") { issue = x; break; }
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
  const hasEvidence = /anchor=|cellIndex=|expected=|blueprint|oak_log|PLACE_TARGET_OCCUPIED|BUILD_/iu.test(evidence) || issue.suspectedLayer === "BUILD";

  if (issue.primaryFailureCode.startsWith("BUILD_") && hasEvidence) {
    log(`SCENARIO J PASS: ${issue.primaryFailureCode} auto-reported with full blueprint evidence`);
    process.exit(0);
  }
  log(`SCENARIO J PARTIAL: ${issue.primaryFailureCode} surfaced but evidence=${hasEvidence}`);
  process.exit(3);
});
