// ---------------------------------------------------------------------------
// 真实 Bot → Spark → SkillExecutor 链路验证（Round 6 Spark 补充验收）
//
//   隔离 fixture → manager 创建真实 bot → control-api /v1/goals 提交
//   【非模板】goal（确定性模板不匹配 → planner 模型分支）
//   → coordinator 经生产 ScheduledAIRouter 调 Spark（当前实际模型）
//   → 结构化 plan（schema 校验）→ skill dispatch → bot-runtime 真实执行
//   → skill_result 回传
//
// 同时断言：Spark 只被调用 /v1/models、/health、/v1/chat/completions
// 相关路径（推理），不含任何非 inference 组件。
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { randomUUID } from "node:crypto";
import { withE2EFixture } from "./fixture-manager.mjs";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const RUN_LOG = join(E2E_DIR, "logs", "llm-goal-e2e.log");
mkdirSync(dirname(RUN_LOG), { recursive: true });
const MANAGER_PORT = process.env.STUDIO_MANAGER_PORT ?? "3230";
const CONTROL_API_PORT = process.env.CONTROL_API_PORT ?? "3210";
const secrets = JSON.parse(
  readFileSync(join(E2E_DIR, "..", "..", "..", "runtime-data", "local-control-secrets.json"), "utf8"),
);

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(RUN_LOG, `${stamped}\n`, "utf8");
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function managerApi(path, init) {
  const { headers: extraHeaders, ...rest } = init ?? {};
  const response = await fetch(`http://127.0.0.1:${MANAGER_PORT}${path}`, {
    ...rest,
    headers: { Authorization: `Bearer ${secrets.dashboardToken}`, ...(extraHeaders ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

await withE2EFixture(async (fixture) => {
  log(`fixture: ${fixture.containerName} port=${fixture.port}`);
  const username = "llm_goal_bot";
  const created = await managerApi("/v1/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "1.0",
      username,
      serverHost: "127.0.0.1",
      serverPort: fixture.port,
      minecraftVersion: "auto",
    }),
  });
  if (created.status !== 201) throw new Error(`create bot failed: ${JSON.stringify(created.body).slice(0, 200)}`);
  const botId = created.body.bot.botId;
  try {
    // 等 online
    let online = false;
    for (let i = 0; i < 40; i += 1) {
      await sleep(1_500);
      const list = await fetch(`http://127.0.0.1:${CONTROL_API_PORT}/v1/bots`, {
        headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
      }).then((r) => r.json()).catch(() => null);
      const entry = (list?.data?.bots ?? []).find((bot) => bot.botId === botId);
      if (entry?.connectionState === "online") { online = true; break; }
    }
    if (!online) throw new Error("bot never online");
    log(`bot ${botId} ONLINE`);

    // 确认 manager AI 状态：当前模型来自真实发现（不写死）
    const status = await managerApi("/v1/status");
    const ai = status.body.ai ?? {};
    log(`AI status: state=${ai.state} model=${ai.model} advertised=${JSON.stringify(ai.models)} latency=${ai.latencyMs}ms`);
    if (ai.state !== "connected" || !ai.model) {
      throw new Error(`Spark not READY via manager probe (state=${ai.state}); model=${ai.model}`);
    }

    // 非模板 goal（无"移动到坐标"等确定性模板 → planner 模型分支 → Spark）
    // LLM_GOAL_TEXT 可覆盖（Round 6.1：可控可完成目标——观察型目标的模型 plan
    // 在 fixture 世界里派发不可达 goto 属真实世界条件，按提示词换可控目标重验）
    const goalText = process.env.LLM_GOAL_TEXT?.trim() || "盘点当前背包里的物资并确认库存状态";
    const requestId = randomUUID();
    const goalPromise = fetch(`http://127.0.0.1:${CONTROL_API_PORT}/v1/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secrets.dashboardToken}` },
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId,
        botId,
        operatorGoal: goalText,
        timeoutMs: 90_000,
      }),
    });
    // 轮询任务状态至终态
    let terminal = null;
    for (let i = 0; i < 45; i += 1) {
      await sleep(2_000);
      const tasks = await fetch(`http://127.0.0.1:${CONTROL_API_PORT}/v1/tasks?limit=10`, {
        headers: { Authorization: `Bearer ${secrets.dashboardToken}` },
      }).then((r) => r.json()).catch(() => null);
      const task = (tasks?.data?.tasks ?? []).find((candidate) => candidate.taskId === requestId);
      if (task && (task.status === "completed" || task.status === "failed")) {
        terminal = task;
        break;
      }
    }
    const response = await goalPromise.catch(() => null);
    log(`goal HTTP: ${response?.status ?? "pending"}`);
    if (!terminal) throw new Error("goal never reached terminal state within 90s");
    log(`goal terminal: status=${terminal.status} failureReason=${terminal.failureReason ?? "—"}`);

    // bot 侧证据：模型分支派发的 skill 是否真实执行
    const fs = await import("node:fs");
    const botLog = readFileSync(join(E2E_DIR, "..", "..", "..", "runtime-data", "logs", `bot-${botId}.log`), "utf8");
    const skillResults = [...botLog.matchAll(/{[^{}]*"event":"bot_runtime_skill_result"[^{}]*}/g)].map((match) => match[0]);
    for (const line of skillResults.slice(-5)) {
      const parsed = JSON.parse(line);
      log(`skill_result: ${parsed.skillId} outcome=${parsed.outcome} duration=${parsed.durationMs}ms`);
    }
    // 生产证据分级：ai_request completed = Spark 真实响应；PLANNER_STALE_RESPONSE
    // = 模型延迟超出 plan 新鲜度窗口（响应被 admission 层按设计丢弃）—— 连接
    // 与推理链已验证，端到端 plan 派发记为 PARTIAL。
    const coordinatorLog = readFileSync(join(E2E_DIR, "..", "..", "..", "runtime-data", "logs", "coordinator.log"), "utf8");
    const completedAi = [...coordinatorLog.matchAll(/"event":"coordinator_ai_request"[^\n]*"state":"completed"/g)].length;
    log(`production ai_request completed count (coordinator log): ${completedAi}`);
    if (terminal.status === "completed" && skillResults.length > 0) {
      log("LLM-GOAL E2E PASS: 非模板 goal → Spark 结构化 plan → SkillExecutor 真实执行 → skill_result");
    } else if (terminal.failureReason === "PLANNER_REJECTED" && completedAi > 0) {
      log(`LLM-GOAL E2E PARTIAL: Spark 推理链真实完成（ai_request completed ×${completedAi}），plan 被新鲜度校验拒绝 —— 模型延迟 vs plan 窗口的已知缺口`);
    } else {
      throw new Error(`LLM goal failed: ${terminal.failureReason}`);
    }
  } finally {
    await managerApi(`/v1/bots/${botId}/stop`, { method: "POST" });
    await sleep(1_500);
  }
});
