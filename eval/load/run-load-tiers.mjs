#!/usr/bin/env node
// 并发档位负载评测（EVAL_CONTRACT v1 补充件 #4）：1/2/4/8/16 档。
// 直连推理端点（不经 studio）——测量模型栈本身的并发行为：
//   TTFT（stream 首 token）、总延迟、tok/s、错误率。每档固定 16 个请求。
// 用法：node run-load-tiers.mjs <endpoint> <model> <TAG> [tiers]
//   例：node run-load-tiers.mjs http://192.168.100.2:18300 qwen3.8-flash-next M2-formal 1,2,4
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [endpoint, model, TAG, tiersArg] = process.argv.slice(2);
if (!endpoint || !model || !TAG) { console.error("usage: run-load-tiers.mjs <endpoint> <model> <TAG> [tiers]"); process.exit(2); }
const TIERS = (tiersArg ?? "1,2,4,8,16").split(",").map(Number).filter((n) => n > 0);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// eval-fix：端点归一化——接受带或不带 /v1 的 base（无 /v1 时拼 /chat/completions 会 404）
const API_BASE = endpoint.endsWith("/v1") ? endpoint : endpoint.replace(/\/$/, "") + "/v1";
const OUT_DIR = path.join(ROOT, "runtime-data", "model-selection");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const PROMPTS = [
  "观察你周围 30 格的地形，报告最近的树与水源方位。",
  "计划采集 16 个 oak_log 的完整步骤，注意工具与安全。",
  "评估当前基地防御：如果 3 个敌对玩家从南面来，怎么布置？",
  "解释在岩浆湖边挖矿的风险与缓解方案。",
  "规划一条从出生点到 500 格外沙漠的路线要点。",
  "盘点生存第一夜需要的最低物资清单并排序。",
  "如果队友被围攻而你在 200 格外，决策树是什么？",
  "分析刷石机的最小可行结构（不用蓝图，口头描述）。",
  "饥饿值 6 且没有食物，方圆 50 格是平原，怎么办？",
  "描述建造一个 3x3 安全屋的完整步骤与材料。",
  "如何判断一个未知玩家是敌是友？给出信号清单。",
  "规划铁装备升级路线：从零到全套铁甲需要什么？",
  "夜里听到爆炸声，基地方向，写出反应协议。",
  "在峡谷地形安全移动的规则是什么？",
  "如果目标服务器 TPS 很低，行为策略要怎么调整？",
  "给一个新加入的队友写 5 条生存守则。",
];

async function oneRequest(i) {
  const t0 = Date.now();
  let ttft = null;
  let firstChunkAt = null;
  let completionTokens = 0;
  let error = null;
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是 Minecraft 无规则服务器机器人小队主控。中文，简洁专业。" },
          { role: "user", content: PROMPTS[i % PROMPTS.length] },
        ],
        max_tokens: 3000,
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices?.[0]?.delta;
          if (delta && (delta.content || delta.reasoning) && firstChunkAt === null) {
            firstChunkAt = Date.now();
            ttft = firstChunkAt - t0;
          }
          if (j.usage?.completion_tokens) completionTokens = j.usage.completion_tokens;
        } catch { /* keep-alive 注释行忽略 */ }
      }
    }
  } catch (e) { error = String(e.message).slice(0, 120); }
  const totalMs = Date.now() - t0;
  return { i, ttft, totalMs, completionTokens, error };
}

const tierResults = [];
for (const tier of TIERS) {
  console.log(`\n===== TIER ${tier}（16 请求，并发 ${tier}）=====`);
  const batches = [];
  for (let b = 0; b < Math.ceil(16 / tier); b += 1) {
    const reqs = [];
    for (let k = 0; k < tier && b * tier + k < 16; k += 1) reqs.push(oneRequest(b * tier + k));
    const settled = await Promise.all(reqs);
    batches.push(...settled);
  }
  const ok = batches.filter((r) => !r.error);
  const errs = batches.filter((r) => r.error);
  const ttfts = ok.map((r) => r.ttft ?? r.totalMs).sort((a, b) => a - b);
  const totals = ok.map((r) => r.totalMs).sort((a, b) => a - b);
  const toks = ok.reduce((s, r) => s + (r.completionTokens ?? 0), 0);
  const wallMs = Math.max(...totals, 1);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
  const row = {
    tier, requests: batches.length, ok: ok.length, errors: errs.length,
    errorRate: Number((errs.length / batches.length).toFixed(4)),
    ttft: { p50: pct(ttfts, 50), p95: pct(ttfts, 95), max: ttfts[ttfts.length - 1] },
    total: { p50: pct(totals, 50), p95: pct(totals, 95), max: totals[totals.length - 1] },
    aggregateTokensPerSec: Number((toks / (wallMs / 1000)).toFixed(1)),
    sumCompletionTokens: toks,
  };
  tierResults.push(row);
  console.log(JSON.stringify(row));
}

const summary = { tag: `${TAG}-load`, endpoint, model, runAt: new Date().toISOString(), tiers: tierResults };
writeFileSync(path.join(OUT_DIR, `load-${TAG}.json`), JSON.stringify(summary, null, 2));
console.log("\nevidence:", path.relative(ROOT, path.join(OUT_DIR, `load-${TAG}.json`)));
