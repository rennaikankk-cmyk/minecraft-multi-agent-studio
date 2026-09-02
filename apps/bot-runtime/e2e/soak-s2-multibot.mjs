#!/usr/bin/env node
// S2 Soak（Skill System v1 §十五/§十七）：2–3 Bot 独立生存 + 共享 registry。
// 每轮：3 个 Bot 各自轻 goal 循环（scan/move/craft/stock）+ 同轮并发 smelt
// 争用同一熔炉（租约语义：F2 已验证的 contention 路径长跑化）。
// 记录：per-bot goal 计数、lease 争用结果、incident delta（FACILITY CRITICAL=0）、
//       RSS 采样、死亡/重连；结束零孤儿正常停止。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withE2EFixture } from "./fixture-manager.mjs";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "..", "..", "..");
const LOG_DIR = path.join(E2E_DIR, "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const RUN_TAG = Date.now().toString(36).slice(-6);
const JSONL = path.join(LOG_DIR, `soak-s2-${RUN_TAG}.jsonl`);
const SUMMARY = path.join(LOG_DIR, `soak-s2-${RUN_TAG}.json`);
const SOAK_MINUTES = Number(process.env.SOAK_MINUTES ?? "60");
const BOT_COUNT = Math.min(3, Math.max(2, Number(process.env.SOAK_BOTS ?? "3")));

const secrets = JSON.parse(readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"));
const MANAGER = `http://127.0.0.1:${process.env.STUDIO_MANAGER_PORT ?? "3230"}`;
const CONTROL_API = `http://127.0.0.1:${process.env.CONTROL_API_PORT ?? "3210"}`;
const HEADERS = { Authorization: `Bearer ${secrets.dashboardToken}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const jlog = (obj) => appendFileSync(JSONL, `${JSON.stringify(obj)}\n`);

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
  const requestId = randomUUID();
  await api(CONTROL_API, "/v1/goals", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", requestId, botId, operatorGoal: text, timeoutMs }),
  }).catch(() => undefined);
  for (let i = 0; i < Math.floor(timeoutMs / 2_000); i++) {
    await sleep(2_000);
    const { body } = await api(CONTROL_API, "/v1/tasks?limit=15");
    const task = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
    if (task && (task.status === "completed" || task.status === "failed")) return task?.status ?? "unknown";
  }
  return "timedOut";
}

function processRssKb() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV"], { windowsHide: true }, (e1, out1) => {
      execFile("tasklist", ["/FI", "IMAGENAME eq java.exe", "/FO", "CSV"], { windowsHide: true }, (e2, out2) => {
        const sum = (csv) => [...(csv || "").matchAll(/,"([\d,.]+) K"/g)].reduce((s, m) => s + Number(m[1].replaceAll(/[.,]/g, "")), 0);
        resolve({ nodeKb: e1 ? 0 : sum(out1), javaKb: e2 ? 0 : sum(out2) });
      });
    });
  });
}

const stats = {
  startedAt: new Date().toISOString(),
  soakMinutes: SOAK_MINUTES,
  botCount: BOT_COUNT,
  cycles: 0,
  perBot: {},
  contentionRounds: 0,
  rss: { samples: 0, nodeMaxKb: 0, javaMaxKb: 0 },
  incidentDelta: 0,
  incidentsByCode: {},
  facilityCritical: 0,
  cleanStop: null,
};

await withE2EFixture(async (fixture) => {
  log(`fixture port=${fixture.port}; ${BOT_COUNT} bots; ${SOAK_MINUTES}min`);
  const deadline = Date.now() + SOAK_MINUTES * 60_000;

  // 3 个 bot + 共享熔炉（bot A 放置）
  const bots = [];
  for (let i = 0; i < BOT_COUNT; i += 1) {
    const name = `S2${"ABC"[i]}${RUN_TAG}`.slice(0, 16);
    const created = await api(MANAGER, "/v1/bots", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", username: name, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
    });
    const botId = created.body.bot?.botId;
    if (!botId) { log("FATAL: create bot failed"); process.exit(1); }
    await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });
    for (let k = 0; k < 60; k++) {
      await sleep(1_000);
      if (await botOnline(botId)) break;
    }
    bots.push({ botId, username: created.body.bot.username });
    stats.perBot[botId] = { username: created.body.bot.username, attempted: 0, completed: 0, failed: 0, offline: 0, reconnects: 0 };
    log(`bot ${created.body.bot.username} ONLINE`);
  }
  const [lead, ...rest] = bots;

  const baseInc = await api(MANAGER, "/v1/incidents?limit=200");
  const baseByCode = {};
  for (const issue of baseInc.body.issues ?? []) baseByCode[issue.primaryFailureCode ?? "?"] = issue.occurrenceCount ?? 0;

  // 站位（分散：三人各占一角，减少路径冲突）
  const spots = [{ x: 0, z: 0 }, { x: 6, z: 0 }, { x: 0, z: 6 }];
  for (let i = 0; i < bots.length; i += 1) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const s = await submitGoal(bots[i].botId, `移动到坐标 x=${spots[i].x} y=70 z=${spots[i].z} 附近`, 90_000);
      if (s === "completed") break;
    }
  }
  // 材料注入
  for (const bot of bots) {
    await fixture.rcon(`give ${bot.username} minecraft:raw_iron 32`).catch(() => "");
    await fixture.rcon(`give ${bot.username} minecraft:oak_log 32`).catch(() => "");
  }
  await fixture.rcon(`give ${lead.username} minecraft:furnace 4`).catch(() => "");
  await sleep(4_000);

  const rconPos = await fixture.rcon(`data get entity ${lead.username} Pos`).catch(() => "");
  const m = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(rconPos);
  if (!m) { log("FATAL: no lead position"); process.exit(1); }
  const px = Math.floor(Number(m[1])), py = Math.floor(Number(m[2])), pz = Math.floor(Number(m[3]));
  let cell = null;
  for (const c of [{ x: px, y: py, z: pz - 1 }, { x: px, y: py, z: pz + 1 }, { x: px - 1, y: py, z: pz }, { x: px + 1, y: py, z: pz }]) {
    const air = await fixture.rcon(`execute if block ${c.x} ${c.y} ${c.z} minecraft:air`).catch(() => "");
    if (!air.includes("Test passed")) continue;
    const solid = await fixture.rcon(`execute unless block ${c.x} ${c.y - 1} ${c.z} minecraft:air`).catch(() => "");
    if (solid.includes("Test passed")) { cell = c; break; }
  }
  if (!cell) { log("FATAL: no furnace cell"); process.exit(1); }
  await submitGoal(lead.botId, `施工蓝图行：锚点 x=${cell.x} y=${cell.y} z=${cell.z}，沿 +x 放置 1 个 furnace，每批最多 1 格，从第 1 格开始`, 150_000);
  await submitGoal(lead.botId, "读取当前区域的 furnace 方块分布并给出扫描结果，只读", 90_000);
  log("shared furnace placed + registered");

  const rssSampler = setInterval(async () => {
    const rss = await processRssKb();
    stats.rss.samples += 1;
    stats.rss.nodeMaxKb = Math.max(stats.rss.nodeMaxKb, rss.nodeKb);
    stats.rss.javaMaxKb = Math.max(stats.rss.javaMaxKb, rss.javaKb);
  }, 60_000);

  let cycle = 0;
  while (Date.now() < deadline) {
    cycle += 1;
    stats.cycles = cycle;
    jlog({ t: new Date().toISOString(), cycle, event: "cycle-start" });
    try {
      // 独立轻 goal（各 bot 并发）
      const independent = bots.map((bot, idx) =>
        submitGoal(bot.botId, ["读取当前区域的 oak_log 方块分布并给出扫描结果，只读", "合成 4 个 oak_planks", "读取当前区域的 stone 方块分布并给出扫描结果，只读"][idx % 3], 120_000)
          .then((status) => { const s = stats.perBot[bot.botId]; s.attempted += 1; if (status === "completed") s.completed += 1; else s.failed += 1; jlog({ t: new Date().toISOString(), cycle, bot: bot.username, step: "independent", status }); }),
      );
      await Promise.all(independent);

      // 共享熔炉并发争用（每 2 轮一次）
      if (cycle % 2 === 0) {
        stats.contentionRounds += 1;
        const smelts = bots.map((bot) =>
          submitGoal(bot.botId, "烧炼 1 个 iron_ingot，使用附近可用的熔炉，燃料用 oak_log", 150_000)
            .then((status) => jlog({ t: new Date().toISOString(), cycle, bot: bot.username, step: "smelt-contention", status })),
        );
        await Promise.all(smelts);
      }
    } catch (error) {
      jlog({ t: new Date().toISOString(), cycle, event: "cycle-error", message: String(error).slice(0, 300) });
    }
    // 掉线自愈
    for (const bot of bots) {
      if (!(await botOnline(bot.botId))) {
        stats.perBot[bot.botId].offline += 1;
        jlog({ t: new Date().toISOString(), cycle, event: "bot-offline", bot: bot.username });
        await api(MANAGER, `/v1/bots/${bot.botId}/start`, { method: "POST" }).catch(() => undefined);
        for (let k = 0; k < 60; k++) {
          await sleep(1_000);
          if (await botOnline(bot.botId)) { stats.perBot[bot.botId].reconnects += 1; break; }
        }
      }
    }
    jlog({ t: new Date().toISOString(), cycle, event: "cycle-end" });
  }
  clearInterval(rssSampler);

  const finalInc = await api(MANAGER, "/v1/incidents?limit=200");
  const finalByCode = {};
  for (const issue of finalInc.body.issues ?? []) finalByCode[issue.primaryFailureCode ?? "?"] = issue.occurrenceCount ?? 0;
  for (const [code, count] of Object.entries(finalByCode)) {
    const delta = count - (baseByCode[code] ?? 0);
    if (delta > 0) stats.incidentsByCode[code] = delta;
  }
  stats.incidentDelta = Object.values(stats.incidentsByCode).reduce((s, n) => s + n, 0);
  stats.facilityCritical = (finalInc.body.issues ?? []).filter((i) => (i.primaryFailureCode ?? "").startsWith("FACILITY_") && i.maxSeverity === "CRITICAL").length;

  for (const bot of bots) await api(MANAGER, `/v1/bots/${bot.botId}/stop`, { method: "POST" }).catch(() => undefined);
  await sleep(6_000);
  stats.cleanStop = true;
  for (const bot of bots) if (await botOnline(bot.botId)) stats.cleanStop = false;
  stats.endedAt = new Date().toISOString();
  writeFileSync(SUMMARY, JSON.stringify(stats, null, 2));
  log(`SOAK S2 SUMMARY -> ${SUMMARY}`);
  log(JSON.stringify({ cycles: stats.cycles, contentionRounds: stats.contentionRounds, incidentDelta: stats.incidentDelta, facilityCritical: stats.facilityCritical, cleanStop: stats.cleanStop, rss: stats.rss }));
  process.exit(stats.cleanStop && stats.facilityCritical === 0 ? 0 : 3);
});
