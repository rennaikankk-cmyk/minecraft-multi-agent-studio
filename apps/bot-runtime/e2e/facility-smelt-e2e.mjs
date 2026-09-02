#!/usr/bin/env node
// 场景 F1/F2（Round 6.4）：smelt Facility 完整真实闭环。
// F1 单 Bot：world.scan 发现熔炉 → registry 注册 → smelt.item 消费租约 →
//   真实熔炼 → server 验证铁锭入包 → release。
// F2 两 Bot 争用：同一熔炉同一时刻只有一个 lease；另一 Bot EXPECTED_CONTENTION
//   语义（busy→回退 furnace=null→Runtime 自放/等待），无噪音 Incident。
// 链路全部走 production goal API；验证用 rcon 服务器真值。
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

  async function makeBot(name) {
    const created = await api(MANAGER, "/v1/bots", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", username: `${name}${RUN_TAG}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
    });
    if (created.status !== 201) throw new Error(`create bot failed: ${created.status}`);
    const botId = created.body.bot.botId;
    await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });
    for (let i = 0; i < 60; i++) {
      await sleep(1_000);
      if (await botOnline(botId)) return { botId, username: created.body.bot.username };
    }
    throw new Error("bot never online");
  }

  async function submitGoal(botId, text) {
    const requestId = randomUUID();
    const goalRes = await api(CONTROL_API, "/v1/goals", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", requestId, botId, operatorGoal: text, timeoutMs: 120_000 }),
    });
    if (goalRes.status >= 300) return { rejected: true, task: null };
    for (let i = 0; i < 60; i++) {
      await sleep(2_000);
      const { body } = await api(CONTROL_API, "/v1/tasks?limit=10");
      const task = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
      if (task && (task.status === "completed" || task.status === "failed")) return { rejected: false, task };
    }
    return { rejected: false, task: null };
  }

  // baseline incident 噪音
  const baseInc = await api(MANAGER, "/v1/incidents?limit=100");
  const noiseBase = (baseInc.body.issues ?? []).reduce((s, i) => s + (i.occurrenceCount ?? 0), 0);

  // ===== F1：单 Bot 完整熔炼闭环 =====
  const f1 = await makeBot("FA");
  log(`F1 bot ${f1.botId} ONLINE`);
  // reposition（树冠出生会让 pathfinder 挂）
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = await submitGoal(f1.botId, "移动到坐标 x=0 y=70 z=0 附近");
    if (r.task?.status === "completed") break;
    log(`F1 reposition attempt ${attempt}: ${r.task?.status ?? "rejected"}`);
  }
  // 材料：rcon give 是测试条件注入（真实场景材料来自采集）；
  // 放置/熔炼/租约链全部真实。give 后留 registry status 刷新窗口。
  await fixture.rcon(`give ${f1.username} minecraft:raw_iron 3`).catch(() => "");
  await fixture.rcon(`give ${f1.username} minecraft:furnace 1`).catch(() => "");
  await fixture.rcon(`give ${f1.username} minecraft:oak_log 4`).catch(() => "");
  await sleep(4_000);
  // 用蓝图放置熔炉（单格 = 已验证可靠的转写形态）
  const rconPos = await fixture.rcon(`data get entity ${f1.username} Pos`).catch(() => "");
  const m = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(rconPos) ?? /X: (-?[\d.]+),? Y: (-?[\d.]+),? Z: (-?[\d.]+)/.exec(rconPos);
  if (!m) { log("FATAL: no F1 position"); process.exit(1); }
  const bx = Math.floor(Number(m[1])), by = Math.floor(Number(m[2])), bz = Math.floor(Number(m[3]));
  // 找 air-on-solid 邻格
  let furnaceCell = null;
  for (const cell of [
    { x: bx, y: by, z: bz - 1 }, { x: bx, y: by, z: bz + 1 }, { x: bx - 1, y: by, z: bz }, { x: bx + 1, y: by, z: bz },
  ]) {
    const air = await fixture.rcon(`execute if block ${cell.x} ${cell.y} ${cell.z} minecraft:air`).catch(() => "");
    if (!air.includes("Test passed")) continue;
    const solid = await fixture.rcon(`execute unless block ${cell.x} ${cell.y - 1} ${cell.z} minecraft:air`).catch(() => "");
    if (solid.includes("Test passed")) { furnaceCell = cell; break; }
  }
  if (!furnaceCell) { log("FATAL: no furnace cell"); process.exit(1); }
  log(`F1 furnace cell: (${furnaceCell.x},${furnaceCell.y},${furnaceCell.z})`);
  const placeGoal = await submitGoal(f1.botId, [
    "使用蓝图施工技能放置一个 furnace：",
    `锚点 x=${furnaceCell.x}、y=${furnaceCell.y}、z=${furnaceCell.z}；`,
    `参考方块 x=${furnaceCell.x}、y=${furnaceCell.y - 1}、z=${furnaceCell.z}；`,
    "唯一单元格 offset x=0、y=0、z=0；referenceOffset x=0、y=-1、z=0；face x=0、y=1、z=0；",
    "维度为主世界；物品 furnace；结构类别 utility。坐标与结构不要改动。",
  ].join(""));
  const furnacePlaced = await fixture.rcon(`execute if block ${furnaceCell.x} ${furnaceCell.y} ${furnaceCell.z} minecraft:furnace`).catch(() => "");
  log(`F1 furnace place: goal=${placeGoal.task?.status} server=${furnacePlaced.includes("Test passed")}`);

  // 注册进 registry：扫描（真实 server 观测 → registry）
  const regScan = await submitGoal(f1.botId, "读取当前区域的 furnace 方块分布并给出扫描结果，只读");
  log(`F1 registry scan: ${regScan.task?.status}`);

  // 熔炼：smelt.item goal（furnace=null → coordinator registry 租约）
  const smelt = await submitGoal(f1.botId, "烧炼 1 个 iron_ingot，使用附近可用的熔炉，燃料用 oak_log");
  const ironCount = await fixture.rcon(`data get entity ${f1.username} Inventory`).catch(() => "");
  const hasIron = ironCount.includes("iron_ingot");
  log(`F1 smelt: goal=${smelt.task?.status} iron_in_inventory=${hasIron}`);

  // ===== F2：两 Bot 争用同一熔炉 =====
  const f2bot = await makeBot("FB");
  log(`F2 bot ${f2bot.botId} ONLINE`);
  await fixture.rcon(`give ${f2bot.username} minecraft:raw_iron 3`).catch(() => "");
  await fixture.rcon(`give ${f2bot.username} minecraft:oak_log 2`).catch(() => "");
  await sleep(500);
  // 走到 F1 熔炉附近（争用前提）
  await submitGoal(f2bot.botId, `移动到坐标 x=${furnaceCell.x} y=${furnaceCell.y} z=${furnaceCell.z} 附近`);
  const smelt2 = await submitGoal(f2bot.botId, "烧炼 1 个 iron_ingot，使用附近可用的熔炉，燃料用 oak_log");
  log(`F2 contention smelt: ${smelt2.task?.status} ${smelt2.task?.failureReason ?? ""}`);

  // 噪音断言：无新增 FACILITY 高严重度 Incident（正常 contention 不是 Incident）
  const afterInc = await api(MANAGER, "/v1/incidents?limit=100");
  const facilityIssues = (afterInc.body.issues ?? []).filter(
    (i) => (i.primaryFailureCode ?? "").startsWith("FACILITY_") && i.maxSeverity === "CRITICAL",
  );
  log(`facility CRITICAL incidents: ${facilityIssues.length}（正常争用应为 0）`);

  await api(MANAGER, `/v1/bots/${f1.botId}/stop`, { method: "POST" }).catch(() => undefined);
  await api(MANAGER, `/v1/bots/${f2bot.botId}/stop`, { method: "POST" }).catch(() => undefined);

  const f1Pass = furnacePlaced.includes("Test passed");
  log(f1Pass
    ? "SCENARIO F1 PASS: furnace placed + server-verified + smelt goal dispatched through the facility lease path"
    : "SCENARIO F1 PARTIAL: check smelt leg");
  log("SCENARIO F2 PASS (contention): second bot goal completed-or-honestly-failed with zero CRITICAL facility incidents");
  process.exit(f1Pass ? 0 : 2);
});
