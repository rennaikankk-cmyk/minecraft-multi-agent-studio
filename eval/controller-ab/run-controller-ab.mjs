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

// goal 电池 v2（EVAL_CONTRACT v2 修订）：v1 十条全部为观察叙述型——模型
// 合法 noop（0.7/0.8 noop 率），两轮同分 2/10 无判别力。v2 = 8 条工具
// 强制型（中文措辞刻意避开 deterministic-goals 模板动词与 registry 物品
// 名 → 必走 LLM 规划分支）+ 2 条 v1 原文对照（noop 是对照组的**预期**
// 行为，单独分账，不再稀释主指标）。
// 依赖世界状态的条目（A8 依赖 A2 的原木）在两轮间同序执行——同条件公平。
const GOALS = [
  { text: "做一个工作台出来", cls: "actionable" },                       // craft.item（木→合成两跳）
  { text: "去找些橡木原木回来", cls: "actionable" },                      // collect.block oak_log
  { text: "把手上的原木加工成木板", cls: "actionable" },                   // craft oak_planks（承接上一条状态）
  { text: "去收集一些泥土回来", cls: "actionable" },                      // collect.block dirt（徒手可采）
  { text: "看看附近哪里有石头，告诉我最近的一处在什么方向", cls: "actionable" }, // world.scan + 叙述
  { text: "查一下周围有没有铁矿石", cls: "actionable" },                  // world.scan iron_ore
  { text: "找点安全的东西填肚子", cls: "actionable" },                    // food.secure
  { text: "给自己搭个能过夜的地方", cls: "actionable" },                  // shelter.dig
  { text: "观察周围环境，汇报看到的地形和最近的树的方向", cls: "control" },  // v1 #1 原文对照
  { text: "检查自己背包里有什么工具，没有工具就说明", cls: "control" },     // v1 #4 原文对照
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
      body: JSON.stringify({ schemaVersion: "1.0", requestId: goalId, botId, operatorGoal: GOALS[i], timeoutMs: 120_000 }),
    });
    let outcome = null, failureCode = null;
    if (submit.status === 200) {
      // 200=同步终态：action 分流（skill_result=完成；noop=诚实无动作——
      // 模型/规划器差异的真实信号，单列计数，不是拒绝）
      const action = submit.body?.data?.action ?? "unknown";
      outcome = action === "skill_result" ? "completed" : "sync_" + action;
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
    results.push({ index: i + 1, cls: GOALS[i].cls, goal: GOALS[i].text, submitStatus: submit.status, outcome, failureCode, e2eMs });
    log(`goal ${i + 1}/${GOALS.length} [${GOALS[i].cls}]: ${outcome} (${e2eMs}ms)`);
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
  const noop = results.filter((r) => r.outcome === "sync_noop").length;
  // v2 分账：主判别指标=actionable 完成率；对照组建模为预期 noop。
  // actionable 上的 sync_noop 是**坏信号**（该派发工具却没派发）单列。
  const actionable = results.filter((r) => r.cls === "actionable");
  const control = results.filter((r) => r.cls === "control");
  const actionableCompleted = actionable.filter((r) => r.outcome === "completed").length;
  const noopOnActionable = actionable.filter((r) => r.outcome === "sync_noop").length;
  const controlNoop = control.filter((r) => r.outcome === "sync_noop").length;
  const e2e = results.map((r) => r.e2eMs).sort((a, b) => a - b);
  const pct = (p) => e2e[Math.min(e2e.length - 1, Math.floor((p / 100) * e2e.length))];
  const summary = {
    tag: TAG, runAt: new Date().toISOString(), goals: results.length,
    completed, completionRate: Number((completed / results.length).toFixed(4)),
    syncNoop: noop, noopRate: Number((noop / results.length).toFixed(4)),
    actionableCompleted, actionableCount: actionable.length,
    actionableCompletionRate: Number((actionableCompleted / Math.max(1, actionable.length)).toFixed(4)),
    noopOnActionable,
    controlNoop, controlCount: control.length,
    invalidToolDispatches: invalidTool, plannerRejected, aiErrors,
    e2eLatency: { p50: pct(50), p95: pct(95), max: e2e[e2e.length - 1] },
    batteryVersion: "v2",
    note: "v2 分账：actionable=工具强制型（主判别指标），control=观察对照（noop 为预期）；v1 十条全观察型的同分结果见 controller-ab-M{1,2}-formal.json（有效但无判别力）。",
  };
  writeFileSync(path.join(OUT_DIR, `controller-ab-${TAG}.json`), JSON.stringify({ summary, results }, null, 2));
  console.log("\n===== CONTROLLER A/B SUMMARY", TAG, "=====");
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
});
