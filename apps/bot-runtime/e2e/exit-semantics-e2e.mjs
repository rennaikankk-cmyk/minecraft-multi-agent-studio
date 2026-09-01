#!/usr/bin/env node
// 场景 H（Round 6.1 §十一）：退出语义真实验证。
//   normal stop → restart → normal stop：BOT_CRASH 不增加
//   controlled external kill：BOT_CRASH 恰好 +1
// 全部经生产 manager API + 真实 bot 进程；不直接 POST Incident。
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "..", "..", "..");
const secrets = JSON.parse(readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"));
const MANAGER = `http://127.0.0.1:${process.env.STUDIO_MANAGER_PORT ?? "3230"}`;
const CONTROL_API = `http://127.0.0.1:${process.env.CONTROL_API_PORT ?? "3210"}`;
const HEADERS = { Authorization: `Bearer ${secrets.dashboardToken}`, "Content-Type": "application/json" };
let BOT = "studio-bot-01"; // createBot 自分配槽位后覆盖
const RUN_TAG = Date.now().toString(36).slice(-6);
const USERNAME = `ES${RUN_TAG}`; // 每次唯一：避免上次中断留下的同名槽位 409
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function api(pathname, init) {
  const response = await fetch(`${MANAGER}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function crashCounts() {
  const { body } = await api("/v1/incidents?incidentType=BOT_CRASH&limit=200");
  const issues = body.issues ?? [];
  const total = issues.reduce((sum, i) => sum + (i.occurrenceCount ?? 0), 0);
  return { issues: issues.length, total };
}

async function lifecycleCounts() {
  const { body } = await api("/v1/incidents?incidentType=BOT_LIFECYCLE&limit=200");
  return (body.issues ?? []).reduce((sum, i) => sum + (i.occurrenceCount ?? 0), 0);
}

async function botOnline() {
  // registry 在 control-api（manager 无 /v1/bots 路由）
  const response = await fetch(`${CONTROL_API}/v1/bots`, { headers: HEADERS });
  const body = await response.json().catch(() => ({}));
  const bot = (body.data?.bots ?? []).find((b) => b.botId === BOT);
  return bot?.connectionState === "online" ? bot : null;
}

// —— 前置：local test server 在线（稳定资源，非 e2e fixture）——
const lt = await api("/v1/servers/local-test");
if (lt.body?.resource?.status !== "online") {
  log("FATAL: local test server not online (start it via dashboard before running H)");
  process.exit(1);
}
const serverPort = lt.body.resource.hostPort;
log(`local test server online :${serverPort}`);

// 基线
const crashBefore = await crashCounts();
const lifeBefore = await lifecycleCounts();
log(`baseline BOT_CRASH occurrences=${crashBefore.total} BOT_LIFECYCLE occurrences=${lifeBefore}`);

// —— create bot（真实进程；显式指向 local test server，避免复用 manifest 里
// 残留的 e2e fixture 配置——fixture 端口在清理后是死端口）——
const created = await api("/v1/bots", {
  method: "POST",
  body: JSON.stringify({ schemaVersion: "1.0", username: USERNAME, serverHost: "127.0.0.1", serverPort, minecraftVersion: "auto" }),
});
if (created.status === 409) {
  const { body } = await api("/v1/studio/status");
  const existing = (body.bots ?? []).find((b) => b.username === USERNAME);
  if (!existing) { log("FATAL: 409 without existing slot"); process.exit(1); }
  BOT = existing.botId;
  log(`reusing existing slot ${BOT}`);
} else if (created.status !== 201) { log(`FATAL create: ${created.status} ${JSON.stringify(created.body).slice(0,200)}`); process.exit(1); }
else { BOT = created.body.bot.botId; }
log(`bot created: ${BOT} (server ${serverPort})`);
const started = await api(`/v1/bots/${BOT}/start`, { method: "POST" });
if (started.status !== 200) { log(`FATAL start: ${started.status} ${JSON.stringify(started.body).slice(0,200)}`); process.exit(1); }
let livePid = started.body?.bot?.pid ?? null; // manager 视角的进程 pid（registry 不带）
let bot = null;
for (let i = 0; i < 60 && !bot; i++) { await sleep(1_000); bot = await botOnline(); }
if (!bot) { log("FATAL: bot never online"); process.exit(1); }
log(`bot ONLINE pid=${bot.pid ?? "?"} username=${bot.username}`);

// —— normal stop：EXPECTED_STOP，无 incident ——
const s1 = await api(`/v1/bots/${BOT}/stop`, { method: "POST" });
if (s1.status !== 200) { log(`FATAL stop1: ${s1.status}`); process.exit(1); }
const exit1 = s1.body?.bot?.exit;
log(`stop#1 exit.classification=${exit1?.classification} requestedAction=${exit1?.requestedAction}`);
if (exit1?.classification !== "EXPECTED_STOP") { log("FAIL: stop#1 not EXPECTED_STOP"); process.exit(1); }

// —— restart：新进程起来；旧进程退出不产生 BOT_CRASH ——
const r1 = await api(`/v1/bots/${BOT}/restart`, { method: "POST" });
if (r1.status !== 200) { log(`FATAL restart: ${r1.status}`); process.exit(1); }
bot = null;
for (let i = 0; i < 60 && !bot; i++) { await sleep(1_000); bot = await botOnline(); }
if (!bot) { log("FAIL: bot never online after restart"); process.exit(1); }
livePid = r1.body?.bot?.pid ?? livePid;
log(`restart ONLINE pid=${livePid}`);

// —— normal stop again ——
const s2 = await api(`/v1/bots/${BOT}/stop`, { method: "POST" });
const exit2 = s2.body?.bot?.exit;
log(`stop#2 exit.classification=${exit2?.classification}`);
if (exit2?.classification !== "EXPECTED_RESTART") {
  // restart 之后这次 stop 的 purpose 仍是 stop（restart 语义只作用于其自身那次）
  if (exit2?.classification !== "EXPECTED_STOP") { log("FAIL: stop#2 classification invalid"); process.exit(1); }
}

const crashAfterStops = await crashCounts();
log(`after 2 stops + 1 restart: BOT_CRASH occurrences=${crashAfterStops.total} (was ${crashBefore.total})`);
if (crashAfterStops.total !== crashBefore.total) { log("FAIL: normal stop/restart changed BOT_CRASH count"); process.exit(1); }
log("normal stop + restart produce ZERO BOT_CRASH: PASS");

// —— controlled external kill：启动 → taskkill ——
const s3 = await api(`/v1/bots/${BOT}/start`, { method: "POST" });
livePid = s3.body?.bot?.pid ?? livePid;
bot = null;
for (let i = 0; i < 60 && !bot; i++) { await sleep(1_000); bot = await botOnline(); }
if (!bot) { log("FAIL: bot never online for kill phase"); process.exit(1); }
const pid = livePid;
if (!Number.isSafeInteger(pid)) { log("FAIL: no pid for kill phase"); process.exit(1); }
log(`kill phase: bot ONLINE pid=${pid}; external taskkill`);
execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
await sleep(6_000);
const { body: botsAfter } = await api("/v1/bots");
const killed = (botsAfter.data?.bots ?? []).find((b) => b.botId === BOT);
log(`after kill: processState=${killed?.processState} exit.classification=${killed?.exit?.classification} code=${killed?.exit?.exitCode}`);

const crashAfterKill = await crashCounts();
log(`after external kill: BOT_CRASH occurrences=${crashAfterKill.total} (was ${crashAfterStops.total})`);
const delta = crashAfterKill.total - crashAfterStops.total;
if (delta !== 1) { log(`FAIL: expected exactly +1 BOT_CRASH after external kill, got +${delta}`); process.exit(1); }
const lifeAfterKill = await lifecycleCounts();
log(`BOT_LIFECYCLE occurrences: ${lifeBefore} → ${lifeAfterKill}（FORCED/STARTUP 类未增加即正确）`);

// —— cleanup：确保 bot 停止（已死）——
await api(`/v1/bots/${BOT}/stop`, { method: "POST" }).catch(() => undefined);
log("SCENARIO H PASS: expected exits silent; external kill +1 exactly");
process.exit(0);
