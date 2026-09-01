#!/usr/bin/env node
// P0-5：Spark 并发 capacity 实测工具（手动运行；Studio 启动绝不自动压测）。
//
// 用法：node scripts/benchmark-spark-capacity.mjs [--levels 1,2,3,4] [--streams 6]
//   [--base-url http://192.168.100.2:18300] [--model <id>]
//
// 每档并发 × streams 个短 completion 请求，记录 success/error、聚合吞吐、
// 延迟 P50/P95；全部成功的最高档写入 runtime-data/ai-capacity-profile.json
// （非秘密：endpoint host、model id、testedAt、levels 指标）。
// 推荐值 = 全部成功且 P95 劣化可接受（<3× 单并发 P50）的最高档。

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const baseUrl = flag("base-url", process.env.LOCAL_AI_HUB_URL?.trim() || "http://192.168.100.2:18300").replace(/\/$/u, "");
const wantedModel = flag("model", process.env.LOCAL_AI_MODEL?.trim() || "");
const levels = flag("levels", "1,2,3,4").split(",").map((v) => Number.parseInt(v.trim(), 10)).filter((v) => Number.isSafeInteger(v) && v >= 1 && v <= 16);
const streams = Number.parseInt(flag("streams", "6"), 10) || 6;
const apiKey = process.env.LOCAL_AI_API_KEY?.trim() || "";
const timeoutMs = 30_000;

if (levels.length === 0) {
  console.error("invalid --levels");
  process.exit(1);
}

const log = (message) => console.log(`[capacity] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function discoverModel() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const models = (body.data ?? []).map((entry) => entry.id).filter(Boolean);
    if (models.length === 0) throw new Error("no models advertised");
    if (wantedModel && models.includes(wantedModel)) return wantedModel;
    if (wantedModel) throw new Error(`model ${wantedModel} not advertised (have ${models.length})`);
    if (models.length === 1) return models[0];
    throw new Error(`ambiguous: ${models.length} models advertised, pass --model`);
  } finally {
    clearTimeout(timer);
  }
}

async function oneRequest(model) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.json();
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (cause) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: String(cause?.message ?? cause).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function runLevel(model, concurrency) {
  const results = [];
  let launched = 0;
  const totalRequests = Math.max(streams, concurrency) * 2; // 每并发至少 2 轮
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = launched++;
      if (index >= totalRequests) break;
      results.push(await oneRequest(model));
    }
  });
  const startedAt = Date.now();
  await Promise.all(workers);
  const wallMs = Date.now() - startedAt;
  const ok = results.filter((r) => r.ok);
  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    concurrency,
    requests: results.length,
    success: ok.length,
    errors: results.length - ok.length,
    errorSample: results.find((r) => !r.ok)?.error ?? null,
    throughputPerSec: Number((ok.length / (wallMs / 1000)).toFixed(2)),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    wallMs,
  };
}

const model = await discoverModel();
log(`hub=${baseUrl.replace(/\/\/[^@]*@/u, "//")} model=${model} levels=[${levels.join(",")}] streams=${streams}`);

const levelResults = [];
for (const level of levels) {
  const result = await runLevel(model, level);
  levelResults.push(result);
  log(`c=${level}: success=${result.success}/${result.requests} p50=${result.latencyP50Ms}ms p95=${result.latencyP95Ms}ms tput=${result.throughputPerSec}/s${result.errors ? ` errors! (${result.errorSample})` : ""}`);
  await sleep(500);
}

// 推荐 = 全部成功且 P95 < 3× 最低档 P50 的最高档
const baseP50 = levelResults[0]?.latencyP50Ms ?? Number.POSITIVE_INFINITY;
const acceptable = levelResults.filter(
  (r) => r.errors === 0 && r.latencyP95Ms !== null && r.latencyP95Ms < 3 * baseP50,
);
const recommended = acceptable.length > 0 ? acceptable[acceptable.length - 1].concurrency : null;

const profile = {
  schemaVersion: "1.0",
  endpoint: new URL(baseUrl).host,
  model,
  testedAt: new Date().toISOString(),
  levels: levelResults,
  recommendedConcurrency: recommended,
  testedConcurrency: recommended ?? 0,
  note: recommended === null
    ? "no level fully succeeded; keep conservative default and investigate"
    : `highest level with 0 errors and P95 < 3x single-level P50`,
};
const outPath = path.resolve(import.meta.dirname, "..", "runtime-data", "ai-capacity-profile.json");
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
log(`profile written: ${outPath}`);
log(`recommended effective concurrency: ${recommended ?? "none — keep conservative default (2)"}`);
process.exit(0);
