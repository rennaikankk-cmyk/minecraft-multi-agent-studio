#!/usr/bin/env node
// L2/L3/L4 — Restart/Stop/Kill 三场景。
// L2: goal 在 bot registering 时提交，bot 重启后 goal 自动执行
// L3: user stop 不产生 BOT_CRASH
// L4: 外部 kill 恰好产生 1 个 Incident
import { readFileSync } from "node:fs";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function api(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

// BOT_PROCESS_EXITED issue 按 primaryFailureCode 去重累计（occurrenceCount），
// 崩溃计数必须用 occurrenceCount 之和；issue 对象上没有 per-exit 的 classification 字段，
// 期望/意外由 /v1/status 的 bot.exit.classification 判定。
async function crashOccurrences() {
  const { body } = await api(MANAGER, "/v1/incidents?limit=200");
  return (body.issues ?? [])
    .filter((i) => (i.primaryFailureCode ?? "") === "BOT_PROCESS_EXITED")
    .reduce((s, i) => s + (i.occurrenceCount ?? 0), 0);
}

async function botExit(botId) {
  const { body } = await api(MANAGER, "/v1/status");
  const b = (body.bots ?? []).find((x) => x.botId === botId);
  return b ? { processState: b.processState, exit: b.exit ?? null } : null;
}

async function createBot(fixture, tag) {
  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `${tag}${Date.now().toString(36).slice(-5)}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
  });
  return { botId: created.body.bot?.botId, username: created.body.bot?.username };
}

async function waitTask(requestId, timeoutMs) {
  for (let i = 0; i < Math.floor(timeoutMs / 2000); i++) {
    await sleep(2000);
    const { body } = await api(CONTROL_API, "/v1/tasks?limit=20");
    const t = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
    if (t && (t.status === "completed" || t.status === "failed")) return t;
  }
  return null;
}

const RESULTS = {};

await withE2EFixture(async (fixture) => {
  log(`fixture port=${fixture.port}`);

  // ================================================================
  // L2: Restart During Registration
  // ================================================================
  log("\n--- L2: Restart During Registration ---");
  const l2bot = await createBot(fixture, "L2R");
  const l2GoalId = randomUUID();

  // 启动 bot
  await api(MANAGER, `/v1/bots/${l2bot.botId}/start`, { method: "POST" });
  await sleep(3000); // bot 正在 registering

  // 立即提交 goal（bot 未完全 ready）
  const l2Submit = await api(CONTROL_API, "/v1/goals", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", requestId: l2GoalId, botId: l2bot.botId, operatorGoal: "移动到坐标 x=0 y=70 z=0 附近", timeoutMs: 120_000 }),
  });
  log(`L2 goal submitted during registration: HTTP ${l2Submit.status} action=${l2Submit.body?.data?.action}`);

  // 立即重启 bot（不等 goal 执行）
  await api(MANAGER, `/v1/bots/${l2bot.botId}/restart`, { method: "POST" });
  log("L2 bot restarted while goal waiting");

  // 等 goal 终态
  const l2Task = await waitTask(l2GoalId, 180_000);
  RESULTS.L2 = {
    submitStatus: l2Submit.status,
    submitAction: l2Submit.body?.data?.action,
    taskStatus: l2Task?.status,
    taskFound: l2Task !== null,
    completed: l2Task?.status === "completed",
    passed: l2Submit.status === 202 && l2Task?.status === "completed",
  };
  log(`L2: submit=${l2Submit.status}/${l2Submit.body?.data?.action} task=${l2Task?.status} → ${RESULTS.L2.passed ? "PASS" : "FAIL"}`);

  // 清理
  await api(MANAGER, `/v1/bots/${l2bot.botId}/stop`, { method: "POST" }).catch(() => undefined);
  await sleep(3000);

  // ================================================================
  // L3: Stop Provenance (user stop → zero BOT_CRASH)
  // ================================================================
  log("\n--- L3: Stop Provenance ---");
  const crashBeforeL3 = await crashOccurrences();
  const l3bot = await createBot(fixture, "L3S");
  await api(MANAGER, `/v1/bots/${l3bot.botId}/start`, { method: "POST" });

  // 等 bot online
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const { body } = await api(CONTROL_API, "/v1/bots");
    const b = (body.data?.bots ?? []).find((x) => x.botId === l3bot.botId);
    if (b?.connectionState === "online") break;
  }
  log(`L3 bot online`);

  // User stop
  await api(MANAGER, `/v1/bots/${l3bot.botId}/stop`, { method: "POST" });
  let l3Exit = null;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    l3Exit = await botExit(l3bot.botId);
    if (l3Exit?.processState === "stopped" && l3Exit.exit) break;
  }
  const crashAfterL3 = await crashOccurrences();

  RESULTS.L3 = {
    crashDelta: crashAfterL3 - crashBeforeL3,
    exitClassification: l3Exit?.exit?.classification ?? null,
    passed: (crashAfterL3 - crashBeforeL3) === 0 && l3Exit?.exit?.classification === "EXPECTED_STOP",
  };
  log(`L3: BOT_CRASH delta=${crashAfterL3 - crashBeforeL3} exit=${l3Exit?.exit?.classification} → ${RESULTS.L3.passed ? "PASS" : "FAIL"}`);

  // ================================================================
  // L4: External Termination (kill → exactly 1 Incident)
  // ================================================================
  log("\n--- L4: External Termination ---");
  const { execSync } = await import("node:child_process");
  const crashBeforeL4 = await crashOccurrences();
  const l4bot = await createBot(fixture, "L4K");
  await api(MANAGER, `/v1/bots/${l4bot.botId}/start`, { method: "POST" });

  // 等 bot online + 获取 PID
  let pid = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const { body } = await api(MANAGER, "/v1/status");
    const b = (body.bots ?? []).find((x) => x.botId === l4bot.botId);
    if (b?.pid && b.processState === "running") { pid = b.pid; break; }
    const { body: botsBody } = await api(CONTROL_API, "/v1/bots");
    const bb = (botsBody.data?.bots ?? []).find((x) => x.botId === l4bot.botId);
    if (bb?.connectionState === "online") {
      const statusBody = await api(MANAGER, "/v1/status");
      const sb = (statusBody.body.bots ?? []).find((x) => x.botId === l4bot.botId);
      if (sb?.pid) { pid = sb.pid; break; }
    }
  }
  log(`L4 bot online, pid=${pid}`);

  if (pid !== null) {
    // 外部 kill（模拟进程崩溃）
    try {
      execSync(`taskkill /PID ${pid} /F`, { shell: "cmd.exe", stdio: "ignore" });
      log(`L4 killed pid ${pid}`);
    } catch (e) {
      log(`L4 kill failed: ${e.message}`);
    }
  }

  // 等 manager 检测到退出并归档 exit classification（轮询而非固定 sleep）
  let l4Exit = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    l4Exit = await botExit(l4bot.botId);
    if (l4Exit?.exit) break;
  }
  // 再等 issue 聚合出现
  let crashAfterL4 = crashBeforeL4;
  for (let i = 0; i < 10; i++) {
    crashAfterL4 = await crashOccurrences();
    if (crashAfterL4 > crashBeforeL4) break;
    await sleep(2000);
  }

  RESULTS.L4 = {
    pid,
    killed: pid !== null,
    crashDelta: crashAfterL4 - crashBeforeL4,
    exitClassification: l4Exit?.exit?.classification ?? null,
    passed: pid !== null && (crashAfterL4 - crashBeforeL4) === 1 && l4Exit?.exit?.classification === "UNEXPECTED_CRASH",
  };
  log(`L4: BOT_CRASH delta=${crashAfterL4 - crashBeforeL4} exit=${l4Exit?.exit?.classification} → ${RESULTS.L4.passed ? "PASS" : "FAIL"}`);

  // 清理
  await api(MANAGER, `/v1/bots/${l4bot.botId}/stop`, { method: "POST" }).catch(() => undefined);

  // ================================================================
  console.log("\n========== L2/L3/L4 RESULTS ==========");
  console.log(JSON.stringify(RESULTS, null, 2));
  const l2p = RESULTS.L2?.passed ?? false;
  const l3p = RESULTS.L3?.passed ?? false;
  const l4p = RESULTS.L4?.passed ?? false;
  console.log(`L2: ${l2p ? "PASS" : "FAIL"} | L3: ${l3p ? "PASS" : "FAIL"} | L4: ${l4p ? "PASS" : "FAIL"}`);
  process.exit(l2p && l3p && l4p ? 0 : 2);
});
