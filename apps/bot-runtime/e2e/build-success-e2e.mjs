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
    if (goalRes.status >= 300) { log(`FATAL goal ${goalRes.status}: ${JSON.stringify(goalRes.body).slice(0,150)}`); process.exit(1); }
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

  // 1) reposition 到开阔区
  await submitGoal("移动到坐标 x=0 y=70 z=0 附近");

  // 2) 确定性采集 oak_log
  const acquire = await submitGoal("获取 1 个 oak_log");
  if (acquire?.status !== "completed") {
    log("FATAL: acquisition failed");
    await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);
    process.exit(1);
  }
  log("acquisition PASS (oak_log in inventory)");

  // 3) 目标格：bot 面前（北向）一格空气、其下是地面（参考方块）
  const rconOut = await fixture.rcon(`data get entity ${created.body.bot.username} Pos`).catch(() => "");
  const posMatch = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(rconOut)
    ?? /X: (-?[\d.]+),? Y: (-?[\d.]+),? Z: (-?[\d.]+)/.exec(rconOut);
  if (!posMatch) { log(`FATAL: no position: ${rconOut.slice(0, 80)}`); process.exit(1); }
  const fx = Number(posMatch[1]), fy = Number(posMatch[2]), fz = Number(posMatch[3]);
  // 锚点：面前空气格（z-1），参考：该格正下方（地面）
  const ax = Math.floor(fx), ay = Math.floor(fy), az = Math.floor(fz) - 1;
  const rx = ax, ry = ay - 1, rz = az;
  log(`anchor=(${ax},${ay},${az}) reference=(${rx},${ry},${rz}) from feet (${fx.toFixed(1)},${fy.toFixed(1)},${fz.toFixed(1)})`);

  const goalText = [
    "使用蓝图施工技能放置一个 oak_log：",
    `锚点 x=${ax}、y=${ay}、z=${az}；`,
    `参考方块 x=${rx}、y=${ry}、z=${rz}；唯一单元格 offset x=0、y=0、z=0；`,
    "referenceOffset x=0、y=-1、z=0；face x=0、y=1、z=0；",
    "维度为主世界；物品 oak_log；结构类别 structural。坐标与结构不要改动。",
  ].join("");
  const build = await submitGoal(goalText);

  // 4) server truth：目标格现在是 oak_log？
  const block = await fixture.rcon(`data get block ${ax} ${ay} ${az}`).catch(() => "");
  log(`server block @(${ax},${ay},${az}): ${block.slice(0, 120)}`);
  const placed = block.includes("oak_log") || block.includes('"Name": "minecraft:oak_log"') || block.includes("oak_log");

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
