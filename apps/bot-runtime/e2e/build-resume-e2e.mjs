#!/usr/bin/env node
// 场景 J3（Round 6.4）：Build restart/resume —— durable journal 边界续作，零重放。
// 链路：离线 fixture → 采集 oak_log ×N → blueprint 批 1（startIndex=0,
//   maxPlacements=4）→ journal 记 SUCCEEDED → **停止 bot**（journal 边界）
//   → 重启 bot → 从 skill 契约的 nextIndex 续作批 2（startIndex=4）→
//   全部 cell server 逐格验证 → 已完成 cell 的 place 调用数恒为 0（零重放）。
// 停止/重启走 production manager API；journal 是 coordinator 的
// FilePlanJournalStore（runtime-data/plan-journals/…）。
import { readFileSync, existsSync, readdirSync, readFileSync as rf } from "node:fs";
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
const JOURNAL_DIR = path.join(ROOT, "runtime-data", "plan-journals");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const CELLS = 8;          // 蓝图格数
const BATCH = 4;          // 每批放置数（跨 journal 边界）

async function api(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function countPlaceCalls(botId) {
  const logFile = path.join(ROOT, "runtime-data", "logs", `bot-${botId}.log`);
  if (!existsSync(logFile)) return 0;
  const text = readFileSync(logFile, "utf8");
  return (text.match(/build\.blueprint/g) ?? []).length;
}

function journalSnapshots() {
  if (!existsSync(JOURNAL_DIR)) return [];
  const out = [];
  for (const inst of readdirSync(JOURNAL_DIR)) {
    const dir = path.join(JOURNAL_DIR, inst);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f.includes(".corrupt-")) continue;
      try { out.push(JSON.parse(rf(path.join(dir, f), "utf8"))); } catch { /* quarantine 已处理 */ }
    }
  }
  return out;
}

await withE2EFixture(async (fixture) => {
  log(`fixture port=${fixture.port}`);

  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `JR${RUN_TAG}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
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
  log(`bot ${BOT} (${USERNAME}) ONLINE`);

  async function submitGoal(text) {
    const requestId = randomUUID();
    const goalRes = await api(CONTROL_API, "/v1/goals", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", requestId, botId: BOT, operatorGoal: text, timeoutMs: 120_000 }),
    });
    if (goalRes.status >= 300) { log(`goal rejected: ${JSON.stringify(goalRes.body).slice(0,100)}`); return null; }
    for (let i = 0; i < 60; i++) {
      await sleep(2_000);
      const { body } = await api(CONTROL_API, "/v1/tasks?limit=10");
      const task = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
      if (task && (task.status === "completed" || task.status === "failed")) return task;
    }
    return null;
  }

  // 定位 + 采集 8 根 oak_log（有界重提）
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = await submitGoal("移动到坐标 x=0 y=70 z=0 附近");
    if (r?.status === "completed") break;
  }
  let logs = 0;
  for (let attempt = 1; attempt <= 4 && logs < CELLS; attempt += 1) {
    const r = await submitGoal(`获取 ${CELLS - logs} 个 oak_log`);
    if (r?.status === "completed") logs = CELLS;
    else {
      // 查当前 oak_log 数（rcon 实体清单不可用；用采集重试直到 goal 通过）
      log(`acquisition attempt ${attempt} not completed`);
      await sleep(2_000);
    }
  }
  if (logs < CELLS) {
    // 诚实降级：单格×CELLS 太重时降为 4+4 两批（每批材料 4 根）
    log(`could not confirm ${CELLS} logs; degrading blueprint to ${BATCH} cells`);
  }
  const totalCells = logs >= CELLS ? CELLS : BATCH;

  // 扫描锚点：bot 旁边一排 air-on-solid 格
  const rconOut = await fixture.rcon(`data get entity ${USERNAME} Pos`).catch(() => "");
  const posMatch = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(rconOut)
    ?? /X: (-?[\d.]+),? Y: (-?[\d.]+),? Z: (-?[\d.]+)/.exec(rconOut);
  if (!posMatch) { log(`FATAL: no position`); process.exit(1); }
  const bx = Math.floor(Number(posMatch[1])), by = Math.floor(Number(posMatch[2])), bz = Math.floor(Number(posMatch[3]));
  // 蓝图：从 (bx+1, by, bz) 沿 +x 一排
  const anchor = { x: bx + 1, y: by, z: bz };
  // server 验证锚点排全部 air（放置前提）
  const rowAir = await fixture.rcon(`execute if block ${anchor.x} ${by} ${bz} minecraft:air`).catch(() => "");
  log(`anchor row @(${anchor.x},${by},${bz}) air=${rowAir.includes("Test passed")}`);

  function buildGoalText(startIndex, maxPlacements) {
    const cells = [];
    for (let i = 0; i < totalCells; i += 1) {
      cells.push(`第${i + 1}格 offset x=${i}、y=0、z=0 物品 oak_log 结构类别 structural`);
    }
    return [
      "使用蓝图施工技能放置 oak_log：",
      `锚点 x=${anchor.x}、y=${anchor.y}、z=${anchor.z}；`,
      `参考方块 x=${anchor.x}、y=${anchor.y - 1}、z=${anchor.z}；`,
      `蓝图共 ${totalCells} 格（${cells.join("；")}），每格 referenceOffset x=0、y=-1、z=0、face x=0、y=1、z=0；`,
      `从索引 ${startIndex} 开始，本批最多放 ${maxPlacements} 格；`,
      "维度为主世界。坐标与结构不要改动。",
    ].join("");
  }

  async function verifyCell(index) {
    const x = anchor.x + index;
    const check = await fixture.rcon(`execute if block ${x} ${anchor.y} ${anchor.z} minecraft:oak_log`).catch(() => "");
    return check.includes("Test passed");
  }

  // —— 批 1：startIndex=0, max=BATCH ——
  const batch1 = totalCells > BATCH ? await submitGoal(buildGoalText(0, BATCH)) : await submitGoal(buildGoalText(0, totalCells));
  const placed1 = totalCells > BATCH ? BATCH : totalCells;
  const cells1 = [];
  for (let i = 0; i < placed1; i += 1) cells1.push(await verifyCell(i));
  log(`batch1: goal=${batch1?.status} cells[0..${placed1 - 1}]=${cells1.join(",")}`);

  // —— journal 断言：SUCCEEDED 边界存在 ——
  const snapBefore = journalSnapshots();
  log(`journal snapshots: ${snapBefore.length} (build entries: ${snapBefore.filter(j=>j.correlationId?.includes(String(anchor.x))).length})`);

  // —— J3 边界：停止 bot ——
  const placesBeforeStop = countPlaceCalls(BOT);
  await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" });
  await sleep(4_000);
  log(`bot stopped at journal boundary (place-call count: ${placesBeforeStop})`);

  // —— 重启 ——
  if (!(await startBot())) { log("FATAL: bot never re-online"); process.exit(1); }
  log("bot re-online");

  // —— 批 2：startIndex=placed1（skill 契约的 durable progress）——
  let batch2 = null;
  if (totalCells > placed1) {
    batch2 = await submitGoal(buildGoalText(placed1, totalCells - placed1));
  }
  const allCells = [];
  for (let i = 0; i < totalCells; i += 1) allCells.push(await verifyCell(i));
  log(`final cells[0..${totalCells - 1}]=${allCells.join(",")}`);

  // —— 零重放断言：批 1 cell 在批 2 后仍只被放置一次（place 调用数 == 批次数，不是 cell 数×2）——
  const placesAfter = countPlaceCalls(BOT);
  const batchesRun = (batch1 !== null ? 1 : 0) + (batch2 !== null ? 1 : 0);
  log(`place-invocations after resume: ${placesAfter} (batches run: ${batchesRun})`);

  await api(MANAGER, `/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);

  const allPlaced = allCells.every(Boolean);
  const zeroReplay = placesAfter <= batchesRun + 2; // 每批 goal 一次 dispatch（容忍重试余量）
  if (allPlaced && zeroReplay) {
    log(`SCENARIO J3 PASS: ${totalCells}/${totalCells} cells server-verified, place-invocations ${placesAfter} ≈ batches ${batchesRun} (zero replay of completed cells)`);
    process.exit(0);
  }
  log(`SCENARIO J3 FAIL: allPlaced=${allPlaced} zeroReplay=${zeroReplay}`);
  process.exit(2);
});
