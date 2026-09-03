#!/usr/bin/env node
// S-7：从真实运行日志提取决策回放语料（≥200 条）。
// 来源：coordinator.log 的 goal-request（operatorGoal 原文）+ 事件上下文。
// 脱敏：botId → Bxx、坐标保留（回放需要）、时间戳保留到秒、无凭据字段。
import { createHash } from "node:crypto";
import { readFileSync as rf, writeFileSync as wf, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(ROOT, "runtime-data", "logs", "coordinator.log");
const OUT_DIR = path.join(ROOT, "eval", "replay");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const lines = rf(SRC, "utf8").split("\n").filter(Boolean);
const entries = [];
for (const line of lines) {
  let j;
  try { j = JSON.parse(line); } catch { continue; }
  // goal 请求路径：control-link goal_request 事件（含 operatorGoal 原文与 bot 上下文）
  if (j.event === "coordinator_control_link_goal_request" && j.operatorGoal) {
    entries.push({ kind: "goal_request", operatorGoal: j.operatorGoal, botId: j.botId, at: j.timestamp });
  }
  // 自主决策路径：need_selected（真实自主决策输入）
  if (j.event === "coordinator_autonomous_need_selected" && j.needKey) {
    entries.push({ kind: "autonomy_need", needKey: j.needKey, reason: j.reason ?? null, botId: j.botId, at: j.timestamp });
  }
  // 规划器监督（真实 plan 结构样本）
  if (j.event === "coordinator_planner_goal_supervision" && j.plannedSteps !== undefined) {
    entries.push({ kind: "plan_supervision", plannedSteps: j.plannedSteps, stepsCompleted: j.stepsCompleted, botId: j.botId, at: j.timestamp });
  }
}

// 脱敏 + hash 去重（operatorGoal 相同文本保留首次）
const seen = new Set();
const corpus = [];
let botCounter = 0;
const botMap = new Map();
for (const e of entries) {
  if (!botMap.has(e.botId)) botMap.set(e.botId, `B${String(++botCounter).padStart(2, "0")}`);
  const redacted = { ...e, botId: botMap.get(e.botId) };
  const fp = createHash("sha256").update(e.kind + "|" + (e.operatorGoal ?? e.needKey ?? "") + "|" + (e.reason ?? "")).digest("hex").slice(0, 16);
  if (seen.has(fp)) continue;
  seen.add(fp);
  corpus.push({ id: `RP-${String(corpus.length + 1).padStart(3, "0")}`, fingerprint: fp, ...redacted });
}

const out = path.join(OUT_DIR, "replay-corpus.jsonl");
wf(out, corpus.map((c) => JSON.stringify(c)).join("\n") + "\n");
console.log(`extracted ${corpus.length} unique decision inputs (from ${entries.length} events) -> ${path.relative(ROOT, out)}`);
const byKind = {};
for (const c of corpus) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
console.log("by kind:", JSON.stringify(byKind));
