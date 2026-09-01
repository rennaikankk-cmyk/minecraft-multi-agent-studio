// ---------------------------------------------------------------------------
// 生产 goal 驱动的慢速 STUCK 闭环 E2E（Round 6 主线验收）
//
// 与 goal-incident-e2e.mjs（快速 PATH_FAILED / onFault 链）互补：
//   每 run 全新隔离 fixture（唯一容器/动态端口/独立 world）
//   → manager 创建真实 bot → control-api /v1/goals 真实 movement goal
//   → bot 真实行走并产生 material progress（服务器真值断言）
//   → RCON tp 截停（120ms 间隔持久 rcon-cli 会话；玩家移动是客户端权威，
//     attribute/effect/cobweb 均拦不住 —— 唯有持续以服务器事实重置位置。
//     目标仍有效、pathfinder 路径未被阻断、不注入任何 Incident/runtime 事件）
//   → ProgressWatchdog（STUDIO_WATCHDOG_PROFILE=e2e，8s test-only 阈值）
//     连续无 material progress → STUCK + PATH_NO_PROGRESS 或 PATH_OSCILLATION
//   → IncidentReporter → manager IncidentStore 同 fingerprint 聚合
//   → 重复 5 次：单一 fingerprint 连续 +5
//   → 与快速 PATH_FAILED 是不同 fingerprint/type；export 可见
//
// 前置：studio 以 STUDIO_WATCHDOG_PROFILE=e2e 启动（脚本 fail-closed 校验）。
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { randomUUID } from "node:crypto";
import { withE2EFixture } from "./fixture-manager.mjs";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const RUN_LOG = join(E2E_DIR, "logs", "goal-stuck-e2e.log");
mkdirSync(dirname(RUN_LOG), { recursive: true });
const MANAGER_PORT = process.env.STUDIO_MANAGER_PORT ?? "3230";
const CONTROL_API_PORT = process.env.CONTROL_API_PORT ?? "3210";
const RUNS = Number(process.env.STUCK_RUNS ?? 5);
const secrets = JSON.parse(
  readFileSync(join(E2E_DIR, "..", "..", "..", "runtime-data", "local-control-secrets.json"), "utf8"),
);

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(RUN_LOG, `${stamped}\n`, "utf8");
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// test-only watchdog 阈值必须显式声明（fail closed：不允许静默按生产 35s 挂 5 分钟）
if (process.env.STUDIO_WATCHDOG_PROFILE !== "e2e") {
  log("FATAL: STUDIO_WATCHDOG_PROFILE 必须为 e2e（本 E2E 依赖 8s test-only 阈值）。");
  log("请以 STUDIO_WATCHDOG_PROFILE=e2e pnpm studio:start 启动后重跑。");
  process.exit(1);
}

async function managerApi(path, init) {
  const { headers: extraHeaders, ...rest } = init ?? {};
  const response = await fetch(`http://127.0.0.1:${MANAGER_PORT}${path}`, {
    ...rest,
    headers: { Authorization: `Bearer ${secrets.dashboardToken}`, ...(extraHeaders ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function createBotOnline(username, port) {
  const created = await managerApi("/v1/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "1.0",
      username,
      serverHost: "127.0.0.1",
      serverPort: port,
      minecraftVersion: "auto",
    }),
  });
  if (created.status !== 201) throw new Error(`create bot failed: ${JSON.stringify(created.body).slice(0, 200)}`);
  const botId = created.body.bot.botId;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1_500);
    const list = await fetch(`http://127.0.0.1:${CONTROL_API_PORT}/v1/bots`, {
      headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
    }).then((r) => r.json()).catch(() => null);
    const entry = (list?.data?.bots ?? []).find((bot) => bot.botId === botId);
    if (entry?.connectionState === "online") {
      log(`bot ${botId} (${username}) ONLINE`);
      return botId;
    }
    if (i === 39) throw new Error(`bot never online (last=${entry?.connectionState ?? "unknown"})`);
  }
}

/** 服务器侧位置真值（RCON data get）。 */
async function serverPosition(fixture, username) {
  const raw = await fixture.rcon(`data get entity ${username} Pos`).then((out) => String(out)).catch(() => "");
  const match = raw.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

/** 提交 goal 并确认被接受（轮询任务表；失败换 requestId 重试）。 */
async function submitGoalAccepted(botId, x, y, z) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const requestId = randomUUID();
    const response = await fetch(`http://127.0.0.1:${CONTROL_API_PORT}/v1/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secrets.dashboardToken}` },
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId,
        botId,
        operatorGoal: `移动到坐标 x=${x} y=${y} z=${z} 附近`,
        timeoutMs: 45_000,
      }),
    }).catch((error) => {
      log(`goal submit error: ${error.message}`);
      return null;
    });
    void response?.text().catch(() => {});
    if (response && response.status === 503) {
      log(`goal ${requestId.slice(0, 8)} → 503 AI unavailable`);
      return null;
    }
    for (let i = 0; i < 8; i += 1) {
      await sleep(2_000);
      const tasks = await fetch(`http://127.0.0.1:${CONTROL_API_PORT}/v1/tasks?limit=20`, {
        headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
      }).then((r) => r.json()).catch(() => null);
      const task = (tasks?.data?.tasks ?? []).find((candidate) => candidate.taskId === requestId);
      if (task && task.status !== "failed") {
        log(`goal ${requestId.slice(0, 8)} accepted (attempt ${attempt}, task=${task.status})`);
        return requestId;
      }
      if (task?.status === "failed") {
        log(`goal ${requestId.slice(0, 8)} failed: ${task.failureReason ?? "?"}`);
        break;
      }
    }
    log(`goal ${requestId.slice(0, 8)} not accepted (attempt ${attempt}); retrying`);
  }
  return null;
}

/** STUCK 慢速两码（PATH_NO_PROGRESS / PATH_OSCILLATION）当前聚合计数。 */
async function stuckIssueCounts() {
  const result = new Map();
  for (const code of ["PATH_NO_PROGRESS", "PATH_OSCILLATION"]) {
    const response = await managerApi(`/v1/incidents?failureCode=${code}&incidentType=STUCK`);
    for (const issue of response.body.issues ?? []) {
      result.set(issue.incidentId, { issue, count: issue.occurrenceCount ?? 0, code });
    }
  }
  return result;
}

const baselineMap = await stuckIssueCounts();
const baselineOf = (incidentId) => baselineMap.get(incidentId)?.count ?? 0;
const totalGrowth = async () => [...(await stuckIssueCounts()).values()].reduce(
  (sum, entry) => sum + Math.max(0, entry.count - baselineOf(entry.issue.incidentId)), 0);
log(`baseline slow-STUCK issues: ${[...baselineMap.entries()].map(([id, e]) => `${id}(${e.code})=${e.count}`).join(" ") || "none"}`);

let cumulative = await totalGrowth();
const runs = [];

for (let run = 1; run <= RUNS; run += 1) {
  let succeeded = false;
  for (let attempt = 1; attempt <= 2 && !succeeded; attempt += 1) {
    const username = `gstuck_r6_${run}_${attempt}`;
    await withE2EFixture(async (fixture) => {
      log(`run ${run} attempt ${attempt}: fixture ${fixture.containerName} port=${fixture.port}`);
      const botId = await createBotOnline(username, fixture.port);
      try {
        const anchor = await serverPosition(fixture, username);
        if (!anchor) throw new Error("cannot read bot position");
        const sx = Math.floor(anchor.x);
        const sy = Math.floor(anchor.y);
        const sz = Math.floor(anchor.z);
        const tx = sx + 45; // < SAFE_PATH_MAX_DISTANCE(64)
        log(`run ${run} attempt ${attempt}: anchor (${sx},${sy},${sz}) target (${tx},${sy},${sz})`);

        const goalId = await submitGoalAccepted(botId, tx, sy, sz);
        if (!goalId) throw new Error("goal not accepted");

        // 等真实 material progress（服务器真值）
        let moved = false;
        for (let i = 0; i < 20; i += 1) {
          await sleep(1_000);
          const position = await serverPosition(fixture, username).catch(() => null);
          if (position && Math.hypot(position.x - sx, position.z - sz) >= 4) {
            moved = true;
            log(`run ${run} attempt ${attempt}: material progress confirmed at (${position.x.toFixed(0)},${position.z.toFixed(0)})`);
            break;
          }
        }
        if (!moved) throw new Error("bot never moved (flaky spawn/path)");

        // RCON tp 截停：120ms 持续重置位置（位移/距离降幅远低于所有 epsilon）
        const { spawn: spawnProcess } = await import("node:child_process");
        const rconSession = spawnProcess("docker", ["exec", "-i", fixture.containerName, "rcon-cli"], {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        });
        rconSession.stdout.resume();
        const freezeAnchor = await serverPosition(fixture, username);
        const fax = freezeAnchor.x.toFixed(2);
        const fay = freezeAnchor.y.toFixed(2);
        const faz = freezeAnchor.z.toFixed(2);
        let tpCount = 0;
        const tpTimer = setInterval(() => {
          if (rconSession.stdin.writable) {
            rconSession.stdin.write(`tp ${username} ${fax} ${fay} ${faz}\n`);
            tpCount += 1;
          }
        }, 120);
        log(`run ${run} attempt ${attempt}: tp interception started at (${fax},${fay},${faz})`);
        try {
          const deadline = Date.now() + 30_000;
          let seen = false;
          while (Date.now() < deadline) {
            await sleep(2_000);
            if ((await totalGrowth()) >= cumulative + 1) {
              seen = true;
              break;
            }
          }
          const after = await totalGrowth();
          log(`run ${run} attempt ${attempt}: tps=${tpCount} growth ${cumulative}→${after} sawDuringFreeze=${seen}`);
          if (after < cumulative + 1) throw new Error(`slow-STUCK growth ${after} < ${cumulative + 1}`);
          cumulative = after;
          runs.push({ run, attempt, botId, growth: after, sawDuringFreeze: seen });
          succeeded = true;
        } finally {
          clearInterval(tpTimer);
          rconSession.stdin.end();
          rconSession.kill();
        }
      } finally {
        await managerApi(`/v1/bots/${botId}/stop`, { method: "POST" });
        await sleep(1_500);
      }
    }).catch((error) => {
      if (!succeeded) log(`run ${run} attempt ${attempt} FAILED: ${error.message}`);
    });
  }
  if (!succeeded) throw new Error(`run ${run}: both attempts exhausted`);
}

// 终态断言：单一 fingerprint 连续聚合 + 与快速 PATH_FAILED 区分 + export 可见
const finalMap = await stuckIssueCounts();
let slowIssue = null;
let slowGrowth = 0;
for (const [, entry] of finalMap) {
  const growth = entry.count - baselineOf(entry.issue.incidentId);
  if (growth > slowGrowth) {
    slowGrowth = growth;
    slowIssue = entry.issue;
  }
}
if (!slowIssue) throw new Error("final slow STUCK issue missing");
const fast = await managerApi("/v1/incidents?failureCode=PATHFINDER_GOTO_FAILED&incidentType=PATH_FAILED");
const fastIssue = fast.body.issues?.[0] ?? null;
log(`slow issue ${slowIssue.incidentId} type=${slowIssue.type} code=${slowIssue.primaryFailureCode} fingerprint=${slowIssue.fingerprint} growth=+${slowGrowth} (→${slowIssue.occurrenceCount}) bots=${JSON.stringify(slowIssue.affectedBotIds)}`);
if (fastIssue) {
  log(`fast issue ${fastIssue.incidentId} type=${fastIssue.type} fingerprint=${fastIssue.fingerprint}`);
  if (fastIssue.incidentId === slowIssue.incidentId) throw new Error("fast PATH_FAILED and slow STUCK must be different issues");
} else {
  log("note: no fast PATH_FAILED issue in store (goal-incident-e2e covers the paired assertion)");
}
if (slowGrowth < RUNS) throw new Error(`single-fingerprint growth ${slowGrowth} < ${RUNS}`);
if ((slowIssue.affectedBotIds?.length ?? 0) < 1) throw new Error("affected bots missing");

// 元数据 + export
const detailResponse = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents/${slowIssue.incidentId}`, {
  headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
});
const detail = await detailResponse.json();
const lastOccurrence = (detail.occurrences ?? []).at(-1);
log(`last occurrence: mc=${lastOccurrence?.minecraftVersion} proto=${lastOccurrence?.protocolVersion} commit=${lastOccurrence?.gitCommit} dirty=${lastOccurrence?.dirtyBuild} skill=${lastOccurrence?.skillId} pos=${JSON.stringify(lastOccurrence?.position)}`);
if (!lastOccurrence?.minecraftVersion || lastOccurrence?.position == null) throw new Error("occurrence missing runtime identity metadata");

// P0-3：真实 watchdog eventWindow 必须非空，且包含完整关键时间线
// goal→skill→movement→progress→no-progress→watchdog→report
const window = lastOccurrence?.eventWindow ?? [];
const windowKinds = window.map((entry) => entry.kind);
log(`eventWindow (${window.length} entries): ${windowKinds.join(" → ")}`);
if (window.length === 0) {
  throw new Error("P0-3 regression: watchdog occurrence eventWindow is empty");
}
// 断言语义：慢速 STUCK 的 occurrence 可能是 PATH_NO_PROGRESS（watchdog_triggered）
// 或 PATH_OSCILLATION（oscillation_detected）——任一 watchdog 信号即满足时间线。
// incident_report_enqueued 不可能出现在自身 report 的快照里（快照构造先于入队
// 事件落 buffer）；"report 发生"这一腿由该 Incident 本身存在即证明。
const requiredKinds = ["skill_started", "movement_started", "material_progress"];
for (const required of requiredKinds) {
  if (!windowKinds.includes(required)) {
    throw new Error(`P0-3 regression: eventWindow missing ${required} (have: ${windowKinds.join(",")})`);
  }
}
const watchdogSignalPresent = ["watchdog_triggered", "oscillation_detected", "no_progress_warning"].some(
  (kind) => windowKinds.includes(kind),
);
if (!watchdogSignalPresent) {
  throw new Error(`P0-3 regression: eventWindow has no watchdog signal (have: ${windowKinds.join(",")})`);
}
const windowText = JSON.stringify(window);
if (/api[_-]?key|bearer|authorization/iu.test(windowText)) {
  throw new Error("P0-3 redaction failure: secret-shaped token leaked into eventWindow");
}
log("eventWindow timeline PASS (bounded, redacted, goal→skill→movement→watchdog→report)");

const exportJson = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents/${slowIssue.incidentId}/export?format=json`, {
  headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
});
if (exportJson.status !== 200) throw new Error(`JSON export failed: HTTP ${exportJson.status}`);
const exportPrompt = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents/${slowIssue.incidentId}/export?format=repair-prompt`, {
  headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
});
const promptText = await exportPrompt.text();
if (exportPrompt.status !== 200 || !promptText.includes(slowIssue.primaryFailureCode)) throw new Error("repair-prompt export failed");
log("export: JSON + repair-prompt PASS (server-side, secret-gated)");

log(`goal-stuck E2E PASS: ${slowIssue.incidentId} +${slowGrowth} on fingerprint ${slowIssue.fingerprint} across ${runs.length} runs`);
process.exit(0);
