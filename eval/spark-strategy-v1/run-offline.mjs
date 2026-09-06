#!/usr/bin/env node
// eval/spark-strategy-v1/run-offline.mjs —— 独立离线回放 CLI（默认 offline）。
//
// 一期指令 §6：不依赖完整 Studio、不发网络请求、不启动 Minecraft、不写
// 生产数据。输入=fixtures 目录（脱敏事实 + 注入响应），输出=机器可读
// JSON + 简短 Markdown，写入 --out（默认 runtime-data/spark-strategy-v1/，
// worktree 本地）。
//
// 导入坐标：apps/coordinator/dist/spark-strategy-v1/index.js（先
// `pnpm --filter @minecraft-studio/coordinator build`）。
//
// live 模式：本 CLI 不实现自动 live；live 需显式走
// scheduledRouterModelClient + 真实 ScheduledAIRouter（见 USAGE.md 待执行
// 命令），并在已核实的空闲测试窗口内手动运行。

import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")))));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const fixturesDir = path.resolve(flag("fixtures", path.join(repoRoot, "eval", "spark-strategy-v1", "fixtures")));
const outDir = path.resolve(flag("out", path.join(repoRoot, "runtime-data", "spark-strategy-v1")));
const distIndex = path.join(repoRoot, "apps", "coordinator", "dist", "spark-strategy-v1", "index.js");

if (!existsSync(distIndex)) {
  console.error("coordinator dist not built. run: pnpm --filter @minecraft-studio/coordinator build");
  process.exit(1);
}
const strategy = await import(pathToFileURL(distIndex).href);

function readFixture(file, seen = new Set()) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (raw.factsRef) {
    if (seen.has(raw.factsRef)) throw new Error(`fixture import cycle at ${raw.factsRef}`);
    seen.add(raw.factsRef);
    const parent = readFixture(path.join(path.dirname(file), raw.factsRef), seen);
    raw.facts = parent.facts;
  }
  if (!raw.facts) throw new Error(`fixture ${file} has no facts (direct or factsRef)`);
  return raw;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = [
  "You are the team strategy layer for a Minecraft survival bot fleet.",
  "Use only the facts in the snapshot; unknown means unknown — never invent facts.",
  "Assign at most one actionable task per bot; reference only listed capabilities and facilities;",
  "every actionable task needs observable success signals and bounded attempts (maxAttempts<=10).",
  "Respond with exactly one JSON object: a TeamProposal.",
].join(" ");

const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
const samples = [];
const responses = new Map();
for (const file of files) {
  const fixture = readFixture(path.join(fixturesDir, file));
  const facts = strategy.parseTeamFactsInput(fixture.facts);
  const version = strategy.factVersion(facts);
  let responseText;
  if (typeof fixture.injectedResponse === "string") {
    responseText = fixture.injectedResponse.replaceAll("{{factVersion}}", version);
  } else {
    responseText = JSON.stringify(fixture.injectedResponse).replaceAll("{{factVersion}}", version);
  }
  samples.push({
    sampleId: fixture.sampleId,
    scenario: fixture.scenario,
    mode: fixture.mode ?? "offline",
    facts,
    expectation: fixture.expectation,
  });
  responses.set(fixture.sampleId, responseText);
}

const report = await strategy.runReplayBatch(samples, {
  client: strategy.injectedModelClient(responses),
  systemPrompt: SYSTEM_PROMPT,
  gitCommit: gitCommit(),
  // 不传 nowMs：样本用 fixture 相对时钟（observedAt+1s）——离线判定确定
  // 性、不随真实时间漂移；报告 generatedAtMs 仍取真实时间。
});

mkdirSync(outDir, { recursive: true });
const jsonPath = path.join(outDir, "report.json");
const mdPath = path.join(outDir, "report.md");
writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
writeFileSync(mdPath, strategy.renderReportMarkdown(report) + "\n");

const a = report.aggregates;
console.log(
  `[spark-strategy-v1] offline replay complete: samples=${a.samples} valid=${a.validProposals} parseFailures=${a.parseFailures} ` +
    `matched=${a.matchedExpectationCount} shouldActButNoop=${a.shouldActButNoop} shouldWaitCorrectly=${a.shouldWaitCorrectlyWaiting}`,
);
console.log(`report: ${jsonPath}`);
console.log(`report: ${mdPath}`);
