// ---------------------------------------------------------------------------
// 真实 STUCK Incident 验证（Round 3 主线验收）
//
// 链路：真 Docker 服务器（LOCAL_TEST fixture）→ 真 mineflayer bot 登录 →
// 真 pathfinder 尝试走向远目标 → RCON 装箱制造可控 no-progress →
// 真实 ProgressWatchdog（runtime 同一代码）触发 stuck → 真实 IncidentReporter
// POST 到 Studio Manager → 异步持久化 → GET /v1/incidents 查询。
//
// 诚实边界：goal/planner（LLM）层未参与（Spark 离线，环境阻塞）；
// 移动目标由本脚本给出。其余每一环都是真实组件与真实数据。
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import mineflayer from "mineflayer";
import vec3 from "vec3";

import { ProgressWatchdog } from "../dist/progress-watchdog.js";
import { IncidentReporter, watchdogEventToSignal } from "../dist/incident-reporter.js";
import { execFile } from "node:child_process";
function rcon(command) {
  return new Promise((resolve, reject) => {
    execFile("docker", ["exec", "studio-local-test-mc", "rcon-cli", command], { timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const RUN_LOG = join(E2E_DIR, "logs", "stuck-e2e.log");
mkdirSync(dirname(RUN_LOG), { recursive: true });
const BOT_NAME = "stuck_scen_01";
const MC_VERSION = "1.21.11";
const MC_PORT = 25598;
const MANAGER_PORT = process.env.STUDIO_MANAGER_PORT ?? "3230";
const secrets = JSON.parse(
  readFileSync(join(E2E_DIR, "..", "..", "..", "runtime-data", "local-control-secrets.json"), "utf8"),
);

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(RUN_LOG, `${stamped}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const reporter = new IncidentReporter({
  botId: "studio-bot-03",
  endpoint: `http://127.0.0.1:${MANAGER_PORT}/v1/incidents`,
  token: secrets.dashboardToken,
  logger: { warn: (message) => log(`reporter-warn: ${message}`) },
});
// 阈值压短：受控场景 5s 无进度即 stuck（生产默认 8s）
const watchdog = new ProgressWatchdog({ stuckAfterMs: 5_000, noProgressAfterMs: 15_000 });

const bot = mineflayer.createBot({
  host: "127.0.0.1",
  port: MC_PORT,
  username: BOT_NAME,
  auth: "offline",
});

let sampleTimer = null;

bot.once("spawn", async () => {
  try {
    await sleep(2_000);
    log(`spawned at ${JSON.stringify(bot.entity?.position ?? "unknown")}`);

    // 装箱：可控 no-progress（服务器侧事实，非脚本假设）
    const boxResult = await rcon(
      "execute as stuck_scen_01 at @s run fill ~-2 ~ ~-2 ~2 ~3 ~2 minecraft:cobblestone hollow",
    ).catch((error) => `rcon-failed: ${error.message}`);
    log(`box: ${String(boxResult).slice(0, 80)}`);

    // 远处目标：装箱后不可达
    const target = vec3(500, 64, 500);
    const pathfinderModule = await import("mineflayer-pathfinder");
    const pathfinder = pathfinderModule.default ?? pathfinderModule;
    bot.loadPlugin(pathfinder.pathfinder);
    bot.pathfinder.setGoal(new pathfinder.goals.GoalNear(target.x, target.y, target.z, 1));
    log("goal set: (500,64,500) — unreachable (boxed)");

    // 主采样：真实位置 → 真实 watchdog（runtime 同一判定代码）
    const startedAt = Date.now();
    sampleTimer = setInterval(() => {
      if (!bot.entity) return;
      const raw = bot.entity.position;
      const position = { x: Math.floor(raw.x), y: Math.floor(raw.y), z: Math.floor(raw.z) };
      const events = watchdog.observe({
        observedAtMs: Date.now(),
        position,
        active: true,
        movementExpected: true,
        targetDistance: raw.distanceTo(target),
        goalKey: `minecraft:overworld:${target.x},64,${target.z}`,
      });
      for (const event of events) {
        if (event.kind === "progress") continue;
        log(`watchdog event: ${event.kind} ageMs=${event.ageMs}`);
        if (event.kind === "stuck" || event.kind === "oscillation" || event.kind === "loop") {
          reporter.report(watchdogEventToSignal({
            event,
            position,
            dimension: "minecraft:overworld",
            skillId: "invoke-goto",
            expectedProgress: `target distance decreasing toward ${target.x},${target.z}`,
            actualProgress: `${event.kind} after ${event.ageMs}ms without material progress (boxed-in controlled scenario)`,
          }));
        }
      }
      if (Date.now() - startedAt > 40_000 && sampleTimer) {
        clearInterval(sampleTimer);
        sampleTimer = null;
      }
    }, 1_000);
  } catch (error) {
    log(`FATAL(spawn): ${error.message}`);
    process.exitCode = 1;
  }
});

bot.on("kicked", (reason) => log(`kicked: ${reason}`));
bot.on("error", (error) => log(`error: ${error.message}`));

// 45 秒后经 manager API 验证（异步持久化已 flush）
setTimeout(async () => {
  try {
    await sleep(1_500); // 等 reporter 队列 + store flush
    const headers = { Authorization: `Bearer ${secrets.dashboardToken}` };
    const response = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents?status=open`, { headers });
    log(`GET status=${response.status}`);
    const body = await response.json();
    log(`incidents(open) total=${body.total}`);
    for (const issue of body.issues ?? []) {
      log(`- ${issue.incidentId} ${issue.type}/${issue.primaryFailureCode} layer=${issue.suspectedLayer} count=${issue.occurrenceCount} bots=${JSON.stringify(issue.affectedBotIds)}`);
    }
    const first = (body.issues ?? [])[0];
    if (first) {
      const detailResponse = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents/${first.incidentId}`, { headers });
      const detail = await detailResponse.json();
      for (const occurrence of (detail.occurrences ?? []).slice(-3)) {
        log(`occurrence ${occurrence.occurrenceId}: pos=${JSON.stringify(occurrence.position)} skill=${occurrence.skillId}`);
        log(`  expected="${occurrence.expected}"`);
        log(`  actual="${occurrence.actual}"`);
      }
    }
    log("STUCK-E2E VERIFICATION DONE");
  } catch (error) {
    log(`verify failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    bot.quit();
    setTimeout(() => process.exit(process.exitCode ?? 0), 1_000);
  }
}, 45_000);
