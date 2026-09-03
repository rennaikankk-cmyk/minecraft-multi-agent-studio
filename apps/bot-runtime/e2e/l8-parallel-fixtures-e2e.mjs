#!/usr/bin/env node
// L8 — Two parallel fixtures don't cross-kill or cross-pollute.
// 断言：
//   1) 同进程并行两个 fixture（A/B）都 ready 且全程存活
//   2) 外部进程跑 reclaimStaleFixtures（默认 10min 超龄）：A/B 均存活（skipped），
//      而「无主 + 超龄」的 dummy 容器被移除——owner+age 双闸各自生效
//   3) bot A 只存在于 server A、bot B 只存在于 server B（RCON 双向防串扰），
//      各自的移动 goal 在正确的服务器上生效（Pos 接近各自坐标）
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createE2EFixture, reclaimStaleFixtures, withFixtureLock, FIXTURE_LABEL } from "./fixture-manager.mjs";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "..", "..", "..");
const secrets = JSON.parse(readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"));
const MANAGER = `http://127.0.0.1:${process.env.STUDIO_MANAGER_PORT ?? "3230"}`;
const CONTROL_API = `http://127.0.0.1:${process.env.CONTROL_API_PORT ?? "3210"}`;
const HEADERS = { Authorization: `Bearer ${secrets.dashboardToken}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const ACTIVE = new Set(["queued", "assigned", "running", "blocked", "waiting", "paused"]);

function sh(cmd, args, timeoutMs = 60_000, cwd = process.cwd()) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, cwd }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout ?? "").trim(), stderr: (stderr ?? "").trim() });
    });
  });
}

async function api(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function botOnline(botId) {
  const { body } = await api(CONTROL_API, "/v1/bots");
  return (body.data?.bots ?? []).find((b) => b.botId === botId)?.connectionState === "online";
}

async function waitTaskTerminal(requestId, timeoutMs) {
  for (let i = 0; i < Math.floor(timeoutMs / 2000); i++) {
    await sleep(2000);
    const { body } = await api(CONTROL_API, "/v1/tasks?limit=50");
    const t = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
    if (t && !ACTIVE.has(t.status)) return t;
  }
  return null;
}

const RESULTS = {};
const IMAGE = process.env.STUDIO_E2E_IMAGE ?? "studio-e2e-mc-cached:1.21.11";

// —— 准备：无主 dummy 容器（docker create 不启动，StartedAt=0 → 对 reclaim 恒超龄）——
const dummyName = `studio-e2e-dummy-${Date.now().toString(36)}`;
const dummyCreated = await sh("docker", [
  "create", "--name", dummyName,
  "--label", FIXTURE_LABEL,
  "--label", "studio.ownerSessionId=4194304", // 永不存在的 owner
  IMAGE,
]);
log(`dummy container created: ${dummyCreated.ok} (${dummyName})`);

let fixtureA = null;
let fixtureB = null;
try {
  fixtureA = await withFixtureLock(() => createE2EFixture());
  fixtureB = await withFixtureLock(() => createE2EFixture());
  log(`fixture A: ${fixtureA.containerName} port=${fixtureA.port}`);
  log(`fixture B: ${fixtureB.containerName} port=${fixtureB.port}`);
  await Promise.all([fixtureA.waitReady(), fixtureB.waitReady()]);
  RESULTS.bothFixturesReady = true;

  // —— (2) 外部进程 reclaim 探针：不同 pid + 默认超龄 10min ——
  // 注意：Windows 绝对路径不能直接 dynamic import——用 cwd=e2e 目录 + 相对导入。
  const probeScript = `
    import('./fixture-manager.mjs').then(async (m) => {
      console.log('__RECLAIM__' + JSON.stringify(await m.reclaimStaleFixtures()));
    }).catch((e) => { console.error('PROBE-ERR ' + e.message); process.exit(1); });
  `;
  const probe = await sh(
    "node",
    ["-e", probeScript],
    120_000,
    E2E_DIR,
  );
  const probeResult = JSON.parse((probe.stdout.match(/__RECLAIM__(\{.*\})/) ?? [null, "{}"])[1]);
  RESULTS.reclaimProbe = probeResult;
  const aAlive = await sh("docker", ["inspect", "-f", "{{.State.Running}}", fixtureA.containerName]);
  const bAlive = await sh("docker", ["inspect", "-f", "{{.State.Running}}", fixtureB.containerName]);
  const dummyGone = !(await sh("docker", ["inspect", dummyName])).ok;
  RESULTS.fixturesSurvivedReclaim = aAlive.stdout === "true" && bAlive.stdout === "true";
  RESULTS.dummyReclaimed = dummyGone;
  RESULTS.aInSkipped = probeResult.skipped.includes(fixtureA.containerName);
  RESULTS.bInSkipped = probeResult.skipped.includes(fixtureB.containerName);
  log(`reclaim probe: removed=[${probeResult.removed.join(",")}] skipped=${probeResult.skipped.length}; A/B alive=${RESULTS.fixturesSurvivedReclaim}, dummy gone=${dummyGone}`);

  // —— (3) 双 fixture 各跑一个 bot + goal，RCON 验证不串扰 ——
  const nameA = `L8A${Date.now().toString(36).slice(-5)}`;
  const nameB = `L8B${Date.now().toString(36).slice(-5)}`;
  const mk = async (name, port) => {
    const created = await api(MANAGER, "/v1/bots", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", username: name, serverHost: "127.0.0.1", serverPort: port, minecraftVersion: "auto" }),
    });
    const botId = created.body.bot?.botId;
    await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      if (await botOnline(botId)) break;
    }
    return { botId, username: name };
  };
  const botA = await mk(nameA, fixtureA.port);
  const botB = await mk(nameB, fixtureB.port);
  log(`bots online: A=${botA.botId} B=${botB.botId}`);

  const goalA = randomUUID();
  const goalB = randomUUID();
  const submitA = await api(CONTROL_API, "/v1/goals", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", requestId: goalA, botId: botA.botId, operatorGoal: "移动到坐标 x=9 y=70 z=9 附近", timeoutMs: 120_000 }),
  });
  const submitB = await api(CONTROL_API, "/v1/goals", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", requestId: goalB, botId: botB.botId, operatorGoal: "移动到坐标 x=-9 y=70 z=-9 附近", timeoutMs: 120_000 }),
  });
  // 同步完成（200+skill_result）不算失败——这种 goal 不进 /v1/tasks，
  // 终局判定交给后面的 RCON 位置真值；异步（202）才轮询任务终态。
  const syncDone = (r) => r.status === 200 && r.body?.data?.action === "skill_result";
  const [taskA, taskB] = syncDone(submitA) && syncDone(submitB)
    ? [{ status: "completed" }, { status: "completed" }]
    : await Promise.all([
        syncDone(submitA) ? Promise.resolve({ status: "completed" }) : waitTaskTerminal(goalA, 180_000),
        syncDone(submitB) ? Promise.resolve({ status: "completed" }) : waitTaskTerminal(goalB, 180_000),
      ]);
  RESULTS.goalAStatus = taskA?.status ?? "not_found";
  RESULTS.goalBStatus = taskB?.status ?? "not_found";
  log(`goals terminal: A=${RESULTS.goalAStatus} B=${RESULTS.goalBStatus} (sync: ${syncDone(submitA)}/${syncDone(submitB)})`);

  // RCON 真值：位置正确 + 对侧不存在（防串扰）
  async function posOn(fixture, username) {
    const out = await fixture.rcon(`data get entity ${username}`);
    if (!/has the following entity data/.test(out)) return null;
    const m = out.match(/Pos:\s*\[([^\]]+)\]/);
    if (!m) return null;
    const [x, y, z] = m[1].split(",").map((v) => Number.parseFloat(v.replace(/[dD]$/, "")));
    return { x, y, z };
  }
  const posA_onA = await posOn(fixtureA, nameA);
  const posB_onA = await posOn(fixtureA, nameB);
  const posB_onB = await posOn(fixtureB, nameB);
  const posA_onB = await posOn(fixtureB, nameA);
  RESULTS.posA_onA = posA_onA;
  RESULTS.posB_onB = posB_onB;
  RESULTS.crossPolluted = posB_onA !== null || posA_onB !== null;
  const near = (p, tx, tz, r = 8) => p !== null && Math.abs(p.x - tx) <= r && Math.abs(p.z - tz) <= r;
  RESULTS.aLandedOnA = near(posA_onA, 9, 9);
  RESULTS.bLandedOnB = near(posB_onB, -9, -9);
  log(`posA@A=${JSON.stringify(posA_onA)} posB@B=${JSON.stringify(posB_onB)} cross=${RESULTS.crossPolluted}`);

  // fixture 全程存活复核
  const finalA = await sh("docker", ["inspect", "-f", "{{.State.Running}}", fixtureA.containerName]);
  const finalB = await sh("docker", ["inspect", "-f", "{{.State.Running}}", fixtureB.containerName]);
  RESULTS.fixturesAliveAtEnd = finalA.stdout === "true" && finalB.stdout === "true";

  RESULTS.passed =
    RESULTS.bothFixturesReady &&
    RESULTS.fixturesSurvivedReclaim &&
    RESULTS.dummyReclaimed &&
    RESULTS.aInSkipped && RESULTS.bInSkipped &&
    RESULTS.goalAStatus === "completed" &&
    RESULTS.goalBStatus === "completed" &&
    !RESULTS.crossPolluted &&
    RESULTS.aLandedOnA && RESULTS.bLandedOnB &&
    RESULTS.fixturesAliveAtEnd;

  await api(MANAGER, `/v1/bots/${botA.botId}/stop`, { method: "POST" }).catch(() => undefined);
  await api(MANAGER, `/v1/bots/${botB.botId}/stop`, { method: "POST" }).catch(() => undefined);
  await sleep(4000);
} finally {
  await fixtureA?.cleanup().catch(() => undefined);
  await fixtureB?.cleanup().catch(() => undefined);
  await sh("docker", ["rm", "-f", dummyName]);
}

console.log("\n========== L8 RESULTS ==========");
console.log(JSON.stringify(RESULTS, null, 2));
console.log(`L8: ${RESULTS.passed ? "PASS" : "FAIL"}`);
process.exit(RESULTS.passed ? 0 : 2);
