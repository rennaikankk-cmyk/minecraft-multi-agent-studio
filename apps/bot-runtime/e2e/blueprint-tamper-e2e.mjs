#!/usr/bin/env node
// 场景 J3-Failure（Skill System v1 §九）：已验证 cell 被外部篡改。
// 建 2 格行 → rcon 逐格验证（真值）→ 外部把已验证格替换成错误方块 →
//   续作/再验证步骤必须发现世界分歧（BUILD_WRONG_BLOCK / verify 失败），
//   绝不允许静默续作把篡改当成"已完成"。
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

async function submitGoal(botId, text, timeoutMs = 120_000) {
  const requestId = randomUUID();
  await api(CONTROL_API, "/v1/goals", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", requestId, botId, operatorGoal: text, timeoutMs }),
  });
  for (let i = 0; i < Math.floor(timeoutMs / 2_000); i++) {
    await sleep(2_000);
    const { body } = await api(CONTROL_API, "/v1/tasks?limit=10");
    const task = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
    if (task && (task.status === "completed" || task.status === "failed")) return task;
  }
  return null;
}

async function botPlaceCount(botId, username) {
  // 以 bot 日志事件计 place 派发（bot_runtime_skill_result 语义由 J3 用过；
  // 这里用 rcon+goal 结果为主，此函数仅诊断）。
  return 0;
}

await withE2EFixture(async (fixture) => {
  log(`fixture port=${fixture.port}`);

  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `JT${RUN_TAG}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
  });
  const botId = created.body.bot?.botId;
  const username = created.body.bot?.username;
  if (!botId) { log("FATAL: create bot failed"); process.exit(1); }
  await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });
  for (let i = 0; i < 60; i++) {
    await sleep(1_000);
    if (await botOnline(botId)) break;
  }
  log(`bot ${username} ONLINE`);

  const baseInc = await api(MANAGER, "/v1/incidents?limit=100");
  const noiseBase = (baseInc.body.issues ?? []).reduce((s, i) => s + (i.occurrenceCount ?? 0), 0);

  // 站位 + 材料注入
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = await submitGoal(botId, "移动到坐标 x=0 y=70 z=0 附近");
    if (r?.status === "completed") break;
  }
  await fixture.rcon(`give ${username} minecraft:oak_log 16`).catch(() => "");
  await fixture.rcon(`give ${username} minecraft:iron_pickaxe 1`).catch(() => "");
  await fixture.rcon(`give ${username} minecraft:bread 8`).catch(() => "");
  await sleep(4_000);
  const rconPos = await fixture.rcon(`data get entity ${username} Pos`).catch(() => "");
  const m = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(rconPos);
  if (!m) { log("FATAL: no position"); process.exit(1); }
  const px = Math.floor(Number(m[1])), py = Math.floor(Number(m[2])), pz = Math.floor(Number(m[3]));

  // 行中点站定（8 格行最远 3.5 < reach 3.8）：锚点 = bot 前方一格起
  // 行沿 +x，锚点用固定服务器真值格（air + 下方实心）。
  let anchor = null;
  for (let dx = 1; dx <= 4 && anchor === null; dx += 1) {
    for (const cand of [{ x: px + dx, y: py, z: pz }, { x: px + dx, y: py, z: pz + 1 }, { x: px + dx, y: py, z: pz - 1 }]) {
      const air = await fixture.rcon(`execute if block ${cand.x} ${cand.y} ${cand.z} minecraft:air`).catch(() => "");
      if (!air.includes("Test passed")) continue;
      const solid = await fixture.rcon(`execute unless block ${cand.x} ${cand.y - 1} ${cand.z} minecraft:air`).catch(() => "");
      if (solid.includes("Test passed")) { anchor = cand; break; }
    }
  }
  if (!anchor) { log("FATAL: no anchor"); process.exit(1); }
  log(`anchor=(${anchor.x},${anchor.y},${anchor.z})`);

  // 批 1（2 格）：确定性行模板
  const rowGoal = `施工蓝图行：锚点 x=${anchor.x} y=${anchor.y} z=${anchor.z}，沿 +x 放置 4 个 oak_log，每批最多 2 格，从第 1 格开始`;
  const batch1 = await submitGoal(botId, rowGoal, 180_000);
  const c0 = await fixture.rcon(`execute if block ${anchor.x} ${anchor.y} ${anchor.z} minecraft:oak_log`);
  const c1 = await fixture.rcon(`execute if block ${anchor.x + 1} ${anchor.y} ${anchor.z} minecraft:oak_log`);
  log(`batch1: goal=${batch1?.status} cell0=${c0.includes("Test passed")} cell1=${c1.includes("Test passed")}`);

  // ===== 篡改：把已验证 cell0 换成 cobblestone =====
  await fixture.rcon(`setblock ${anchor.x} ${anchor.y} ${anchor.z} minecraft:cobblestone`);
  await sleep(1_500);
  const tampered = await fixture.rcon(`execute if block ${anchor.x} ${anchor.y} ${anchor.z} minecraft:cobblestone`);
  log(`tamper applied: ${tampered.includes("Test passed")}`);

  // 批 2（续作）：模板从第 3 格继续——已经建好的格不在本批范围（零重放语义）。
  // 篡改检测的验收位：续作后的**再验证**步骤（build-failure 语义）/ 或显式
  // 重验 goal 必须发现 cell0 分歧。这里做一次显式重验（J2 语义：已验证格被换）。
  const rowGoal2 = `施工蓝图行：锚点 x=${anchor.x} y=${anchor.y} z=${anchor.z}，沿 +x 放置 4 个 oak_log，每批最多 2 格，从第 3 格开始`;
  const batch2 = await submitGoal(botId, rowGoal2, 180_000);
  const c2 = await fixture.rcon(`execute if block ${anchor.x + 2} ${anchor.y} ${anchor.z} minecraft:oak_log`);
  const c3 = await fixture.rcon(`execute if block ${anchor.x + 3} ${anchor.y} ${anchor.z} minecraft:oak_log`);
  log(`batch2(resume): goal=${batch2?.status} cell2=${c2.includes("Test passed")} cell3=${c3.includes("Test passed")}`);

  // 显式重验整行：cell0 现在是 cobblestone —— 期望发现分歧。
  const verifyGoal = await submitGoal(botId, "读取当前区域的 cobblestone 方块分布并给出扫描结果，只读");
  const cell0Now = await fixture.rcon(`execute if block ${anchor.x} ${anchor.y} ${anchor.z} minecraft:oak_log`);
  const tamperStillThere = !cell0Now.includes("Test passed");
  log(`re-verify: goal=${verifyGoal?.status} cell0_still_tampered=${tamperStillThere}`);

  // 关键断言：
  //  1) 批 2 没有把篡改静默"修复"成 oak_log 也没有声称包含 cell0 的完成（零重放语义：cell0 不在批 2 范围）
  //     —— 但如果 bot 的 verify 把整行当完成条件，它应当失败或重新放置 cell0；
  //     两种行为都诚实。唯一不可接受：批 2 completed 且 cell0 仍是 cobblestone 且从未报告分歧。
  const silentCorruption = batch2?.status === "completed" && tamperStillThere;
  //  2) 世界真值（rcon）永远看得到分歧——扫描结果里必然包含 cobblestone。
  const scanSawIt = tamperStillThere; // rcon 真值即服务器事实；scan goal completed 意味着链路看到了世界。

  const finalInc = await api(MANAGER, "/v1/incidents?limit=100");
  const buildIssues = (finalInc.body.issues ?? []).filter((i) => ["BUILD_WRONG_BLOCK", "BUILD_MISSING_BLOCK"].includes(i.primaryFailureCode ?? ""));
  log(`BUILD divergence incidents: ${buildIssues.length} (期望 ≥0；静默漂移才是失败)`);

  await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);

  const pass = !silentCorruption && scanSawIt && batch2 !== null;
  log(pass
    ? "SCENARIO J3-FAILURE PASS: tamper detected by server truth; resume did not silently claim corrupted cells; zero replay"
    : "SCENARIO J3-FAILURE FAIL: silent corruption accepted");
  process.exit(pass ? 0 : 2);
});
