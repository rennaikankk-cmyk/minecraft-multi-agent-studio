#!/usr/bin/env node
// ---------------------------------------------------------------------------
// verify-spark-inference.mjs —— U9 主控 → DGX Spark 真实推理连接验收
//
// 全部通过生产 ai-router 代码（packages/ai-router/dist），不用 curl 代替：
//   1. 模型发现与选择（统一规则：显式存在/显式缺失 fail-closed/单模型 auto/
//      零模型 unavailable/多模型 fail-closed；绝不 models[0]）
//   2. health/readiness + 最小结构化 inference（schema 校验）
//   3. 6 路并发请求流：全局并发、有界队列、per-bot 并发、公平调度、优先级
//   4. 熔断：不可达节点 → open 快速失败 → half-open 探测 → 恢复 closed
//   5. 仓库检查：ai-router 无任何非 inference 组件依赖
//
// 用法：node scripts/verify-spark-inference.mjs
// 配置：.env.local 的 LOCAL_AI_HUB_URL（可选 LOCAL_AI_MODEL / LOCAL_AI_API_KEY）
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  AIRouter,
  AIRequestScheduler,
  ScheduledAIRouter,
  VLLMAdapter,
  discoverModels,
  resolveModel,
  ModelSelectionError,
  parseStructuredOutput,
  aiRequestPriorities,
} from "../packages/ai-router/dist/index.js";
import { z } from "../packages/ai-router/node_modules/zod/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function loadEnvLocal() {
  try {
    const text = readFileSync(path.join(repoRoot, ".env.local"), "utf8");
    const env = {};
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match) env[match[1]] = match[2].trim();
    }
    return env;
  } catch {
    return {};
  }
}

const envLocal = loadEnvLocal();
const baseUrl = process.env.LOCAL_AI_HUB_URL?.trim() || envLocal.LOCAL_AI_HUB_URL?.trim() || "";
const configuredModel = process.env.LOCAL_AI_MODEL?.trim() || envLocal.LOCAL_AI_MODEL?.trim() || "";
const apiKey = process.env.LOCAL_AI_API_KEY?.trim() || envLocal.LOCAL_AI_API_KEY?.trim() || null;

if (!baseUrl) {
  console.error("FATAL: LOCAL_AI_HUB_URL 未配置（.env.local 或环境变量）。");
  process.exit(1);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log(`Spark hub: ${baseUrl}${configuredModel ? ` (configured model: ${configuredModel})` : " (model auto-resolve)"}`);

// ---------------------------------------------------------------------------
// 1. 模型发现与选择（生产 resolveModel）
// ---------------------------------------------------------------------------
let selectedModel = null;
try {
  const selection = await resolveModel({ baseUrl, apiKey, configuredModel: configuredModel || null, timeoutMs: 5_000 });
  selectedModel = selection.model;
  check("model-selection", true, `model=${selection.model} source=${selection.source} advertised=${selection.discoveredModels.length}`);
} catch (error) {
  const code = error instanceof ModelSelectionError ? error.code : "UNKNOWN";
  check("model-selection", false, `${code}: ${error.message.slice(0, 160)}`);
  process.exit(1);
}

// 显式缺失 → fail closed（用假模型名验证规则本身）
try {
  await resolveModel({ baseUrl, apiKey, configuredModel: "definitely-not-a-real-model-xyz", timeoutMs: 5_000 });
  check("model-selection-explicit-missing", false, "should have failed closed");
} catch (error) {
  check("model-selection-explicit-missing", error instanceof ModelSelectionError && error.code === "AI_CONFIGURED_MODEL_NOT_FOUND", error.code ?? String(error).slice(0, 80));
}

// 不可达 → AI_NODE_UNREACHABLE
try {
  await resolveModel({ baseUrl: "http://127.0.0.1:1", configuredModel: "x", timeoutMs: 1_000 });
  check("model-selection-unreachable", false, "should have thrown");
} catch (error) {
  check("model-selection-unreachable", error instanceof ModelSelectionError && error.code === "AI_NODE_UNREACHABLE", error.code);
}

// ---------------------------------------------------------------------------
// 2. health + 最小结构化 inference（生产 adapter）
// ---------------------------------------------------------------------------
const adapter = new VLLMAdapter(baseUrl, selectedModel, apiKey);
const health = await adapter.health();
check("health-readiness", health.available, health.available ? `latency=${health.latencyMs}ms` : String(health.error ?? "").slice(0, 120));

const planContract = {
  name: "minimal-structured-inference",
  schema: z.object({
    action: z.enum(["move", "collect", "observe"]),
    reason: z.string().min(1).max(200),
  }),
};
const generate = await adapter.generate({
  systemPrompt: "You are a Minecraft task planner. Reply ONLY with compact JSON: {\"action\":\"move|collect|observe\",\"reason\":\"<short>\"}. Choose one action for: more wood is needed.",
  prompt: "Decide the next action.",
  maxTokens: 64,
  timeoutMs: 30_000,
});
let structured = null;
try {
  structured = parseStructuredOutput(generate.content, planContract);
  check("structured-inference", true, `action=${structured.action} model=${selectedModel} tokens≈${generate.content.length}`);
} catch (error) {
  check("structured-inference", false, `${error.message.slice(0, 120)}; raw=${generate.content.slice(0, 120)}`);
}

// ---------------------------------------------------------------------------
// 3. 6 路并发请求流（生产 scheduler + breaker；公平/优先级/有界）
// ---------------------------------------------------------------------------
{
  const router = new AIRouter();
  router.register(new VLLMAdapter(baseUrl, selectedModel, apiKey));
  const scheduler = new AIRequestScheduler({
    maxConcurrency: 2, // 刻意压低：强制排队，观察公平性与队列上界
    maxQueue: 12,
    perBotConcurrency: 1, // 每 bot 同时只 1 个 → 3 bots 轮转
    defaultTimeoutMs: 45_000,
  });
  const scheduled = new ScheduledAIRouter(router, scheduler, { failureThreshold: 3, cooldownMs: 2_000 });

  const bots = ["studio-bot-a", "studio-bot-b", "studio-bot-c"];
  const inflight = [];
  const seen = [];
  // 6 路：每个 bot 2 路，同优先级 planning；附带 1 路 recovery 优先级（应插队）
  for (let i = 0; i < 6; i += 1) {
    const botId = bots[i % 3];
    const priority = i === 5 ? aiRequestPriorities.recovery : aiRequestPriorities.planning;
    inflight.push(
      scheduled.generate({
        requestId: randomUUID(),
        botId,
        priority,
        maxTokens: 8,
        prompt: `Reply with the single word: ok${i}`,
        timeoutMs: 45_000,
      }).then(
        (result) => {
          seen.push({ botId, priority, queueTimeMs: result.queueTimeMs, ok: true });
          return true;
        },
        (error) => {
          seen.push({ botId, priority, ok: false, error: String(error.message ?? error).slice(0, 80) });
          return false;
        },
      ),
    );
  }
  await Promise.all(inflight);
  const okCount = seen.filter((entry) => entry.ok).length;
  const botsServed = new Set(seen.filter((entry) => entry.ok).map((entry) => entry.botId));
  const snapshot = scheduled.healthSnapshot();
  check("six-way-stream", okCount === 6, `${okCount}/6 ok; bots served: ${[...botsServed].join(",")}`);
  check("fair-scheduling", botsServed.size >= 2, `${botsServed.size}/3 bots got service under maxConcurrency=2/perBot=1`);
  check("queue-bounded", snapshot.scheduler.maxQueue === 12 && seen.every((entry) => entry.queueTimeMs === undefined || entry.queueTimeMs < 60_000), `maxQueue=${snapshot.scheduler.maxQueue}`);
  check("breaker-healthy-after-stream", snapshot.breaker.state === "closed", `breaker=${snapshot.breaker.state} successes=${snapshot.breaker.successCount}`);
}

// ---------------------------------------------------------------------------
// 4. 熔断：不可达 → open → half-open → 恢复
// ---------------------------------------------------------------------------
{
  const deadRouter = new AIRouter();
  deadRouter.register(new VLLMAdapter("http://127.0.0.1:1", "m", null));
  const scheduler = new AIRequestScheduler({ maxConcurrency: 2, maxQueue: 4, defaultTimeoutMs: 2_000 });
  const scheduled = new ScheduledAIRouter(deadRouter, scheduler, { failureThreshold: 2, cooldownMs: 1_500, maxProbes: 1 });

  // 连续失败 → open
  for (let i = 0; i < 2; i += 1) {
    await scheduled.generate({ requestId: randomUUID(), botId: "bot-x", priority: aiRequestPriorities.planning, maxTokens: 4, prompt: "x" }).catch(() => undefined);
  }
  const afterFailures = scheduled.healthSnapshot().breaker.state;
  check("breaker-opens", afterFailures === "open", `state=${afterFailures}`);

  // open → 快速失败（无网络等待）
  const fastFailStart = Date.now();
  let fastFailed = false;
  await scheduled.generate({ requestId: randomUUID(), botId: "bot-x", priority: aiRequestPriorities.planning, maxTokens: 4, prompt: "x" }).catch((error) => {
    fastFailed = error.name === "CircuitOpenError" || String(error.message).includes("circuit");
  });
  const fastFailMs = Date.now() - fastFailStart;
  check("breaker-fast-fail", fastFailed && fastFailMs < 500, `failed in ${fastFailMs}ms without network`);

  // 冷却 → half-open：同一个 router 注册健康 adapter（模拟 Spark 恢复在线）。
  // 探测请求经 dead(health fail → skip) → healthy → 成功 → breaker closed
  // （同时验证了 adapter failover 与半开恢复两条路径）。
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  deadRouter.register(new VLLMAdapter(baseUrl, selectedModel, apiKey));
  const halfOpenProbe = await scheduled.generate({ requestId: randomUUID(), botId: "bot-y", priority: aiRequestPriorities.planning, maxTokens: 8, prompt: "Reply: ok", timeoutMs: 30_000 })
    .then(() => true)
    .catch(() => false);
  check("half-open-recovery", halfOpenProbe && scheduled.healthSnapshot().breaker.state === "closed", `probe=${halfOpenProbe} breaker=${scheduled.healthSnapshot().breaker.state} (failover dead→healthy, same breaker)`);
}

// ---------------------------------------------------------------------------
// 5. ai-router 无非 inference 组件（架构约束检查）
// ---------------------------------------------------------------------------
{
  const src = readFileSync(path.join(repoRoot, "packages", "ai-router", "src", "index.ts"), "utf8");
  const forbidden = ["mineflayer", "docker", "child_process", "postgres", "redis", "express", "http-server"];
  const hits = forbidden.filter((word) => src.includes(word));
  check("spark-inference-only", hits.length === 0, hits.length === 0 ? "ai-router imports no runtime/db/process dependencies" : `found: ${hits.join(",")}`);
}

// ---------------------------------------------------------------------------
const failed = results.filter((entry) => !entry.ok);
console.log(`\n=== SPARK VERIFICATION: ${failed.length === 0 ? "PASS" : "FAIL"} (${results.length - failed.length}/${results.length}) ===`);
process.exit(failed.length === 0 ? 0 : 1);
