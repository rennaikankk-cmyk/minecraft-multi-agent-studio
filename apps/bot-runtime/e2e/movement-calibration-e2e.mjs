// ---------------------------------------------------------------------------
// Movement progress 校准 E2E（Round 5 P0 验收）
//
// 每个场景一个全新隔离 fixture（唯一容器/动态端口/独立 world/finally cleanup）。
// 使用真实 mineflayer/pathfinder + 真实 ProgressWatchdog（runtime 同一代码）。
// 不 mock watchdog 事件；Incident 仅在 jitter 场景上报并经 manager API 校验聚合。
//
// 场景矩阵（验收标准）：
//   STATIC          静止            → stuck 在 [4.5,12]s
//   JITTER ×5       箱内物理抖动     → 每次都在 [4.5,15]s 触发 stuck
//   OSCILLATION     小半径往返       → oscillation ≥1 且 5s 内不重复
//   SLOW_APPROACH   慢速持续接近     → 不误报
//   NORMAL_PATH     正常寻路         → 不误报
//   KNOCKBACK       单次外力位移     → 之后停滞仍触发（有界延迟 ≤17s）
//   RECOVERING      恢复动作无脱困   → 30s 上限后恰好一次 deadline-exceeded
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import mineflayer from "mineflayer";

import { ProgressWatchdog } from "../dist/progress-watchdog.js";
import { IncidentReporter, watchdogEventToSignal } from "../dist/incident-reporter.js";
import { withE2EFixture } from "./fixture-manager.mjs";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const RUN_LOG = join(E2E_DIR, "logs", "movement-calibration.log");
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createBotOn(port, username) {
  return mineflayer.createBot({
    host: "127.0.0.1", port, username,
    auth: "offline", hideErrors: true, logErrors: false,
  });
}

/** 通用采样器：真实位置 → 真实 watchdog；返回事件记录 [{atMs, kind, ageMs, diagnostics}]。 */
function startSamplerAt(bot, watchdog, intervalMs, { contract = "MOVE_TO_TARGET", phaseKey = null, onSignal } = {}) {
  const positions = [];
  const startedAt = Date.now();
  const events = [];
  const timer = setInterval(() => {
    if (!bot.entity) return;
    const raw = bot.entity.position;
    const position = { x: Math.floor(raw.x * 100) / 100, y: Math.floor(raw.y * 100) / 100, z: Math.floor(raw.z * 100) / 100 };
    positions.push(position);
    const observed = watchdog.observe({
      observedAtMs: Date.now(),
      position,
      active: true,
      movementExpected: contract === "MOVE_TO_TARGET",
      contract,
      ...(phaseKey ? { phaseKey } : {}),
    });
    for (const event of observed) {
      events.push({ atMs: Date.now() - startedAt, kind: event.kind, ageMs: event.ageMs, diagnostics: event.diagnostics ?? null });
      if (onSignal && (event.kind === "stuck" || event.kind === "oscillation" || event.kind === "loop")) {
        onSignal(event, position);
      }
    }
  }, intervalMs);
  return { events, positions, stop: () => clearInterval(timer), startedAt };
}

function startSampler(bot, watchdog, { contract = "MOVE_TO_TARGET", phaseKey = null, onSignal } = {}) {
  const startedAt = Date.now();
  const events = [];
  const timer = setInterval(() => {
    if (!bot.entity) return;
    const raw = bot.entity.position;
    const position = { x: Math.floor(raw.x * 100) / 100, y: Math.floor(raw.y * 100) / 100, z: Math.floor(raw.z * 100) / 100 };
    const observed = watchdog.observe({
      observedAtMs: Date.now(),
      position,
      active: true,
      movementExpected: contract === "MOVE_TO_TARGET",
      contract,
      ...(phaseKey ? { phaseKey } : {}),
    });
    for (const event of observed) {
      events.push({ atMs: Date.now() - startedAt, kind: event.kind, ageMs: event.ageMs, diagnostics: event.diagnostics ?? null });
      if (onSignal && (event.kind === "stuck" || event.kind === "oscillation" || event.kind === "loop")) {
        onSignal(event, position);
      }
    }
  }, 1_000);
  return { events, stop: () => clearInterval(timer), startedAt };
}

async function runScenario(name, fn) {
  const startedAt = Date.now();
  try {
    const result = await withE2EFixture((fixture) => fn(fixture));
    log(`RESULT ${name}: PASS (${Math.round((Date.now() - startedAt) / 1000)}s) ${JSON.stringify(result ?? {})}`);
    return { name, pass: true, ...(result ?? {}) };
  } catch (error) {
    log(`RESULT ${name}: FAIL — ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

/** 等待 bot spawn + 世界稳定。 */
function waitSpawn(bot, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("spawn timeout")), timeoutMs);
    bot.once("spawn", () => { clearTimeout(timer); resolve(); });
    bot.once("kicked", (reason) => { clearTimeout(timer); reject(new Error(`kicked: ${String(reason).slice(0, 100)}`)); });
    bot.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

/** S1 完全静止。 */
async function scenarioStatic(fixture) {
  const bot = createBotOn(fixture.port, "calib_static_1");
  await waitSpawn(bot);
  await sleep(1_500);
  const watchdog = new ProgressWatchdog({ stuckAfterMs: 5_000, noProgressAfterMs: 15_000 });
  const sampler = startSampler(bot, watchdog, { contract: "MOVE_TO_TARGET" });
  await sleep(14_000);
  sampler.stop();
  bot.quit();
  const stuck = sampler.events.filter((event) => event.kind === "stuck");
  if (stuck.length === 0) throw new Error("no stuck fired");
  const first = stuck[0];
  if (first.ageMs < 4_500 || first.ageMs > 12_000) throw new Error(`stuck age ${first.ageMs}ms outside [4500,12000]`);
  return { stuckAtMs: first.ageMs, stuckCount: stuck.length };
}

/** S2 箱内物理抖动（跑 N 次）。 */
async function scenarioJitter(fixture, runIndex) {
  const bot = createBotOn(fixture.port, `calib_jit_${runIndex}`);
  await waitSpawn(bot);
  await sleep(1_500);
  // 实心箱 + 3x3 内腔 + 平整地板（不挖出：box 内无 goal，pathfinder 未启用）
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-2 ~-1 ~-2 ~2 ~4 ~2 minecraft:cobblestone").catch(() => {});
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-1 ~ ~-1 ~1 ~3 ~1 minecraft:air").catch(() => {});
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-1 ~-1 ~-1 ~1 ~-1 ~1 minecraft:cobblestone").catch(() => {});
  const watchdog = new ProgressWatchdog({ stuckAfterMs: 5_000, noProgressAfterMs: 15_000 });
  const reporter = new IncidentReporter({
    botId: "studio-bot-03",
    endpoint: `http://127.0.0.1:${MANAGER_PORT}/v1/incidents`,
    token: secrets.dashboardToken,
    logger: { warn: () => undefined },
  });
  const sampler = startSampler(bot, watchdog, {
    contract: "MOVE_TO_TARGET",
    onSignal: (event, position) => {
      reporter.report(watchdogEventToSignal({
        event,
        position,
        dimension: "minecraft:overworld",
        skillId: "calibration-scenario",
        expectedProgress: "steady progress toward active goal (contract MOVE_TO_TARGET)",
        actualProgress: `${event.kind} after ${event.ageMs}ms without material progress (calibration jitter scenario)`,
      }));
    },
  });
  await sleep(16_000);
  sampler.stop();
  bot.quit();
  const stuck = sampler.events.filter((event) => event.kind === "stuck");
  if (stuck.length === 0) throw new Error("no stuck fired (jitter masked as progress?)");
  const first = stuck[0];
  if (first.ageMs < 4_500 || first.ageMs > 15_000) throw new Error(`stuck age ${first.ageMs}ms outside [4500,15000]`);
  return { run: runIndex, stuckAtMs: first.ageMs, diag: first.diagnostics };
}

/** S3 小半径往返振荡。 */
async function scenarioOscillation(fixture) {
  const bot = createBotOn(fixture.port, "calib_osc_1");
  await waitSpawn(bot);
  await sleep(1_500);
  // 走廊：平整 + 两侧墙 + 两端封
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-4 ~-1 ~-1 ~4 ~-1 ~1 minecraft:cobblestone").catch(() => {});
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-4 ~ ~-1 ~4 ~4 ~1 minecraft:air").catch(() => {});
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-4 ~ ~-2 ~4 ~3 ~-2 minecraft:cobblestone").catch(() => {});
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-4 ~ ~2 ~4 ~3 ~2 minecraft:cobblestone").catch(() => {});
  const pathfinderModule = await import("mineflayer-pathfinder");
  const pathfinder = pathfinderModule.default ?? pathfinderModule;
  bot.loadPlugin(pathfinder.pathfinder);
  const movements = new pathfinder.Movements(bot);
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);
  const raw = bot.entity.position;
  const y = Math.floor(raw.y); const z = Math.floor(raw.z);
  const goalA = new pathfinder.goals.GoalBlock(Math.floor(raw.x) + 2, y, z);
  const goalB = new pathfinder.goals.GoalBlock(Math.floor(raw.x) - 2, y, z);
  const watchdog = new ProgressWatchdog({ stuckAfterMs: 30_000, noProgressAfterMs: 60_000 });
  let toggle = false;
  const switcher = setInterval(() => {
    toggle = !toggle;
    bot.pathfinder.setGoal(toggle ? goalA : goalB);
  }, 1_000);
  const sampler = startSamplerAt(bot, watchdog, 500, { contract: "MOVE_TO_TARGET" });
  await sleep(20_000);
  clearInterval(switcher);
  sampler.stop();
  bot.quit();
  const oscillations = sampler.events.filter((event) => event.kind === "oscillation");
  if (oscillations.length === 0) {
    const xs = sampler.positions.map((pos) => pos.x);
    throw new Error(`no oscillation fired; x extent=[${Math.min(...xs)},${Math.max(...xs)}] origin=${xs[0]}`);
  }
  // 去重：任意 5s 窗口内不超过 1 次
  for (let i = 1; i < oscillations.length; i += 1) {
    if (oscillations[i].atMs - oscillations[i - 1].atMs < 5_000) {
      throw new Error(`oscillation re-fired within 5s (${oscillations[i - 1].atMs} -> ${oscillations[i].atMs})`);
    }
  }
  return { oscillationCount: oscillations.length, firstAtMs: oscillations[0].atMs };
}

/** S4 慢速但持续接近（slowness VI）。 */
async function scenarioSlowApproach(fixture) {
  const bot = createBotOn(fixture.port, "calib_slow_1");
  await waitSpawn(bot);
  await sleep(1_500);
  await fixture.rcon(`effect give ${bot.username} minecraft:slowness 999 4`).catch(() => {});
  // 平地
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-2 ~-1 ~-1 ~64 ~-1 ~1 minecraft:cobblestone").catch(() => {});
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-2 ~ ~-1 ~64 ~4 ~1 minecraft:air").catch(() => {});
  const pathfinderModule = await import("mineflayer-pathfinder");
  const pathfinder = pathfinderModule.default ?? pathfinderModule;
  bot.loadPlugin(pathfinder.pathfinder);
  const raw = bot.entity.position;
  bot.pathfinder.setGoal(new pathfinder.goals.GoalBlock(Math.floor(raw.x) + 60, Math.floor(raw.y), Math.floor(raw.z)));
  const watchdog = new ProgressWatchdog({ stuckAfterMs: 5_000, noProgressAfterMs: 15_000 });
  const sampler = startSampler(bot, watchdog, { contract: "MOVE_TO_TARGET" });
  await sleep(14_000);
  sampler.stop();
  bot.quit();
  const falseStuck = sampler.events.filter((event) => event.kind === "stuck" || event.kind === "oscillation");
  if (falseStuck.length > 0) {
    const trace = sampler.events.map((event) => `${event.atMs}:${event.kind}${event.diagnostics ? `(net=${event.diagnostics.windowNetDisplacement.toFixed(1)},drop=${event.diagnostics.windowTargetDistanceDrop === null ? "n/a" : event.diagnostics.windowTargetDistanceDrop.toFixed(1)},path=${Math.round(event.diagnostics.windowPathLength)},rev=${event.diagnostics.reversals})` : ""}`).join(" ");
    throw new Error(`false positive: ${falseStuck.map((event) => event.kind).join(",")} | trace: ${trace.slice(0, 600)}`);
  }
  return { note: "no stuck/oscillation while slowly approaching" };
}

/** S5 正常寻路。 */
async function scenarioNormalPath(fixture) {
  const bot = createBotOn(fixture.port, "calib_norm_1");
  await waitSpawn(bot);
  await sleep(3_000); // 落地后再铺路（falling 时相对坐标会铺错层）
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-2 ~-1 ~-1 ~44 ~-1 ~1 minecraft:cobblestone").catch(() => {});
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-2 ~ ~-1 ~44 ~4 ~1 minecraft:air").catch(() => {});
  const pathfinderModule = await import("mineflayer-pathfinder");
  const pathfinder = pathfinderModule.default ?? pathfinderModule;
  bot.loadPlugin(pathfinder.pathfinder);
  const raw = bot.entity.position;
  bot.pathfinder.setGoal(new pathfinder.goals.GoalBlock(Math.floor(raw.x) + 40, Math.floor(raw.y), Math.floor(raw.z)));
  const watchdog = new ProgressWatchdog({ stuckAfterMs: 5_000, noProgressAfterMs: 15_000 });
  const sampler = startSampler(bot, watchdog, { contract: "MOVE_TO_TARGET" });
  await sleep(12_000);
  sampler.stop();
  bot.quit();
  const falseStuck = sampler.events.filter((event) => event.kind === "stuck" || event.kind === "oscillation" || event.kind === "no-progress");
  if (falseStuck.length > 0) {
    const trace = sampler.events.map((event) => `${event.atMs}:${event.kind}${event.diagnostics ? `(net=${event.diagnostics.windowNetDisplacement.toFixed(1)},rev=${event.diagnostics.reversals})` : ""}`).join(" ");
    throw new Error(`false positive: ${falseStuck.map((event) => event.kind).join(",")} | trace: ${trace.slice(0, 500)}`);
  }
  return { note: "normal pathfinding clean" };
}

/** S6 单次外力位移后继续停滞。 */
async function scenarioKnockback(fixture) {
  const bot = createBotOn(fixture.port, "calib_kb_1");
  await waitSpawn(bot);
  await sleep(1_500);
  // 第一只箱（原地）+ 第二只箱（+6x，供 tp 后仍被困）
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-2 ~-1 ~-2 ~2 ~4 ~2 minecraft:cobblestone").catch(() => {});
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~-1 ~ ~-1 ~1 ~3 ~1 minecraft:air").catch(() => {});
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~4 ~-1 ~-2 ~10 ~4 ~2 minecraft:cobblestone").catch(() => {});
  await fixture.rcon("execute as " + bot.username + " at @s run fill ~5 ~ ~-1 ~9 ~3 ~1 minecraft:air").catch(() => {});
  const watchdog = new ProgressWatchdog({ stuckAfterMs: 5_000, noProgressAfterMs: 15_000 });
  const sampler = startSampler(bot, watchdog, { contract: "MOVE_TO_TARGET" });
  await sleep(10_000);
  // 外力位移：tp 到第二只箱中心（瞬间位移 ~6 格）
  await fixture.rcon(`execute as ${bot.username} at @s run tp @s ~6 ~ ~`).catch(() => {});
  await sleep(20_000);
  sampler.stop();
  bot.quit();
  const stuckEvents = sampler.events.filter((event) => event.kind === "stuck");
  if (stuckEvents.length < 2) throw new Error(`expected stuck before AND after knockback, got ${stuckEvents.length}`);
  const first = stuckEvents[0];
  const last = stuckEvents.at(-1);
  if (last.atMs < 14_000) throw new Error(`post-knockback stuck too early at ${last.atMs}ms (knockback at 10000ms)`);
  if (last.atMs > 25_000) throw new Error(`post-knockback stuck too late at ${last.atMs}ms (>15000ms after knockback)`);
  return { firstStuckAtMs: first.atMs, postKnockbackStuckAtMs: last.atMs };
}

/** S7 RECOVERING 独立超时。 */
async function scenarioRecovering(fixture) {
  const bot = createBotOn(fixture.port, "calib_rec_1");
  await waitSpawn(bot);
  await sleep(1_500);
  const watchdog = new ProgressWatchdog({ stuckAfterMs: 5_000, noProgressAfterMs: 15_000 });
  const sampler = startSampler(bot, watchdog, { contract: "RECOVERING", phaseKey: "recover:calib-1" });
  await sleep(40_000);
  sampler.stop();
  bot.quit();
  const deadlines = sampler.events.filter((event) => event.kind === "deadline-exceeded");
  if (deadlines.length !== 1) throw new Error(`expected exactly 1 deadline-exceeded, got ${deadlines.length}`);
  if (deadlines[0].atMs < 29_000 || deadlines[0].atMs > 35_000) {
    throw new Error(`deadline-exceeded at ${deadlines[0].atMs}ms outside [29000,35000]`);
  }
  const stuck = sampler.events.filter((event) => event.kind === "stuck");
  if (stuck.length > 0) throw new Error("RECOVERING must not produce movement-stuck");
  return { deadlineAtMs: deadlines[0].atMs };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const jitterReporter = []; // jitter 场景的 reporters，供 flush
const results = [];

log("=== movement calibration E2E start ===");
const ONLY = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7)?.split(",") ?? null;
const want = (name) => !ONLY || ONLY.includes(name);

if (want("STATIC")) results.push(await runScenario("STATIC", scenarioStatic));
if (want("JITTER")) for (let run = 1; run <= 5; run += 1) {
  results.push(await runScenario(`JITTER#${run}`, (fixture) => scenarioJitter(fixture, run)));
}
if (want("OSCILLATION")) results.push(await runScenario("OSCILLATION", scenarioOscillation));
if (want("SLOW")) results.push(await runScenario("SLOW_APPROACH", scenarioSlowApproach));
if (want("NORMAL")) results.push(await runScenario("NORMAL_PATH", scenarioNormalPath));
if (want("KNOCKBACK")) results.push(await runScenario("KNOCKBACK", scenarioKnockback));
if (want("RECOVERING")) results.push(await runScenario("RECOVERING", scenarioRecovering));

// jitter 重复故障的 incident 聚合校验（跨 5 次 run 同 fingerprint）
try {
  await sleep(2_000);
  const response = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents?failureCode=PATH_NO_PROGRESS`, {
    headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
  });
  const body = await response.json();
  const stuckIssue = (body.issues ?? [])[0];
  if (stuckIssue) {
    log(`INCIDENT-AGG: ${stuckIssue.incidentId} ${stuckIssue.primaryFailureCode} layer=${stuckIssue.suspectedLayer} count=${stuckIssue.occurrenceCount}`);
    results.push({ name: "INCIDENT_AGG", pass: stuckIssue.occurrenceCount >= 5, occurrenceCount: stuckIssue.occurrenceCount });
  } else {
    log("INCIDENT-AGG: no PATH_NO_PROGRESS issue found (jitter reports may have failed)");
    results.push({ name: "INCIDENT_AGG", pass: false, error: "missing issue" });
  }
} catch (error) {
  log(`INCIDENT-AGG check failed: ${error.message}`);
  results.push({ name: "INCIDENT_AGG", pass: false, error: error.message });
}

log("=== calibration matrix ===");
for (const result of results) {
  log(`${result.pass ? "PASS" : "FAIL"} ${result.name}${result.stuckAtMs !== undefined ? ` stuckAt=${result.stuckAtMs}ms` : ""}${result.occurrenceCount !== undefined ? ` occurrences=${result.occurrenceCount}` : ""}${result.error ? ` — ${result.error}` : ""}`);
}
const failed = results.filter((result) => !result.pass);
log(`=== ${results.length - failed.length}/${results.length} scenarios passed ===`);
process.exit(failed.length === 0 ? 0 : 1);
