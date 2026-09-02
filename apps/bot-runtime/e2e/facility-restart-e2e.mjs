#!/usr/bin/env node
// 场景 F4/F5（Skill System v1 §九）：smelt Facility 可靠性补齐。
// F4 中途重启/reconcile：smelt 派发后硬停 bot → 重启 → 重新派发 →
//   服务器真值断言（iron_ingot 实际入包、raw_iron 实际消耗），诚实记录
//   reconcile 语义（第一次投料是被续用还是被浪费）。
// F5 false-success 拒绝：smelt 进行中 RCON 摧毁熔炉 → 后续 smelt 必须诚实
//   失败/降级，绝不报 completed 而无服务器真值。
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

async function countItem(username, itemId) {
  const raw = await fixture.rcon(`data get entity ${username} Inventory`).catch(() => "");
  let count = 0;
  const re = new RegExp(`(?:id:|"id":"?)minecraft:${itemId}`, "g");
  // NBT 列表按条目计：粗匹配条目数即可（give 数量级小）。
  const matches = raw.match(new RegExp(`minecraft:${itemId}`, "g")) ?? [];
  count = matches.length;
  return { count, raw };
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

let fixture;

await withE2EFixture(async (f) => {
  fixture = f;
  log(`fixture port=${fixture.port}`);

  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `FR${RUN_TAG}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
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

  // 站位（树冠出生会让 pathfinder 挂）
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = await submitGoal(botId, "移动到坐标 x=0 y=70 z=0 附近");
    if (r?.status === "completed") break;
  }
  // 注入材料与熔炉（测试条件注入；放置/熔炼/租约链真实）
  await fixture.rcon(`give ${username} minecraft:raw_iron 5`).catch(() => "");
  await fixture.rcon(`give ${username} minecraft:furnace 2`).catch(() => "");
  await fixture.rcon(`give ${username} minecraft:oak_log 8`).catch(() => "");
  await sleep(4_000);
  const rconPos = await fixture.rcon(`data get entity ${username} Pos`).catch(() => "");
  const m = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(rconPos);
  if (!m) { log("FATAL: no position"); process.exit(1); }
  const bx = Math.floor(Number(m[1])), by = Math.floor(Number(m[2])), bz = Math.floor(Number(m[3]));
  let cell = null;
  for (const c of [{ x: bx, y: by, z: bz - 1 }, { x: bx, y: by, z: bz + 1 }, { x: bx - 1, y: by, z: bz }, { x: bx + 1, y: by, z: bz }]) {
    const air = await fixture.rcon(`execute if block ${c.x} ${c.y} ${c.z} minecraft:air`).catch(() => "");
    if (!air.includes("Test passed")) continue;
    const solid = await fixture.rcon(`execute unless block ${c.x} ${c.y - 1} ${c.z} minecraft:air`).catch(() => "");
    if (solid.includes("Test passed")) { cell = c; break; }
  }
  if (!cell) { log("FATAL: no furnace cell"); process.exit(1); }

  const place = await submitGoal(botId, [
    "使用蓝图施工技能放置一个 furnace：",
    `锚点 x=${cell.x}、y=${cell.y}、z=${cell.z}；`,
    `参考方块 x=${cell.x}、y=${cell.y - 1}、z=${cell.z}；`,
    "唯一单元格 offset x=0、y=0、z=0；referenceOffset x=0、y=-1、z=0；face x=0、y=1、z=0；",
    "维度为主世界；物品 furnace；结构类别 utility。坐标与结构不要改动。",
  ].join(""));
  const placed = await fixture.rcon(`execute if block ${cell.x} ${cell.y} ${cell.z} minecraft:furnace`);
  log(`furnace place: goal=${place?.status} server=${placed.includes("Test passed")}`);
  if (!placed.includes("Test passed")) { log("FATAL: furnace not placed"); process.exit(1); }
  await submitGoal(botId, "读取当前区域的 furnace 方块分布并给出扫描结果，只读");

  // ===== F4：smelt 中途硬停 → 重启 → reconcile =====
  const beforeRaw = await countItem(username, "raw_iron");
  log(`F4 raw_iron before: ${beforeRaw.count}`);
  // 第一次 smelt：不等完成，~8s 后硬停（熔炼中：10s/锭窗口内）
  const firstSmeltPromise = submitGoal(botId, "烧炼 2 个 iron_ingot，使用附近可用的熔炉，燃料用 oak_log", 120_000);
  await sleep(8_000);
  await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);
  await firstSmeltPromise.catch(() => null);
  await sleep(3_000);
  // 重启
  await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });
  for (let i = 0; i < 60; i++) {
    await sleep(1_000);
    if (await botOnline(botId)) break;
  }
  log("F4 bot back ONLINE");
  const second = await submitGoal(botId, "烧炼 2 个 iron_ingot，使用附近可用的熔炉，燃料用 oak_log", 180_000);
  await sleep(4_000);
  const after = await countItem(username, "iron_ingot");
  const rawAfter = await countItem(username, "raw_iron");
  log(`F4 smelt-after-restart: goal=${second?.status} iron=${after.count} raw_iron_consumed=${beforeRaw.count - rawAfter.count}`);
  const f4Pass = second?.status === "completed" && after.count >= 2;
  const f4Honest = second?.status !== null && (second?.status === "completed" || second?.status === "failed");

  // ===== F5：false-success 拒绝（熔炉被外部摧毁）=====
  await fixture.rcon(`setblock ${cell.x} ${cell.y} ${cell.z} minecraft:air`);
  await sleep(1_000);
  await fixture.rcon(`give ${username} minecraft:raw_iron 2`).catch(() => "");
  await sleep(3_000);
  const f5 = await submitGoal(botId, "烧炼 1 个 iron_ingot，使用附近可用的熔炉，燃料用 oak_log", 120_000);
  await sleep(2_000);
  const ironAfterF5 = await countItem(username, "iron_ingot");
  log(`F5 smelt-after-furnace-destroyed: goal=${f5?.status} iron_delta=${ironAfterF5.count - after.count}`);
  // 假成功 = 报 completed 但 iron 没有增加。
  const f5Pass = f5 !== null && !(f5.status === "completed" && ironAfterF5.count <= after.count);

  const finalInc = await api(MANAGER, "/v1/incidents?limit=100");
  const newCritical = (finalInc.body.issues ?? []).filter((i) => i.maxSeverity === "CRITICAL" && !["FACILITY_VERIFY_FAILED", "BUILD_WRONG_BLOCK"].includes(i.primaryFailureCode ?? ""));
  log(`incidents delta=${(finalInc.body.issues ?? []).reduce((s, i) => s + (i.occurrenceCount ?? 0), 0) - noiseBase} unexpected CRITICAL=${newCritical.length}`);

  await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);
  log(`SCENARIO F4 ${f4Pass ? "PASS" : f4Honest ? "PARTIAL(honest terminal)" : "FAIL"}: restart-reconcile smelt`);
  log(`SCENARIO F5 ${f5Pass ? "PASS" : "FAIL"}: no false-success after furnace destroyed`);
  process.exit(f4Pass && f5Pass ? 0 : f5Pass ? 2 : 3);
});
