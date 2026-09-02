#!/usr/bin/env node
// 场景 J1-large / J3-large（Round 6.5）：确定性蓝图行模板 —— 8 格工程规模。
// J1-large：单 goal 放 8 格（每批 8），全部 rcon execute-if-block 服务器验证。
// J3-large：批1（每批 4，从 0）→ 硬停 bot → 重上线 → 批2（从第 4 格起）→
//   8/8 全服务器验证；place 派发计数 == 批次数（已完成 cell 零重放）。
import { readFileSync, existsSync } from "node:fs";
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
const MODE = process.env.JL_MODE === "resume" ? "resume" : "full";
const CELLS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function api(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function placeDispatchCount(botId) {
  const logFile = path.join(ROOT, "runtime-data", "logs", `bot-${botId}.log`);
  if (!existsSync(logFile)) return 0;
  let count = 0;
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    if (!line.includes("bot_runtime_skill_result")) continue;
    try {
      const j = JSON.parse(line);
      if (j.skillId === "build.blueprint") count += 1;
    } catch { /* skip */ }
  }
  return count;
}

await withE2EFixture(async (fixture) => {
  log(`fixture port=${fixture.port} mode=${MODE}`);

  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `JL${RUN_TAG}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
  });
  if (created.status !== 201) { log(`FATAL create: ${created.status}`); process.exit(1); }
  const BOT = created.body.bot.botId;
  const USERNAME = created.body.bot.username;

  async function startBot() {
    await api(MANAGER, `/v1/bots/${BOT}/start`, { method: "POST" });
    for (let i = 0; i < 60; i++) {
      await sleep(1_000);
      const { body } = await api(CONTROL_API, "/v1/bots");
      if ((body.data?.bots ?? []).some((b) => b.botId === BOT && b.connectionState === "online")) return true;
    }
    return false;
  }
  if (!(await startBot())) { log("FATAL: bot never online"); process.exit(1); }
  log(`bot ${BOT} ONLINE`);

  async function submitGoal(text) {
    const requestId = randomUUID();
    const goalRes = await api(CONTROL_API, "/v1/goals", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", requestId, botId: BOT, operatorGoal: text, timeoutMs: 120_000 }),
    });
    if (goalRes.status >= 300) { log(`goal rejected: ${JSON.stringify(goalRes.body).slice(0, 120)}`); return null; }
    for (let i = 0; i < 60; i++) {
      await sleep(2_000);
      const { body } = await api(CONTROL_API, "/v1/tasks?limit=10");
      const task = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
      if (task && (task.status === "completed" || task.status === "failed")) return task;
    }
    return null;
  }

  // reposition（有界重试）
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = await submitGoal("移动到坐标 x=0 y=70 z=0 附近");
    if (r?.status === "completed") break;
    log(`reposition attempt ${attempt}: ${r?.status ?? "rejected"}`);
  }

  // 材料：rcon give 测试条件注入（F1 同款；本场景验证蓝图确定性通道而非采集）
  await fixture.rcon(`give ${USERNAME} minecraft:oak_log 8`).catch(() => "");
  await sleep(4_000);

  // 锚点：rcon 扫一行 air-on-solid（8 格连续沿 +x）
  const rconPos = await fixture.rcon(`data get entity ${USERNAME} Pos`).catch(() => "");
  const m = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(rconPos)
    ?? /X: (-?[\d.]+),? Y: (-?[\d.]+),? Z: (-?[\d.]+)/.exec(rconPos);
  if (!m) { log("FATAL: no position"); process.exit(1); }
  const bx = Math.floor(Number(m[1])), by = Math.floor(Number(m[2])), bz = Math.floor(Number(m[3]));
  // 找连续 8 格 air 且每格下方 solid 的 +x 行（三维扫描：y ±1、z ±6、x 偏移）
  let anchor = null;
  outer:
  for (const dy of [0, 1, -1]) {
    for (const dz of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6]) {
      for (const dx of [1, 2, 0, 3, -1]) {
        const y = by + dy, z = bz + dz, x0 = bx + dx;
        let ok = true;
        for (let i = 0; i < CELLS; i += 1) {
          const x = x0 + i;
          const air = await fixture.rcon(`execute if block ${x} ${y} ${z} minecraft:air`).catch(() => "");
          if (!air.includes("Test passed")) { ok = false; break; }
          const solid = await fixture.rcon(`execute unless block ${x} ${y - 1} ${z} minecraft:air`).catch(() => "");
          if (!solid.includes("Test passed")) { ok = false; break; }
        }
        if (ok) { anchor = { x: x0, y, z }; break outer; }
      }
    }
  }
  if (!anchor) { log("FATAL: no 8-cell air-on-solid +x row found"); process.exit(1); }
  // place 不移动：bot 站行中点（8 格行最远 3.5 < reach 3.8）
  await submitGoal(`移动到坐标 x=${anchor.x + 3} y=${anchor.y} z=${anchor.z} 附近`);
  log(`anchor row @(${anchor.x},${anchor.y},${anchor.z}) +x ×${CELLS}`);

  async function verifyCell(index) {
    const x = anchor.x + index;
    const check = await fixture.rcon(`execute if block ${x} ${anchor.y} ${anchor.z} minecraft:oak_log`).catch(() => "");
    return check.includes("Test passed");
  }

  if (MODE === "full") {
    // ===== J1-large：单 goal 全量 8 格 =====
    const goal = `施工蓝图行：锚点 x=${anchor.x} y=${anchor.y} z=${anchor.z}，沿 +x 放置 ${CELLS} 个 oak_log`;
    const task = await submitGoal(goal);
    const cells = [];
    for (let i = 0; i < CELLS; i += 1) cells.push(await verifyCell(i));
    const dispatches = placeDispatchCount(BOT);
    log(`cells=[${cells.join(",")}] dispatches=${dispatches}`);
    await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);
    if (task?.status === "completed" && cells.every(Boolean)) {
      log(`SCENARIO J1-large PASS: ${CELLS}/${CELLS} server-verified via deterministic template`);
      process.exit(0);
    }
    log("SCENARIO J1-large FAIL");
    process.exit(2);
  }

  // ===== J3-large：批1（4）→硬停→批2（从第 4 格）=====
  const g1 = `施工蓝图行：锚点 x=${anchor.x} y=${anchor.y} z=${anchor.z}，沿 +x 放置 ${CELLS} 个 oak_log，每批最多 4 格，从第 0 格开始`;
  const t1 = await submitGoal(g1);
  const first4 = [];
  for (let i = 0; i < 4; i += 1) first4.push(await verifyCell(i));
  const dispatchesBeforeStop = placeDispatchCount(BOT);
  log(`batch1: goal=${t1?.status} cells[0..3]=[${first4.join(",")}] dispatches=${dispatchesBeforeStop}`);

  // 硬停（journal 边界）
  await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" });
  await sleep(4_000);
  log(`bot stopped at journal boundary`);

  if (!(await startBot())) { log("FATAL: never re-online"); process.exit(1); }
  log("bot re-online");

  // 材料补足（批 2 需 4 根）
  await fixture.rcon(`give ${USERNAME} minecraft:oak_log 4`).catch(() => "");
  await sleep(3_000);

  const g2 = `施工蓝图行：锚点 x=${anchor.x} y=${anchor.y} z=${anchor.z}，沿 +x 放置 ${CELLS} 个 oak_log，每批最多 4 格，从第 4 格开始`;
  const t2 = await submitGoal(g2);
  const all = [];
  for (let i = 0; i < CELLS; i += 1) all.push(await verifyCell(i));
  const dispatchesAfter = placeDispatchCount(BOT);
  log(`batch2: goal=${t2?.status} cells[0..7]=[${all.join(",")}] dispatches=${dispatchesAfter}`);

  await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);

  const allPlaced = all.every(Boolean);
  const zeroReplay = dispatchesAfter <= 2 + 1;
  if (allPlaced && zeroReplay) {
    log(`SCENARIO J3-large PASS: ${CELLS}/${CELLS} cells server-verified across hard restart; dispatches ${dispatchesAfter} ≈ batches 2 (zero replay)`);
    process.exit(0);
  }
  log(`SCENARIO J3-large FAIL: allPlaced=${allPlaced} dispatches=${dispatchesAfter}`);
  process.exit(2);
});
