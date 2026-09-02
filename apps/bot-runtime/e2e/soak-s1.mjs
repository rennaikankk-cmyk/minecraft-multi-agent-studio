#!/usr/bin/env node
// S1 Soak（Skill System v1 §十七）：单 Bot 本地长跑。
// 循环：站位→观察(scan)→采集(craft 输入/烧炼输入)→制造(planks/table)→熔炼→
//       物流(container/stock 只读)→Build(行模板)→恢复（受控失败注入后自愈）。
// 每 5 轮注入一次受控失败（熔炉被毁 → 期望诚实失败+下轮自愈重建）。
// 记录：goal 计数、incident delta、node/java RSS 采样、死亡/重连、零孤儿。
// 产物：e2e/logs/soak-s1-<tag>.jsonl + 最终 summary JSON（stdout 摘要）。
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
const JSONL = path.join(LOG_DIR, `soak-s1-${RUN_TAG}.jsonl`);
const SUMMARY = path.join(LOG_DIR, `soak-s1-${RUN_TAG}.json`);

const SOAK_MINUTES = Number(process.env.SOAK_MINUTES ?? "60");
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
  const bot = (body.data?.bots ?? []).find((b) => b.botId === botId);
  return bot?.connectionState === "online" ? bot : null;
}

async function submitGoal(botId, text, timeoutMs = 150_000) {
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

function processRssKb() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV"], { windowsHide: true }, (e1, out1) => {
      execFile("tasklist", ["/FI", "IMAGENAME eq java.exe", "/FO", "CSV"], { windowsHide: true }, (e2, out2) => {
        const sum = (csv) => [...csv.matchAll(/,"([\d,.]+) K"/g)].reduce((s, m) => s + Number(m[1].replaceAll(/[.,]/g, "")), 0);
        resolve({ nodeKb: e1 ? 0 : sum(out1 || ""), javaKb: e2 ? 0 : sum(out2 || "") });
      });
    });
  });
}

const stats = {
  startedAt: new Date().toISOString(),
  soakMinutes: SOAK_MINUTES,
  cycles: 0,
  goals: { attempted: 0, completed: 0, failed: 0, timedOut: 0 },
  injectedFailures: 0,
  deaths: 0,
  reconnects: 0,
  rss: { samples: 0, nodeMaxKb: 0, javaMaxKb: 0, first: null, last: null },
  incidentDelta: 0,
  incidentsByCode: {},
};

await withE2EFixture(async (fixture) => {
  log(`fixture port=${fixture.port}; soak target ${SOAK_MINUTES}min`);
  const deadline = Date.now() + SOAK_MINUTES * 60_000;

  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `SK${RUN_TAG}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
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

  const baseInc = await api(MANAGER, "/v1/incidents?limit=200");
  const baseByCode = {};
  for (const issue of baseInc.body.issues ?? []) baseByCode[issue.primaryFailureCode ?? "?"] = issue.occurrenceCount ?? 0;

  // 站位与初始物资
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = await submitGoal(botId, "移动到坐标 x=0 y=70 z=0 附近");
    if (r?.status === "completed") break;
  }
  await fixture.rcon(`give ${username} minecraft:raw_iron 32`).catch(() => "");
  await fixture.rcon(`give ${username} minecraft:furnace 8`).catch(() => "");
  await fixture.rcon(`give ${username} minecraft:oak_log 64`).catch(() => "");
  await fixture.rcon(`give ${username} minecraft:chest 2`).catch(() => "");
  await sleep(4_000);

  const rconPos = await fixture.rcon(`data get entity ${username} Pos`).catch(() => "");
  const m = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(rconPos);
  if (!m) { log("FATAL: no position"); process.exit(1); }
  const px = Math.floor(Number(m[1])), py = Math.floor(Number(m[2])), pz = Math.floor(Number(m[3]));
  let furnaceCell = null;
  for (const c of [{ x: px, y: py, z: pz - 1 }, { x: px, y: py, z: pz + 1 }, { x: px - 1, y: py, z: pz }, { x: px + 1, y: py, z: pz }]) {
    const air = await fixture.rcon(`execute if block ${c.x} ${c.y} ${c.z} minecraft:air`).catch(() => "");
    if (!air.includes("Test passed")) continue;
    const solid = await fixture.rcon(`execute unless block ${c.x} ${c.y - 1} ${c.z} minecraft:air`).catch(() => "");
    if (solid.includes("Test passed")) { furnaceCell = c; break; }
  }
  if (!furnaceCell) { log("FATAL: no furnace cell"); process.exit(1); }
  const PLACE = `施工蓝图行：锚点 x=${furnaceCell.x} y=${furnaceCell.y} z=${furnaceCell.z}，沿 +x 放置 1 个 furnace，每批最多 1 格，从第 1 格开始`;

  const rssSampler = setInterval(async () => {
    const rss = await processRssKb();
    stats.rss.samples += 1;
    stats.rss.nodeMaxKb = Math.max(stats.rss.nodeMaxKb, rss.nodeKb);
    stats.rss.javaMaxKb = Math.max(stats.rss.javaMaxKb, rss.javaKb);
    if (stats.rss.first === null) stats.rss.first = rss;
    stats.rss.last = rss;
  }, 60_000);

  // ===== 主循环 =====
  let cycle = 0;
  while (Date.now() < deadline) {
    cycle += 1;
    stats.cycles = cycle;
    const cycleStart = Date.now();
    jlog({ t: new Date().toISOString(), cycle, event: "cycle-start" });
    try {
      // 1) 观察
      let g = await submitGoal(botId, "读取当前区域的 oak_log 方块分布并给出扫描结果，只读");
      record("scan", g);

      // 2) 移动（小位移，避免长途把循环拖爆）
      g = await submitGoal(botId, `移动到坐标 x=${px + (cycle % 3) - 1} y=${py} z=${pz} 附近`);
      record("move", g);

      // 受控失败注入：每 5 轮毁熔炉（smelt 必须诚实失败）
      let injected = false;
      if (cycle % 5 === 0) {
        await fixture.rcon(`setblock ${furnaceCell.x} ${furnaceCell.y} ${furnaceCell.z} minecraft:air`).catch(() => "");
        stats.injectedFailures += 1;
        injected = true;
        jlog({ t: new Date().toISOString(), cycle, event: "inject-furnace-destroyed" });
      }

      // 3) 熔炼（注入轮必须诚实失败；非注入轮应成功或可解释失败）
      g = await submitGoal(botId, "烧炼 1 个 iron_ingot，使用附近可用的熔炉，燃料用 oak_log");
      record(injected ? "smelt-injected" : "smelt", g, injected);

      // 自愈：注入后重建熔炉（下一轮 smelt 恢复能力）
      if (injected) {
        const heal = await fixture.rcon(`execute if block ${furnaceCell.x} ${furnaceCell.y} ${furnaceCell.z} minecraft:air`).catch(() => "");
        if (heal.includes("Test passed")) {
          g = await submitGoal(botId, PLACE);
          record("heal-replace-furnace", g);
        }
      }

      // 4) 制造
      g = await submitGoal(botId, "合成 4 个 oak_planks");
      record("craft", g);

      // 5) 物流（库存盘点，只读）
      g = await submitGoal(botId, "读取当前区域的 stone 方块分布并给出扫描结果，只读");
      record("scan2", g);

      // 6) Build（2 格小行，锚点固定，重复放置 = 已占用 → 诚实失败/幂等）
      g = await submitGoal(botId, `施工蓝图行：锚点 x=${furnaceCell.x} y=${furnaceCell.y + 1} z=${furnaceCell.z}，沿 +x 放置 2 个 oak_log，每批最多 2 格，从第 1 格开始`);
      record("build-row", g);
    } catch (error) {
      jlog({ t: new Date().toISOString(), cycle, event: "cycle-error", message: String(error).slice(0, 300) });
    }
    // 死亡/在线检查
    const online = await botOnline(botId);
    if (!online) {
      stats.deaths += 1;
      jlog({ t: new Date().toISOString(), cycle, event: "bot-offline" });
      await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" }).catch(() => undefined);
      for (let i = 0; i < 60; i++) {
        await sleep(1_000);
        if (await botOnline(botId)) { stats.reconnects += 1; break; }
      }
    }
    jlog({ t: new Date().toISOString(), cycle, event: "cycle-end", ms: Date.now() - cycleStart });
  }

  clearInterval(rssSampler);

  // 终态盘点
  const finalInc = await api(MANAGER, "/v1/incidents?limit=200");
  const finalByCode = {};
  for (const issue of finalInc.body.issues ?? []) finalByCode[issue.primaryFailureCode ?? "?"] = issue.occurrenceCount ?? 0;
  for (const [code, count] of Object.entries(finalByCode)) {
    const delta = count - (baseByCode[code] ?? 0);
    if (delta > 0) stats.incidentsByCode[code] = delta;
  }
  stats.incidentDelta = Object.values(stats.incidentsByCode).reduce((s, n) => s + n, 0);
  stats.endedAt = new Date().toISOString();
  stats.durationMs = Date.now() - (deadline - SOAK_MINUTES * 60_000);

  await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);
  await sleep(5_000);
  const stopped = await botOnline(botId);
  stats.cleanStop = !stopped;

  writeFileSync(SUMMARY, JSON.stringify(stats, null, 2));
  log(`SOAK S1 SUMMARY -> ${SUMMARY}`);
  log(JSON.stringify({
    cycles: stats.cycles, goals: stats.goals, injectedFailures: stats.injectedFailures,
    deaths: stats.deaths, reconnects: stats.reconnects, incidentDelta: stats.incidentDelta,
    incidentsByCode: stats.incidentsByCode, rssNodeMaxKb: stats.rss.nodeMaxKb,
    rssJavaMaxKb: stats.rss.javaMaxKb, cleanStop: stats.cleanStop,
  }));
  process.exit(0);

  function record(step, task, injected = false) {
    stats.goals.attempted += 1;
    const status = task?.status ?? "timedOut";
    if (status === "completed") stats.goals.completed += 1;
    else if (status === "failed") stats.goals.failed += 1;
    else stats.goals.timedOut += 1;
    jlog({ t: new Date().toISOString(), cycle, step, status, injected, failure: task?.failureReason ?? null });
  }
});
