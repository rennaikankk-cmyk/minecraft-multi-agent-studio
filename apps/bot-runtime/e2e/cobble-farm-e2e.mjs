#!/usr/bin/env node
// 场景 FARM-COBBLE：蓝图文件 DSL 全链路 + 刷石机再生证明。
// 生产路径：蓝图文件 goal（确定性派发）+ 批间移动 goal + journal 建造。
// 测试条件注入（如实标注）：流体（岩浆/水源）用 RCON setblock —— 生产路径
//   的流体放置能力（fluid.place）是已归档缺口；再生证明用服务器真值
//   （setblock air 缺口 → 圆石自动复原 = 生成机制成立）。
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

const REGISTRATION_CLASS_CODES = new Set([
  "BOT_UNAVAILABLE", "PLANNER_BOT_UNAVAILABLE", "PLANNER_REJECTED", "PLANNER_BOT_BUSY",
]);

async function api(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function botOnline(botId) {
  const { body } = await api(CONTROL_API, "/v1/bots");
  return (body.data?.bots ?? []).find((b) => b.botId === botId)?.connectionState === "online";
}

async function submitGoal(botId, text, timeoutMs = 150_000) {
  for (let submission = 0; submission < 4; submission += 1) {
    const requestId = randomUUID();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const res = await api(CONTROL_API, "/v1/goals", {
        method: "POST",
        body: JSON.stringify({ schemaVersion: "1.0", requestId, botId, operatorGoal: text, timeoutMs }),
      });
      if (res.status < 300) break;
      await sleep(10_000);
    }
    for (let i = 0; i < Math.floor(timeoutMs / 2_000); i++) {
      await sleep(2_000);
      const { body } = await api(CONTROL_API, "/v1/tasks?limit=10");
      const task = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
      if (task && (task.status === "completed" || task.status === "failed")) {
        if (task.status === "failed" && REGISTRATION_CLASS_CODES.has(task.failureReason ?? "") && submission < 3) break;
        return task;
      }
    }
  }
  return null;
}

await withE2EFixture(async (fixture) => {
  log(`fixture port=${fixture.port}`);

  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `FC${RUN_TAG}`.slice(0, 16), serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
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

  // 平地 + 材料/工具（铁镐兼消解 TOOL_PROGRESSION；圆石=建材；面包=食物需求）
  await fixture.rcon(`tp ${username} 0 70 0`).catch(() => "");
  await sleep(4_000);
  await fixture.rcon(`give ${username} minecraft:cobblestone 64`).catch(() => "");
  await fixture.rcon(`give ${username} minecraft:iron_pickaxe 1`).catch(() => "");
  await fixture.rcon(`give ${username} minecraft:bread 8`).catch(() => "");
  await sleep(4_000);

  // 锚点区：RCON 填平台（测试条件，与 tp 同类）——出生地形无常绿 5×3 平地（12:35 实测）。
  // 平台 (2..6, 69, -1..1) 石 + 其上 y70-72 清空；锚点=(4,70,0)。
  const ANCHOR_X = 4, ANCHOR_Y = 70, ANCHOR_Z = 0;
  await fixture.rcon(`fill ${ANCHOR_X - 2} ${ANCHOR_Y - 1} ${ANCHOR_Z - 1} ${ANCHOR_X + 2} ${ANCHOR_Y - 1} ${ANCHOR_Z + 1} minecraft:stone`).catch(() => "");
  await fixture.rcon(`fill ${ANCHOR_X - 2} ${ANCHOR_Y} ${ANCHOR_Z - 1} ${ANCHOR_X + 2} ${ANCHOR_Y + 2} ${ANCHOR_Z + 1} minecraft:air`).catch(() => "");
  await sleep(1_500);
  const anchor = { x: ANCHOR_X, y: ANCHOR_Y, z: ANCHOR_Z };
  log(`anchor=(${anchor.x},${anchor.y},${anchor.z}) (RCON-padded platform)`);

  // ===== 批 1：移动到西侧站位 + 蓝图文件 goal（从第 1 格）=====
  let g = await submitGoal(botId, `移动到坐标 x=${anchor.x - 1} y=${anchor.y} z=${anchor.z + 2} 附近`, 120_000);
  log(`move staging1: ${g?.status ?? "timedOut"}`);
  g = await submitGoal(botId, `使用蓝图文件 cobble-generator 施工：锚点 x=${anchor.x} y=${anchor.y} z=${anchor.z}，从第 1 格开始`, 180_000);
  log(`batch1 build: ${g?.status ?? "timedOut"} ${g?.failureReason ?? ""}`);
  const b1 = g?.status === "completed";

  // ===== 批 2：东侧站位 + 从第 16 格 =====
  g = await submitGoal(botId, `移动到坐标 x=${anchor.x + 1} y=${anchor.y} z=${anchor.z + 2} 附近`, 120_000);
  log(`move staging2: ${g?.status ?? "timedOut"}`);
  g = await submitGoal(botId, `使用蓝图文件 cobble-generator 施工：锚点 x=${anchor.x} y=${anchor.y} z=${anchor.z}，从第 16 格开始`, 180_000);
  log(`batch2 build: ${g?.status ?? "timedOut"} ${g?.failureReason ?? ""}`);
  const b2 = g?.status === "completed";

  // ===== 服务器真值：y0 地板 15 格 + y1 墙 10 格 =====
  let placed = 0;
  for (let dx = -2; dx <= 2; dx += 1) {
    for (const dz of [-1, 0, 1]) {
      const r = await fixture.rcon(`execute unless block ${anchor.x + dx} ${anchor.y} ${anchor.z + dz} minecraft:air`).catch(() => "");
      if (r.includes("Test passed")) placed += 1;
    }
  }
  let placedWalls = 0;
  for (const dx of [-2, -1, 0, 1, 2]) {
    for (const dz of [-1, 1]) {
      const r = await fixture.rcon(`execute unless block ${anchor.x + dx} ${anchor.y + 1} ${anchor.z + dz} minecraft:air`).catch(() => "");
      if (r.includes("Test passed")) placedWalls += 1;
    }
  }
  log(`structure truth: floor=${placed}/15 walls=${placedWalls}/10`);

  // ===== 流体注入（测试条件，RCON；生产路径=fluid.place 缺口）=====
  await fixture.rcon(`setblock ${anchor.x - 2} ${anchor.y + 1} ${anchor.z} minecraft:lava`).catch(() => "");
  await fixture.rcon(`setblock ${anchor.x + 2} ${anchor.y + 1} ${anchor.z} minecraft:water`).catch(() => "");
  // ===== 再生证明：缺口应生成圆石（服务器真值）=====
  let cobbleFormed = false;
  for (let i = 0; i < 10 && !cobbleFormed; i += 1) {
    await sleep(2_000);
    const r = await fixture.rcon(`execute if block ${anchor.x} ${anchor.y + 1} ${anchor.z} minecraft:cobblestone`).catch(() => "");
    if (r.includes("Test passed")) cobbleFormed = true;
  }
  log(`cobble formed at gap: ${cobbleFormed}`);
  // 破坏后再生（机制证明）：setblock air → 应自动复原
  let regenerated = false;
  if (cobbleFormed) {
    await fixture.rcon(`setblock ${anchor.x} ${anchor.y + 1} ${anchor.z} minecraft:air`).catch(() => "");
    for (let i = 0; i < 8 && !regenerated; i += 1) {
      await sleep(2_000);
      const r = await fixture.rcon(`execute if block ${anchor.x} ${anchor.y + 1} ${anchor.z} minecraft:cobblestone`).catch(() => "");
      if (r.includes("Test passed")) regenerated = true;
    }
  }
  log(`regenerated after break: ${regenerated}`);

  await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);

  const pass = b1 && b2 && placed === 15 && placedWalls === 10 && cobbleFormed && regenerated;
  log(pass
    ? "SCENARIO FARM-COBBLE PASS: blueprint-file DSL build (2 batches, server-verified 25 cells) + cobble generation + regeneration (server truth; fluids RCON-bootstrapped, labeled)"
    : "SCENARIO FARM-COBBLE FAIL/PARTIAL (see logs above)");
  process.exit(pass ? 0 : 2);
});
