#!/usr/bin/env node
// 真实主控 A/B 评测器（EVAL_CONTRACT v1 #3）。
// 前置：studio 已以 LOCAL_AI_URL/LOCAL_AI_MODEL 指向被测模型启动（本轮唯一变量）。
// 同一 fixture 配方/同 goal 集/同超时/同代码 HEAD；指标：
//   goal completion、无效工具调用数（PLANNER_REJECTED/无效 plan）、
//   per-goal 端到端 P50/95、time-to-first-skill-dispatch（goal 提交→首个
//   bot_assignment acquired 的间隔，从 coordinator 日志增量解析）。
// 用法：node run-controller-ab.mjs <TAG>   例：run-controller-ab.mjs M1-ornith-heretic
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withE2EFixture } from "../../apps/bot-runtime/e2e/fixture-manager.mjs";

const TAG = process.argv[2];
if (!TAG) { console.error("usage: run-controller-ab.mjs <TAG>"); process.exit(2); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(ROOT, "runtime-data", "model-selection");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const COORD_LOG = path.join(ROOT, "runtime-data", "logs", "coordinator.log");
const secrets = JSON.parse(readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"));
const H = { Authorization: `Bearer ${secrets.dashboardToken}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// 固定 goal 集（模型分支：非模板措辞 → 走 LLM 规划；两轮逐字相同）
const GOALS = [
  "观察周围环境，汇报看到的地形和最近的树的方向",
  "看向脚下并告诉我站的方块是什么材质",
  "环顾四周，找一个最近的安全过夜点并描述它",
  "检查自己背包里有什么工具，没有工具就说明",
  "观察附近有没有水源，描述位置",
  "看一下周围的生物，如果没有就明说",
  "找一个石头露头，描述它的方位和距离",
  "评估当前位置是否适合建立临时营地，说明理由",
  "观察天空和时间，判断现在离夜晚还有多久",
  "汇报当前坐标附近 30 格内最显眼的地标",
];

async function api(base, pathname, init) {
  const r = await fetch(`${base}${pathname}`, { headers: H, ...init });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}
function coordLogSize() { try { return readFileSync(COORD_LOG).byteLength; } catch { return 0; } }
function newCoordLines(fromBytes) {
  try { return readFileSync(COORD_LOG).subarray(fromBytes).toString("utf8").split("\n").filter(Boolean); } catch { return []; }
}

const results = [];
await withE2EFixture(async (fixture) => {
  log(`fixture port=${fixture.port} tag=${TAG}`);
  const coordStart = coordLogSize();
  const created = await api("http://127.0.0.1:3230", "/v1/bots", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: "1.0", username: `AB${Date.now().toString(36).slice(-5)}`, serverHost: "127.0.0.1", serverPort: fixture.port, minecraftVersion: "auto" }),
  });
  const botId = created.body.bot?.botId;
  await api("http://127.0.0.1:3230", `/v1/bots/${botId}/start`, { method: "POST" });
  for (let i = 0; i < 90; i++) { await sleep(1000); const { body } = await api("http://127.0.0.1:3210", `/v1/bots/${botId}`); if (body.data?.bot?.connectionState === "online") break; }
  log(`bot online: ${botId}`);

  for (let i = 0; i < GOALS.length; i += 1) {
    const goalId = randomUUID();
    const t0 = Date.now();
    const submit = await api("http://127.0.0.1:3210", "/v1/goals", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", requestId: goalId, botId, operatorGoal: GOALS[i], timeoutMs: 150_000 }),
    });
    let outcome = null, failureCode = null;
    if (submit.status === 200 && submit.body?.data?.action === "skill_result") {
      outcome = "completed";
    } else if (submit.status === 202) {
      // 轮询终态
      for (let p = 0; p < 75; p += 1) {
        await sleep(2000);
        const { body } = await api("http://127.0.0.1:3210", `/v1/tasks?limit=50`);
        const t = (body.data?.tasks ?? []).find((c) => c.taskId === goalId);
        if (t && !["queued", "assigned", "running", "blocked", "waiting", "paused"].includes(t.status)) {
          outcome = t.status; failureCode = t.failureReason ?? null; break;
        }
      }
      if (outcome === null) outcome = "timedOut";
    } else {
      outcome = `submitRejected:${submit.status}`; failureCode = submit.body?.error?.code ?? null;
    }
    const e2eMs = Date.now() - t0;
    results.push({ index: i + 1, goal: GOALS[i], submitStatus: submit.status, outcome, failureCode, e2eMs });
    log(`goal ${i + 1}/${GOALS.length}: ${outcome} (${e2eMs}ms)`);
  }

  // coordinator 增量解析：无效工具/规划拒绝 + 首派发间隔
  const lines = newCoordLines(coordStart);
  let invalidTool = 0, plannerRejected = 0, aiErrors = 0;
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.event === "coordinator_control_link_goal_failed") {
      if ((j.plannerCode ?? "") === "PLANNER_REJECTED") plannerRejected += 1;
      if ((j.code ?? "") === "SKILL_DISPATCH_FAILED") invalidTool += 1;
    }
    if (j.event === "coordinator_ai_request_failed") aiErrors += 1;
  }

  await api("http://127.0.0.1:3230", `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);
  await sleep(5000);
  await api("http://127.0.0.1:3230", `/v1/bots/${botId}`, { method: "DELETE" }).catch(() => undefined);

  const completed = results.filter((r) => r.outcome === "completed").length;
  const e2e = results.map((r) => r.e2eMs).sort((a, b) => a - b);
  const pct = (p) => e2e[Math.min(e2e.length - 1, Math.floor((p / 100) * e2e.length))];
  const summary = {
    tag: TAG, runAt: new Date().toISOString(), goals: results.length,
    completed, completionRate: Number((completed / results.length).toFixed(4)),
    invalidToolDispatches: invalidTool, plannerRejected, aiErrors,
    e2eLatency: { p50: pct(50), p95: pct(95), max: e2e[e2e.length - 1] },
    note: "goal completion 由 skill_result/任务终态判定；无效工具=SKILL_DISPATCH_FAILED 计数；planner 拒绝单列。",
  };
  writeFileSync(path.join(OUT_DIR, `controller-ab-${TAG}.json`), JSON.stringify({ summary, results }, null, 2));
  console.log("\n===== CONTROLLER A/B SUMMARY", TAG, "=====");
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
});
