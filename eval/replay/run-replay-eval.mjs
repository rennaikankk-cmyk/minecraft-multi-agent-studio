#!/usr/bin/env node
// 回放评测：真实决策输入（eval/replay/replay-corpus.jsonl）× 模型。
// 评：①结构化计划有效 JSON 率 ②工具名合法率（对照项目真实 23 技能目录）
// ③虚构状态（编造不存在的物品/坐标锚点形式）④首 token 与总延迟。
// 样本量限制如实记录（当前 11 条真实输入——不足则不作唯一依据）。
// 用法：node run-replay-eval.mjs <endpoint> <model> <tag>
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [endpoint, model, tag] = process.argv.slice(2);
if (!endpoint || !model || !tag) { console.error("usage: run-replay-eval.mjs <endpoint> <model> <tag>"); process.exit(2); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(ROOT, "runtime-data", "model-selection");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const manifest = JSON.parse(readFileSync(path.join(ROOT, "packages", "skills", "skill-system-v1.manifest.json"), "utf8"));
const SKILLS = manifest.skills.map((s) => s.skillId);
const corpus = readFileSync(path.join(ROOT, "eval", "replay", "replay-corpus.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const SYSTEM = `你是 Minecraft 无规则服务器机器人小队的协调主控。可用技能（只能从中选择，不得发明）：${SKILLS.join("、")}。
输出严格 JSON：{"skill":"<技能名>","reason":"<一句理由>","goalText":"<给该技能的自然语言目标>"}。只输出 JSON。`;

const NEED_TO_PROMPT = {
  TOOL_PROGRESSION: "Bot 没有任何镐。需要推进工具阶梯。",
  WOOD_RESERVE: "木材储备 2，低于临界值 4。",
  FOOD_TARGET: "安全食物不足，需要补充到目标量。",
  EQUIP_ARMOR: "Bot 未穿护甲，需要装备护甲。",
  DEATH_RECOVERY: "Bot 刚死亡，掉落物在 40 格外的死亡点，15 分钟内会消失。",
  SHELTER: "夜晚将至，Bot 需要避难所。",
  STOCK_LEVELS: "关键物资低于下限。",
  EXPLORATION: "基本需求满足，可以探索。",
};

const results = [];
for (const entry of corpus) {
  const prompt = entry.kind === "autonomy_need"
    ? `当前生存需求评估结果：${NEED_TO_PROMPT[entry.needKey] ?? entry.needKey}${entry.reason ? `（原因：${entry.reason}）` : ""}。给出下一步决策 JSON。`
    : `决策上下文：${JSON.stringify(entry)}。给出下一步决策 JSON。`;
  const t0 = Date.now();
  let j = null, error = null;
  try {
    const r = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], max_tokens: 3000, temperature: 0 }),
    });
    j = await r.json();
  } catch (e) { error = String(e.message).slice(0, 120); }
  const ms = Date.now() - t0;
  const content = (j?.choices?.[0]?.message?.content ?? "").trim();
  // 抽取 JSON（容错 ```json 围栏）
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  let parsed = null, parseError = null;
  if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[0]); } catch (e) { parseError = String(e.message).slice(0, 80); } }
  const finishReason = j?.choices?.[0]?.finish_reason ?? null;
  const truncated = finishReason === 'length';
  const skillValid = parsed !== null && SKILLS.includes(parsed.skill);
  const reasoningTokens = j?.usage?.completion_tokens_details?.reasoning_tokens ?? null;
  results.push({
    replayId: entry.id, kind: entry.kind, needKey: entry.needKey ?? null,
    latencyMs: ms, completionTokens: j?.usage?.completion_tokens ?? null, reasoningTokens,
    jsonValid: parsed !== null, parseError, finishReason, truncated,
    skillLegal: skillValid, skillChosen: parsed?.skill ?? null,
    goalText: parsed?.goalText ?? null,
    raw: content.slice(0, 400), ...(error ? { error } : {}),
  });
  console.log(`${entry.id} ${entry.needKey ?? entry.kind}: json=${parsed !== null} skill=${skillValid ? parsed.skill : "ILLEGAL:" + String(parsed?.skill)} ${ms}ms`);
}

const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
const summary = {
  tag, endpoint, model, runAt: new Date().toISOString(),
  sampleCount: results.length,
  sampleLimitation: results.length < 200 ? `仅 ${results.length} 条真实决策输入（规划输入按隐私设计未全量落日志）——本结果为初筛，不得作为唯一选型依据` : null,
  jsonValidRate: Number((results.filter((r) => r.jsonValid).length / results.length).toFixed(4)),
  toolNameLegalRate: Number((results.filter((r) => r.skillLegal).length / results.length).toFixed(4)),
  latency: { p50: pct(50), p95: pct(95), max: lat[lat.length - 1] },
  avgReasoningTokens: Math.round(results.reduce((s, r) => s + (r.reasoningTokens ?? 0), 0) / results.length),
};
writeFileSync(path.join(OUT_DIR, `replay-${tag}.json`), JSON.stringify({ summary, results }, null, 2));
console.log("\n===== REPLAY EVAL SUMMARY", tag, "=====");
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
