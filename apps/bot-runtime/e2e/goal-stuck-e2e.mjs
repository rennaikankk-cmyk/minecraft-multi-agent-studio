// ---------------------------------------------------------------------------
// 生产 goal 驱动的慢速 STUCK 闭环 E2E（Round 6 主线验收）
//
// 与 goal-incident-e2e.mjs（快速 PATH_FAILED / onFault 链）互补：
//   隔离 fixture → manager 创建真实 bot → control-api /v1/goals 真实 movement goal
//   → bot 真实行走并产生 material progress（断言位移）
//   → RCON tp 循环"截停"（服务器事实：目标仍有效、pathfinder 路径未被阻断、
//     不注入任何 Incident/runtime 事件）
//   → ProgressWatchdog（STUDIO_WATCHDOG_PROFILE=e2e，8s test-only 阈值）
//     连续无 material progress → STUCK / PATH_NO_PROGRESS
//   → IncidentReporter → manager IncidentStore 同 fingerprint 聚合
//   → 重复 5 次：occurrenceCount 1 → 5，affected bots 统计正确
//   → API/export 可见 + 与快速 PATH_FAILED 是不同 fingerprint/type
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
  log(`bot ${botId} (${username}) created`);
  for (let i = 0; i < 40; i += 1) {
    await sleep(1_500);
    const list = await fetch(`http://127.0.0.1:${CONTROL_API_PORT}/v1/bots`, {
      headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
    }).then((r) => r.json()).catch(() => null);
    const entry = (list?.data?.bots ?? []).find((bot) => bot.botId === botId);
    if (entry?.connectionState === "online") {
      log(`bot ${botId} ONLINE`);
      return botId;
    }
    if (i === 39) throw new Error(`bot never online (last=${entry?.connectionState ?? "unknown"})`);
  }
}

async function botPosition(botId) {
  const detail = await fetch(`http://127.0.0.1:${CONTROL_API_PORT}/v1/bots/${botId}`, {
    headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
  }).then((r) => r.json()).catch(() => null);
  const position = detail?.data?.bot?.position;
  if (!position || typeof position.x !== "number") return null;
  return { x: position.x, y: position.y, z: position.z };
}

async function submitGoalFireAndForget(botId, x, y, z) {
  const requestId = randomUUID();
  void fetch(`http://127.0.0.1:${CONTROL_API_PORT}/v1/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secrets.dashboardToken}` },
    body: JSON.stringify({
      schemaVersion: "1.0",
      requestId,
      botId,
      operatorGoal: `移动到坐标 x=${x} y=${y} z=${z} 附近`,
      timeoutMs: 45_000,
    }),
  }).then((response) => log(`goal ${requestId.slice(0, 8)} → HTTP ${response.status}`))
    .catch((error) => log(`goal submit error: ${error.message}`));
  return requestId;
}

const result = await withE2EFixture(async (fixture) => {
  log(`fixture: container=${fixture.containerName} port=${fixture.port} world=${fixture.volumeName}`);

  // 基线：STUCK / PATH_NO_PROGRESS 当前聚合计数（不依赖历史数据证明本轮）
  const baseline = await managerApi("/v1/incidents?failureCode=PATH_NO_PROGRESS&incidentType=STUCK");
  const baselineIssue = baseline.body.issues?.[0] ?? null;
  const baselineCount = baselineIssue?.occurrenceCount ?? 0;
  const baselineBots = baselineIssue?.affectedBotIds?.length ?? 0;
  log(`baseline STUCK/PATH_NO_PROGRESS: ${baselineIssue?.incidentId ?? "none"} count=${baselineCount}`);

  const runs = [];
  for (let run = 1; run <= RUNS; run += 1) {
    const username = `gstuck_r6_${run}`;
    const botId = await createBotOnline(username, fixture.port);

    // 平整出发点 + 远处目标（开阔地，路径可达 —— 不封路）
    const spawn = await fixture.rcon(`data get entity ${username} Pos`).then((out) => String(out)).catch(() => "?");
    const match = spawn.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/);
    if (!match) throw new Error(`cannot read bot position: ${spawn.slice(0, 120)}`);
    const sx = Math.floor(Number(match[1]));
    const sy = Math.floor(Number(match[2]));
    const sz = Math.floor(Number(match[3]));
    const tx = sx + 90;
    const tz = sz;
    // 出发点平台（防出生地形卡位）；目标同样高度的平地
    await fixture.rcon(`execute as ${username} at @s run fill ~-3 ~-1 ~-3 ~3 ~-1 ~3 minecraft:stone`).catch(() => {});
    await fixture.rcon(`execute as ${username} at @s run tp ${username} ${sx} ${sy} ${sz}`).catch(() => {});
    log(`run ${run}: anchor (${sx},${sy},${sz}) target (${tx},${sy},${tz})`);

    // 真实 goal（fire-and-forget：同步等待会错过行走窗口）
    await submitGoalFireAndForget(botId, tx, sy, tz);

    // 等真实 material progress：位移 ≥ 4 格
    let moved = false;
    let startPos = null;
    for (let i = 0; i < 30; i += 1) {
      await sleep(1_000);
      const position = await botPosition(botId);
      if (position) {
        if (!startPos) startPos = { ...position };
        if (Math.hypot(position.x - sx, position.z - sz) >= 4) {
          moved = true;
          log(`run ${run}: material progress confirmed at (${position.x.toFixed(0)},${position.z.toFixed(0)})`);
          break;
        }
      }
    }
    if (!moved) throw new Error(`run ${run}: bot never made material progress toward target`);

    // RCON 截停：每 1.2s tp 回出发点附近（目标仍有效、路径未被墙阻断、
    // pathfinder 不返回 PATH_FAILED —— 纯"无 material progress"窗口）
    const freezeStart = Date.now();
    const freezeMs = 32_000;
    let freezes = 0;
    const freezeTimer = setInterval(() => {
      void fixture.rcon(`execute as ${username} at @s run tp ${username} ${sx} ${sy + 0.1} ${sz}`)
        .then(() => { freezes += 1; })
        .catch(() => {});
    }, 1_200);
    const stopFreeze = () => clearInterval(freezeTimer);
    try {
      // 等 STUCK/PATH_NO_PROGRESS occurrence（8s 阈值 + reporter/flush 余量）
      let seen = null;
      for (let i = 0; i < 30; i += 1) {
        await sleep(2_000);
        const current = await managerApi("/v1/incidents?failureCode=PATH_NO_PROGRESS&incidentType=STUCK&botId=" + botId);
        const issue = current.body.issues?.[0];
        if (issue && (issue.occurrenceCount ?? 0) > (seen?.occurrenceCount ?? (baselineIssue?.incidentId === issue.incidentId ? baselineCount : 0))) {
          seen = issue;
          break;
        }
        if (Date.now() - freezeStart > freezeMs) break;
      }
      const after = await managerApi("/v1/incidents?failureCode=PATH_NO_PROGRESS&incidentType=STUCK");
      const issue = after.body.issues?.[0] ?? null;
      const count = issue?.occurrenceCount ?? 0;
      const expected = baselineCount + run;
      runs.push({ run, botId, count, expected, frozeWith: freezes, sawDuringFreeze: seen !== null });
      log(`run ${run}: count=${count} (expected ${expected}) freezes=${freezes} sawDuringFreeze=${seen !== null}`);
      if (count < expected) {
        throw new Error(`run ${run}: occurrenceCount ${count} < ${expected}（慢速 STUCK 未聚合）`);
      }
    } finally {
      stopFreeze();
      await managerApi(`/v1/bots/${botId}/stop`, { method: "POST" });
      await sleep(2_000);
    }
  }

  // 终态断言：聚合 + affected bots + 与快速 PATH_FAILED 的 fingerprint/type 区分
  const final = await managerApi("/v1/incidents?failureCode=PATH_NO_PROGRESS&incidentType=STUCK");
  const slowIssue = final.body.issues?.[0] ?? null;
  if (!slowIssue) throw new Error("final slow STUCK issue missing");
  const fast = await managerApi("/v1/incidents?failureCode=PATHFINDER_GOTO_FAILED&incidentType=PATH_FAILED");
  const fastIssue = fast.body.issues?.[0] ?? null;
  log(`slow issue ${slowIssue.incidentId} type=${slowIssue.type} fingerprint=${slowIssue.fingerprint} count=${slowIssue.occurrenceCount} bots=${JSON.stringify(slowIssue.affectedBotIds)}`);
  if (fastIssue) {
    log(`fast issue ${fastIssue.incidentId} type=${fastIssue.type} fingerprint=${fastIssue.fingerprint}`);
    if (fastIssue.incidentId === slowIssue.incidentId) {
      throw new Error("fast PATH_FAILED and slow STUCK must be different issues/fingerprints");
    }
  } else {
    log("note: no fast PATH_FAILED issue present in this store (run goal-incident-e2e for the paired assertion)");
  }
  if (slowIssue.occurrenceCount < baselineCount + RUNS) {
    throw new Error(`final count ${slowIssue.occurrenceCount} < ${baselineCount + RUNS}`);
  }
  if ((slowIssue.affectedBotIds?.length ?? 0) < baselineBots + RUNS) {
    throw new Error("affected bots count did not grow with each run");
  }

  // 元数据断言：生产链路的 runtime 身份
  const detailResponse = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents/${slowIssue.incidentId}`, {
    headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
  });
  const detail = await detailResponse.json();
  const lastOccurrence = (detail.occurrences ?? []).at(-1);
  log(`last occurrence: mc=${lastOccurrence?.minecraftVersion} proto=${lastOccurrence?.protocolVersion} commit=${lastOccurrence?.gitCommit} dirty=${lastOccurrence?.dirtyBuild} skill=${lastOccurrence?.skillId} pos=${JSON.stringify(lastOccurrence?.position)}`);
  if (!lastOccurrence?.minecraftVersion || lastOccurrence?.position == null) {
    throw new Error("slow STUCK occurrence missing runtime identity metadata");
  }

  // export 可见（JSON + repair prompt 经服务端生成 + secret gate）
  const exportJson = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents/${slowIssue.incidentId}/export?format=json`, {
    headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
  });
  if (exportJson.status !== 200) throw new Error(`slow STUCK JSON export failed: HTTP ${exportJson.status}`);
  const exportPrompt = await fetch(`http://127.0.0.1:${MANAGER_PORT}/v1/incidents/${slowIssue.incidentId}/export?format=repair-prompt`, {
    headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
  });
  const promptText = await exportPrompt.text();
  if (exportPrompt.status !== 200 || !promptText.includes("PATH_NO_PROGRESS")) {
    throw new Error(`slow STUCK repair prompt export failed: HTTP ${exportPrompt.status}`);
  }
  log("export: JSON + repair-prompt PASS (server-side, secret-gated)");

  return {
    runs,
    issue: slowIssue.incidentId,
    fingerprint: slowIssue.fingerprint,
    finalCount: slowIssue.occurrenceCount,
    baselineCount,
    affectedBots: slowIssue.affectedBotIds,
  };
});

log(`RESULT: ${JSON.stringify(result)}`);
log(`goal-stuck E2E PASS: occurrenceCount ${result.baselineCount} → ${result.finalCount} across ${result.runs.length} runs`);
process.exit(0);
