// ---------------------------------------------------------------------------
// 真实 STUCK Incident 验证 —— 跑在完全隔离的 E2E fixture 上
//
// fixture：唯一容器 studio-e2e-<runId>、动态端口、独立 world volume、
// finally cleanup、stale 回收、串行锁（fixture-manager.mjs）。
//
// 链路：真 fixture 服务器 → 真 mineflayer bot 登录 → 真 pathfinder →
// RCON 装箱（可控 no-progress）→ 真实 ProgressWatchdog（runtime 代码，
// MOVE_TO_TARGET 契约）→ 真实 IncidentReporter → manager 存储聚合 → API 查询。
//
// 诚实边界：goal/planner（LLM）层未参与；移动目标由本脚本给出。
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import mineflayer from "mineflayer";

import { ProgressWatchdog } from "../dist/progress-watchdog.js";
import { IncidentReporter, watchdogEventToSignal } from "../dist/incident-reporter.js";
import { withE2EFixture } from "./fixture-manager.mjs";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const RUN_LOG = join(E2E_DIR, "logs", "stuck-e2e.log");
mkdirSync(dirname(RUN_LOG), { recursive: true });
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

function createBotOn(port, username) {
  return mineflayer.createBot({
    host: "127.0.0.1",
    port,
    username,
    auth: "offline",
    hideErrors: true,
    logErrors: false,
  });
}

await withE2EFixture(async (fixture) => {
  log(`fixture ready: container=${fixture.containerName} port=${fixture.port} world=${fixture.volumeName}`);
  const reporter = new IncidentReporter({
    botId: "studio-bot-03",
    endpoint: `http://127.0.0.1:${MANAGER_PORT}/v1/incidents`,
    token: secrets.dashboardToken,
    logger: { warn: (message) => log(`reporter-warn: ${message}`) },
  });
  // 受控场景阈值压短（生产默认 8s/20s）
  const watchdog = new ProgressWatchdog({ stuckAfterMs: 5_000, noProgressAfterMs: 15_000 });

  const bot = createBotOn(fixture.port, "stuck_scen_01");
  let sampleTimer = null;

  bot.once("spawn", async () => {
    try {
      await sleep(2_000);
      log(`spawned at ${JSON.stringify(bot.entity?.position ?? "unknown")}`);

      const boxResult = await fixture
        .rcon("execute as stuck_scen_01 at @s run fill ~-2 ~-1 ~-2 ~2 ~4 ~2 minecraft:cobblestone")
        .then(() => fixture.rcon("execute as stuck_scen_01 at @s run fill ~-1 ~ ~-1 ~1 ~3 ~1 minecraft:air"))
        .then(() => fixture.rcon("execute as stuck_scen_01 at @s run fill ~-1 ~-1 ~-1 ~1 ~-1 ~1 minecraft:cobblestone"))
        .catch((error) => `rcon-failed: ${error.message}`);
      log(`box: ${String(boxResult).slice(0, 60)}`);

      const target = { x: 500, y: 64, z: 500 };
      const pathfinderModule = await import("mineflayer-pathfinder");
      const pathfinder = pathfinderModule.default ?? pathfinderModule;
      bot.loadPlugin(pathfinder.pathfinder);
      const movements = new pathfinder.Movements(bot);
      movements.canDig = false;
      movements.canSprint = false;
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new pathfinder.goals.GoalNear(target.x, target.y, target.z, 1));
      log(`goal set: (${target.x},64,${target.z}) — unreachable (boxed)`);

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
          contract: "MOVE_TO_TARGET",
          targetDistance: raw.distanceTo({ x: target.x, y: target.y, z: target.z }),
          goalKey: `minecraft:overworld:${target.x},64,${target.z}`,
        });
        for (const event of events) {
          if (event.kind === "progress") continue;
          log(`watchdog signal: ${event.kind} ageMs=${event.ageMs}`);
          if (event.kind === "stuck" || event.kind === "oscillation" || event.kind === "loop") {
            reporter.report(watchdogEventToSignal({
              event,
              position,
              dimension: "minecraft:overworld",
              skillId: "invoke-goto",
              expectedProgress: `target distance decreasing toward ${target.x},${target.z}`,
              actualProgress: `${event.kind} after ${event.ageMs}ms without material progress (boxed-in isolated fixture)`,
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

  bot.on("kicked", (reason) => log(`kicked: ${String(reason).slice(0, 120)}`));
  bot.on("error", (error) => log(`error: ${error.message}`));

  // 45 秒后验证
  await sleep(45_000);
  try {
    await sleep(1_500); // reporter 队列 + store flush
    const headers = { Authorization: `Bearer ${secrets.dashboardToken}` };
    const response = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents?status=open`, { headers });
    const body = await response.json();
    log(`incidents(open) total=${body.total}`);
    for (const issue of body.issues ?? []) {
      log(`- ${issue.incidentId} ${issue.type}/${issue.primaryFailureCode} layer=${issue.suspectedLayer} count=${issue.occurrenceCount} bots=${JSON.stringify(issue.affectedBotIds)}`);
    }
    const stuckIssue = (body.issues ?? []).find((issue) => issue.primaryFailureCode === "PATH_NO_PROGRESS");
    if (stuckIssue) {
      const detailResponse = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents/${stuckIssue.incidentId}`, { headers });
      const detail = await detailResponse.json();
      for (const occurrence of (detail.occurrences ?? []).slice(-2)) {
        log(`occurrence ${occurrence.occurrenceId}: pos=${JSON.stringify(occurrence.position)} skill=${occurrence.skillId}`);
        log(`  expected="${occurrence.expected}"`);
        log(`  actual="${occurrence.actual}"`);
      }
    } else {
      log("NO STUCK INCIDENT FOUND — verification FAILED");
      process.exitCode = 1;
    }
    log("STUCK-E2E VERIFICATION DONE");
  } catch (error) {
    log(`verify failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    bot.quit();
  }
});
