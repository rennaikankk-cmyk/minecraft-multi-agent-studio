#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Skill Author CLI —— 把"能力缺口"自动变成合入的技能代码。
//
// 用法：
//   node scripts/skill-author.mjs --list                 列出当前缺口
//   node scripts/skill-author.mjs --latest               挑最新缺口并跑完整闭环
//   node scripts/skill-author.mjs --gap <gapId>          指定缺口
//   node scripts/skill-author.mjs --latest --dry-run     只生成并校验，不写盘不提交
//   node scripts/skill-author.mjs --latest --no-merge    生成并提交到分支，但不合并
//   node scripts/skill-author.mjs --rollback <sha>       revert 一次已合并的自动提交并推送
//
// 前置：Models 页里激活一个 openai-compatible 档案（DeepSeek 有预设）。
// 安全边界见 configs/skill-author-policy.json 与 scripts/lib/skill-author/policy.mjs。
// ---------------------------------------------------------------------------

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_POLICY_RELATIVE_PATH,
  DEFAULT_SKILL_AUTHOR_POLICY,
  parseSkillAuthorPolicy,
  validateGeneratedFiles,
} from "./lib/skill-author/policy.mjs";
import { buildSkillAuthorMessages, parseSkillAuthorResponse } from "./lib/skill-author/prompt.mjs";
import { loadActiveAiProfile, callChatCompletions, resolveModel } from "./lib/skill-author/provider.mjs";
import {
  MAIN_BRANCH,
  appendAuditLog,
  createGitDriver,
  rollbackSkillAuthor,
  runGate,
  runSkillAuthorOnce,
  writeFilesToRepo,
} from "./lib/skill-author/pipeline.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flagValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const logger = {
  info: (event, meta) => console.log(JSON.stringify({ level: "info", event, ...(meta ?? {}) })),
  warn: (event, meta) => console.warn(JSON.stringify({ level: "warn", event, ...(meta ?? {}) })),
};

async function loadPolicy() {
  const policyPath = path.resolve(
    flagValue("--policy", path.join(repositoryRoot, DEFAULT_POLICY_RELATIVE_PATH)),
  );
  try {
    const raw = JSON.parse(await readFile(policyPath, "utf8"));
    return parseSkillAuthorPolicy(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      logger.warn("skill_author_policy_file_missing", { path: policyPath, usingBuiltInDefault: true });
      return DEFAULT_SKILL_AUTHOR_POLICY;
    }
    throw error;
  }
}

async function loadGaps(runtimeRoot) {
  const file = path.join(runtimeRoot, "skill-gaps", "skill-gaps.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed?.gaps) ? parsed.gaps : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`skill gap store is unreadable: ${file}`);
  }
}

function summarizeGap(gap) {
  return {
    gapId: gap?.gapId ?? null,
    status: gap?.status ?? null,
    kind: gap?.kind ?? null,
    severity: gap?.severity ?? null,
    actionFamily: gap?.gap?.actionFamily ?? null,
    failureCode: gap?.gap?.terminalFailureCode ?? null,
    requestedSkillId: gap?.gap?.requestedSkillId ?? null,
    occurrenceCount: gap?.occurrenceCount ?? null,
    lastSeenAtMs: gap?.lastSeenAtMs ?? null,
  };
}

function pickGap(gaps, requested) {
  if (requested !== null) return gaps.find((gap) => gap.gapId === requested) ?? null;
  const usable = gaps.filter((gap) => gap?.status === "detected" || gap?.status === "triaged");
  const pool = usable.length > 0 ? usable : gaps;
  if (pool.length === 0) return null;
  return [...pool].sort((left, right) => (right.lastSeenAtMs ?? 0) - (left.lastSeenAtMs ?? 0))[0];
}

async function listExistingSkillIds() {
  const catalog = path.join(repositoryRoot, "packages", "skills", "src", "builtin", "catalog.ts");
  try {
    const source = await readFile(catalog, "utf8");
    return [...source.matchAll(/["']([a-z][a-z0-9._-]{2,})["']/gu)].map((match) => match[1]);
  } catch {
    return [];
  }
}

async function main() {
  const runtimeRoot = path.resolve(
    flagValue("--runtime-root", process.env.STUDIO_RUNTIME_ROOT?.trim() || path.join(repositoryRoot, "runtime-data")),
  );
  const policy = await loadPolicy();
  const gitDriver = createGitDriver(repositoryRoot);

  if (hasFlag("--rollback")) {
    const sha = flagValue("--rollback");
    if (sha === null) throw new Error("--rollback needs a commit sha");
    const result = await rollbackSkillAuthor({ repoRoot: repositoryRoot, git: gitDriver }, sha);
    console.log(JSON.stringify({ status: "reverted", ...result }));
    return;
  }

  const gaps = await loadGaps(runtimeRoot);
  if (hasFlag("--list") || (gaps.length > 0 && flagValue("--gap") === null && !hasFlag("--latest"))) {
    console.log(JSON.stringify({ gaps: gaps.map(summarizeGap), total: gaps.length }, null, 2));
    if (!hasFlag("--latest") && flagValue("--gap") === null) return;
  }
  if (gaps.length === 0) {
    console.log(JSON.stringify({ status: "no-gaps", detail: `no gaps in ${runtimeRoot}/skill-gaps/skill-gaps.json` }));
    return;
  }

  const gap = pickGap(gaps, flagValue("--gap"));
  if (gap === null) {
    console.log(JSON.stringify({ status: "gap-not-found" }));
    process.exitCode = 1;
    return;
  }

  const profile = await loadActiveAiProfile(runtimeRoot);
  const model = await resolveModel({ profile, logger });
  logger.info("skill_author_profile", { profile: profile.name, model, baseUrlHost: new URL(profile.baseUrl).host });

  const dryRun = hasFlag("--dry-run");
  const generate = async ({ messages }) => callChatCompletions({ profile, model, messages });

  if (dryRun) {
    // --dry-run：只生成并校验，绝不写盘、绝不提交。
    const messages = buildSkillAuthorMessages({
      gap,
      bundle: null,
      existingSkillIds: await listExistingSkillIds(),
      policy,
    });
    const parsed = parseSkillAuthorResponse(await generate({ messages, gap }));
    if (!parsed.ok) {
      console.log(JSON.stringify({ status: "rejected", step: "parse", detail: parsed.error }, null, 2));
      process.exitCode = 1;
      return;
    }
    const validated = validateGeneratedFiles(parsed.files, policy);
    console.log(
      JSON.stringify(
        {
          status: validated.ok ? "dry-run-ok" : "rejected",
          step: validated.ok ? "policy" : "policy",
          summary: parsed.summary,
          capabilitiesUsed: parsed.capabilitiesUsed,
          needsNewCapability: parsed.needsNewCapability,
          files: validated.accepted.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8") })),
          violations: validated.violations,
        },
        null,
        2,
      ),
    );
    if (!validated.ok) process.exitCode = 1;
    return;
  }

  const result = await runSkillAuthorOnce({
    repoRoot: repositoryRoot,
    policy,
    git: gitDriver,
    logger,
    merge: !hasFlag("--no-merge"),
    push: !hasFlag("--no-push"),
    loadGap: async () => gap,
    loadBundle: async () => null,
    listExistingSkillIds,
    generate,
    writeFiles: (files) => writeFilesToRepo(repositoryRoot, files),
    gate: ({ changedPaths }) => runGate({ repoRoot: repositoryRoot, changedPaths }),
  });

  await appendAuditLog(runtimeRoot, {
    at: new Date().toISOString(),
    gapId: gap.gapId ?? null,
    model,
    profile: profile.name,
    ...result,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "merged" && result.status !== "verified-no-merge") process.exitCode = 1;
}

main().catch((error) => {
  logger.warn("skill_author_cli_failed", { reason: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

export { MAIN_BRANCH };
