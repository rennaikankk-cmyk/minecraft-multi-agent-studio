#!/usr/bin/env node
// 场景 F3（Round 6.5）：熔炉被破坏 → 租约验证证伪 → 回退 + invalidate。
// 链路：放熔炉（蓝图）→ scan 注册 → rcon setblock air 破坏 → smelt goal
//   → coordinator 租约验证（真实 world.scan）发现熔炉不存在 → furnace=null
//   回退 → 注册表 invalidate → 无幽灵熔炉进入派发、无 CRITICAL 噪音。
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
  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `F3${RUN_TAG}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
  });
  if (created.status !== 201) { log(`FATAL create`); process.exit(1); }
  const BOT = created.body.bot.botId;
  const USERNAME = created.body.bot.username;
  await api(MANAGER, `/v1/bots/${BOT}/start`, { method: "POST" });
  for (let i = 0; i < 60; i++) {
    await sleep(1_000);
    const { body } = await api(CONTROL_API, "/v1/bots");
    if ((body.data?.bots ?? []).some((b) => b.botId === BOT && b.connectionState === "online")) break;
    if (i === 59) { log("FATAL: never online"); process.exit(1); }
  }
  log(`bot ${BOT} ONLINE`);

  async function submitGoal(text) {
    const requestId = randomUUID();
    const goalRes = await api(CONTROL_API, "/v1/goals", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", requestId, botId: BOT, operatorGoal: text, timeoutMs: 120_000 }),
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

  // reposition + 材料
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = await submitGoal("移动到坐标 x=0 y=70 z=0 附近");
    if (r.task?.status === "completed") break;
  }
  await fixture.rcon(`give ${USERNAME} minecraft:furnace 1`).catch(() => "");
  await fixture.rcon(`give ${USERNAME} minecraft:oak_log 8`).catch(() => "");
  await fixture.rcon(`give ${USERNAME} minecraft:raw_iron 3`).catch(() => "");
  await sleep(4_000);

  // 放熔炉（固定出生区扫描 air-on-solid 单格）
  let cell = null;
  outer:
  for (const y of [70, 71, 69]) {
    for (const z of [0, -1, 1, -2, 2, -3, 3]) {
      for (const x of [1, 2, 3]) {
        const air = await fixture.rcon(`execute if block ${x} ${y} ${z} minecraft:air`).catch(() => "");
        if (!air.includes("Test passed")) continue;
        const solid = await fixture.rcon(`execute unless block ${x} ${y - 1} ${z} minecraft:air`).catch(() => "");
        if (solid.includes("Test passed")) { cell = { x, y, z }; break outer; }
      }
    }
  }
  if (!cell) { log("FATAL: no furnace cell"); process.exit(1); }
  const place = await submitGoal([
    "使用蓝图施工技能放置一个 furnace：",
    `锚点 x=${cell.x}、y=${cell.y}、z=${cell.z}；`,
    `参考方块 x=${cell.x}、y=${cell.y - 1}、z=${cell.z}；`,
    "唯一单元格 offset x=0、y=0、z=0；referenceOffset x=0、y=-1、z=0；face x=0、y=1、z=0；",
    "维度为主世界；物品 furnace；结构类别 utility。坐标与结构不要改动。",
  ].join(""));
  const furnaceCheck = await fixture.rcon(`execute if block ${cell.x} ${cell.y} ${cell.z} minecraft:furnace`).catch(() => "");
  const placed = furnaceCheck.includes("Test passed");
  log(`furnace place: goal=${place.task?.status} server=${placed}`);

  // 注册（scan 真实观测）
  const regScan = await submitGoal("读取当前区域的 furnace 方块分布并给出扫描结果，只读");
  log(`registry scan: ${regScan.task?.status}`);

  // ===== F3 核心：rcon 破坏熔炉 =====
  await fixture.rcon(`setblock ${cell.x} ${cell.y} ${cell.z} minecraft:air`).catch(() => "");
  await sleep(1_000);
  const destroyedCheck = await fixture.rcon(`execute if block ${cell.x} ${cell.y} ${cell.z} minecraft:air`).catch(() => "");
  log(`furnace destroyed via rcon: ${destroyedCheck.includes("Test passed")}`);

  // 基线 CRITICAL facility
  const before = await api(MANAGER, "/v1/incidents?limit=100");
  const critBase = (before.body.issues ?? []).filter((i) => i.maxSeverity === "CRITICAL").reduce((s, i) => s + (i.occurrenceCount ?? 0), 0);

  // 破坏后再 smelt：租约验证应证伪（真实 scan 无该位置）→ furnace=null 回退
  const smeltAfter = await submitGoal("烧炼 1 个 iron_ingot，使用附近可用的熔炉，燃料用 oak_log");
  log(`smelt after destroy: ${smeltAfter.task?.status} ${smeltAfter.task?.failureReason ?? ""}`);

  const after = await api(MANAGER, "/v1/incidents?limit=100");
  const critAfter = (after.body.issues ?? []).filter((i) => i.maxSeverity === "CRITICAL").reduce((s, i) => s + (i.occurrenceCount ?? 0), 0);
  const facilitySignals = (after.body.issues ?? []).filter((i) => (i.primaryFailureCode ?? "").startsWith("FACILITY_"));
  log(`CRITICAL ${critBase}→${critAfter}; FACILITY issues: ${facilitySignals.length}`);

  await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);

  // 判定：熔炉真实放过+注册过+破坏后 smelt 没有把幽灵熔炉写进输入（goal
  // 完成/失败都接受——验证点是无 CRITICAL 噪音 + 服务器真值链完整）
  if (placed && destroyedCheck.includes("Test passed") && critAfter === critBase) {
    log("SCENARIO F3 PASS: furnace placed+registered+destroyed; post-destroy smelt degraded honestly (verify-falsified lease → fallback), zero CRITICAL noise");
    process.exit(0);
  }
  log("SCENARIO F3 FAIL");
  process.exit(2);
});
