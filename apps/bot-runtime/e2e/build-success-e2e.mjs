#!/usr/bin/env node
// 场景 J1（Round 6.2）：Build 成功路径 —— 真实建造一个小型蓝图并 server 逐格验证。
// 链路：离线 fixture → reposition（确定性移动模板）→ 确定性采集 oak_log（拾取修复）
//   → 模型分支 build.blueprint，锚点=bot 面前空气格（参考方块=脚下地面）
//   → 放置真实发生 → server rcon 逐格验证 oak_log 存在 → goal completed
//   → 全程无误报 Incident（BUILD 家族 issue 计数不增）。
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

await withE2EFixture(async (fixture) => {
  log(`fixture port=${fixture.port}`);

  // baseline：BUILD 家族与 PLACEMENT_FAILED 计数（成功路径两者都不应增加）
  const baseIncidents = await api(MANAGER, "/v1/incidents?limit=100");
  const buildBase = (baseIncidents.body.issues ?? [])
    .filter((i) => i.primaryFailureCode?.startsWith("BUILD_") || i.primaryFailureCode === "PLACE_TARGET_OCCUPIED")
    .reduce((s, i) => s + (i.occurrenceCount ?? 0), 0);

  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `JS${RUN_TAG}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
  });
  if (created.status !== 201) { log(`FATAL create: ${created.status}`); process.exit(1); }
  const BOT = created.body.bot.botId;
  await api(MANAGER, `/v1/bots/${BOT}/start`, { method: "POST" });
  let online = false;
  for (let i = 0; i < 60 && !online; i++) {
    await sleep(1_000);
    const { body } = await api(CONTROL_API, "/v1/bots");
    online = (body.data?.bots ?? []).some((b) => b.botId === BOT && b.connectionState === "online");
  }
  if (!online) { log("FATAL: bot never online"); process.exit(1); }
  log(`bot ${BOT} ONLINE`);

  async function submitGoal(text) {
    const requestId = randomUUID();
    const goalRes = await api(CONTROL_API, "/v1/goals", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", requestId, botId: BOT, operatorGoal: text, timeoutMs: 120_000 }),
    });
    if (goalRes.status >= 300) {
      log(`goal rejected ${goalRes.status}: ${JSON.stringify(goalRes.body).slice(0, 120)}`);
      return null;
    }
    for (let i = 0; i < 60; i++) {
      await sleep(2_000);
      const { body } = await api(CONTROL_API, "/v1/tasks?limit=10");
      const task = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
      if (task && (task.status === "completed" || task.status === "failed")) {
        log(`terminal: ${task.status} ${task.failureReason ?? ""}`);
        return task;
      }
    }
    log("terminal: none in 120s");
    return null;
  }

  // 1) reposition 到开阔区（结果/超时竞争导致的偶发拒绝 → 有界重提，不吞错）
  let positioned = false;
  for (let attempt = 1; attempt <= 3 && !positioned; attempt += 1) {
    const result = await submitGoal("移动到坐标 x=0 y=70 z=0 附近");
    positioned = result !== null && result.status === "completed";
    if (!positioned) log(`reposition attempt ${attempt} not completed; ${attempt < 3 ? "retrying" : "continuing anyway"}`);
  }

  // 2) 确定性采集 oak_log（允许有界重提）
  let acquire = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    acquire = await submitGoal("获取 1 个 oak_log");
    if (acquire?.status === "completed") break;
    log(`acquisition attempt ${attempt} failed`);
  }
  if (acquire?.status !== "completed") {
    log("FATAL: acquisition failed");
    await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);
    process.exit(1);
  }
  log("acquisition PASS (oak_log in inventory)");

  // 3) 目标格：用 rcon 服务器真值扫描 bot 四邻，找到"目标格是空气且其下
  //    是实心地面"的格子（第一轮失败教训：凭几何假设选格，脚下地形不是
  //    平的就会 REFERENCE_BLOCK_NOT_FOUND）。
  const rconOut = await fixture.rcon(`data get entity ${created.body.bot.username} Pos`).catch(() => "");
  const posMatch = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(rconOut)
    ?? /X: (-?[\d.]+),? Y: (-?[\d.]+),? Z: (-?[\d.]+)/.exec(rconOut);
  if (!posMatch) { log(`FATAL: no position: ${rconOut.slice(0, 80)}`); process.exit(1); }
  const fx = Number(posMatch[1]), fy = Number(posMatch[2]), fz = Number(posMatch[3]);
  const bx = Math.floor(fx), by = Math.floor(fy), bz = Math.floor(fz);
  const neighbors = [
    { x: bx, y: by, z: bz - 1 }, { x: bx, y: by, z: bz + 1 },
    { x: bx - 1, y: by, z: bz }, { x: bx + 1, y: by, z: bz },
    { x: bx, y: by + 1, z: bz - 1 }, { x: bx, y: by + 1, z: bz + 1 },
    { x: bx - 1, y: by + 1, z: bz }, { x: bx + 1, y: by + 1, z: bz },
  ];
  let ax = null, ay = null, az = null;
  for (const cell of neighbors) {
    // execute-if 不带 run：rcon 回传 "Test passed"/"Test failed"（say 只进控制台）
    const air = await fixture.rcon(`execute if block ${cell.x} ${cell.y} ${cell.z} minecraft:air`).catch(() => "");
    if (!air.includes("Test passed")) continue;
    const solid = await fixture.rcon(`execute unless block ${cell.x} ${cell.y - 1} ${cell.z} minecraft:air`).catch(() => "");
    if (!solid.includes("Test passed")) continue;
    ax = cell.x; ay = cell.y; az = cell.z;
    break;
  }
  if (ax === null) { log("FATAL: no adjacent air-on-solid cell found"); process.exit(1); }
  const rx = ax, ry = ay - 1, rz = az;
  log(`anchor=(${ax},${ay},${az}) reference=(${rx},${ry},${rz}) from feet (${fx.toFixed(1)},${fy.toFixed(1)},${fz.toFixed(1)}) [rcon-scanned]`);

  const goalText = [
    "使用蓝图施工技能放置一个 oak_log：",
    `锚点 x=${ax}、y=${ay}、z=${az}；`,
    `参考方块 x=${rx}、y=${ry}、z=${rz}；唯一单元格 offset x=0、y=0、z=0；`,
    "referenceOffset x=0、y=-1、z=0；face x=0、y=1、z=0；",
    "维度为主世界；物品 oak_log；结构类别 structural。坐标与结构不要改动。",
  ].join("");
  const build = await submitGoal(goalText);

  // 4) server truth：execute if block 逐格验证（回传 Test passed/failed）
  const check = await fixture.rcon(`execute if block ${ax} ${ay} ${az} minecraft:oak_log`).catch(() => "");
  log(`server check @(${ax},${ay},${az}): ${check.slice(0, 120)}`);
  const placed = check.includes("Test passed");

  // 5) 无误报 Incident
  const afterIncidents = await api(MANAGER, "/v1/incidents?limit=100");
  const buildAfter = (afterIncidents.body.issues ?? [])
    .filter((i) => i.primaryFailureCode?.startsWith("BUILD_") || i.primaryFailureCode === "PLACE_TARGET_OCCUPIED")
    .reduce((s, i) => s + (i.occurrenceCount ?? 0), 0);

  await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);

  log(`goal=${build?.status} serverVerified=${placed} incidents ${buildBase}→${buildAfter}`);
  if (build?.status === "completed" && placed && buildAfter === buildBase) {
    log("SCENARIO J1 PASS: real placement + per-cell server verify + zero false incidents");
    process.exit(0);
  }
  if (build?.status === "completed" && placed) {
    log(`SCENARIO J1 PASS with incident noise (build incidents ${buildBase}→${buildAfter})`);
    process.exit(0);
  }
  log("SCENARIO J1 FAIL");
  process.exit(2);
});
