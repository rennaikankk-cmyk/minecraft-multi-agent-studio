// ---------------------------------------------------------------------------
// Skill Author 管道：gap → 模型生成 → 路径校验 → 分支 → 便宜闸 → 合并或中止。
//
// 用户显式开通的行为：绿灯自动合并到 main 并推送。因此本模块的纪律是：
//   1. **起点必须是干净工作区**。脏工作区无法可靠回滚——拒绝开跑，而不是硬上。
//   2. **路径校验先于写盘**，且全有或全无；越界即整体放弃。
//   3. **合并前必须过闸**（typecheck + 单元测试，均为进程内、不启 Minecraft 服务端）。
//      理由不是洁癖：技能是 TS，一个类型错误会让整包构建失败 → bot 起不来。
//   4. 无论成功失败，**结束时必须回到起始分支**，绝不让仓库停在临时分支上。
//   5. 失败保留分支与提交，便于人工查看模型到底写了什么。
//
// 所有外部动作（git / 闸 / 模型 / 文件写入）都通过 deps 注入，便于端到端假件测试。
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_SKILL_AUTHOR_POLICY, validateGeneratedFiles } from "./policy.mjs";
import { buildSkillAuthorMessages, parseSkillAuthorResponse } from "./prompt.mjs";

export const MAIN_BRANCH = "main";
export const BRANCH_PREFIX = "skill-author/";

/** 便宜闸的默认实现：全仓 typecheck（保证构建不被破坏）+ 技能包单测。 */
export function defaultGateSteps(changedPaths) {
  const steps = [{ label: "typecheck", command: "pnpm", args: ["typecheck"] }];
  const touchesBotRuntime = changedPaths.some((item) => item.startsWith("apps/bot-runtime/"));
  if (touchesBotRuntime) {
    steps.push({
      label: "bot-runtime typecheck",
      command: "pnpm",
      args: ["--filter", "@minecraft-studio/bot-runtime", "typecheck"],
    });
  }
  steps.push({ label: "skills test", command: "pnpm", args: ["--filter", "@minecraft-studio/skills", "test"] });
  return steps;
}

/** 用固定 argv + shell:false 跑一条命令（SECURITY.md §2）。 */
export function runCommand({ command, args, cwd, timeoutMs = 900_000 }) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, shell: false, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error?.code ?? (error === null ? 0 : 1);
      resolve({
        ok: error === null,
        code: typeof code === "number" ? code : 1,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

async function git(args, cwd) {
  const result = await runCommand({ command: "git", args, cwd, timeoutMs: 120_000 });
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

export function createGitDriver(repoRoot) {
  return {
    async currentBranch() {
      return git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
    },
    async isClean() {
      const porcelain = await git(["status", "--porcelain"], repoRoot);
      return porcelain.length === 0;
    },
    async headSha() {
      return git(["rev-parse", "HEAD"], repoRoot);
    },
    async createBranch(name) {
      await git(["checkout", "-b", name], repoRoot);
    },
    async checkout(name) {
      await git(["checkout", name], repoRoot);
    },
    async addAll() {
      await git(["add", "-A"], repoRoot);
    },
    async commit(message) {
      await git(["commit", "-m", message], repoRoot);
    },
    async mergeNoFf(name) {
      await git(["merge", "--no-ff", "--no-edit", name], repoRoot);
    },
    async push(remote, branch) {
      await git(["push", remote, branch], repoRoot);
    },
    async revert(sha) {
      await git(["revert", "--no-edit", sha], repoRoot);
    },
  };
}

function slugify(text) {
  const slug = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "gap";
}

/**
 * 跑一次自我改进。返回结构化结果，供 CLI 与审计日志使用。
 *
 * @param {object} deps 见文件头；必须提供 loadGap / generate / writeFiles / git / gate
 */
export async function runSkillAuthorOnce(deps) {
  const policy = deps.policy ?? DEFAULT_SKILL_AUTHOR_POLICY;
  const logger = deps.logger ?? { info: () => undefined, warn: () => undefined };
  const gitDriver = deps.git;
  const startedAtMs = deps.now?.() ?? Date.now();
  const outcome = { status: "unknown", step: "init", branch: null, files: [], commit: null, detail: null, steps: [] };

  const startBranch = await gitDriver.currentBranch();
  if (startBranch !== MAIN_BRANCH) {
    return { ...outcome, status: "refused", step: "precondition", detail: `not on ${MAIN_BRANCH} (on ${startBranch})` };
  }
  if (!(await gitDriver.isClean())) {
    return {
      ...outcome,
      status: "refused",
      step: "precondition",
      detail: "working tree is not clean; refusing to run because a dirty tree cannot be rolled back reliably",
    };
  }

  const gap = await deps.loadGap();
  if (gap === null || gap === undefined) {
    return { ...outcome, status: "refused", step: "load-gap", detail: "no gap to work on" };
  }
  const bundle = deps.loadBundle ? await deps.loadBundle(gap) : null;
  const existingSkillIds = deps.listExistingSkillIds ? await deps.listExistingSkillIds() : [];
  const messages = buildSkillAuthorMessages({ gap, bundle, existingSkillIds, policy });

  logger.info("skill_author_generating", { gapId: gap.gapId ?? null, kind: gap.kind ?? null });
  const rawResponse = await deps.generate({ messages, gap });
  const parsed = parseSkillAuthorResponse(rawResponse);
  if (!parsed.ok) {
    return { ...outcome, status: "rejected", step: "parse", detail: parsed.error };
  }

  const validated = validateGeneratedFiles(parsed.files, policy);
  if (!validated.ok) {
    // 越界即整体放弃，且**一个字节都不落盘**。
    logger.warn("skill_author_policy_violation", { violations: validated.violations });
    return {
      ...outcome,
      status: "rejected",
      step: "policy",
      detail: "generated paths violate the writable policy",
      violations: validated.violations,
    };
  }

  const branch = `${BRANCH_PREFIX}${slugify(gap.gapId ?? gap.kind)}-${new Date(startedAtMs).toISOString().replace(/[:.]/gu, "-")}`;
  outcome.branch = branch;
  outcome.files = validated.accepted.map((file) => file.path);

  try {
    await gitDriver.createBranch(branch);
    await deps.writeFiles(validated.accepted);
    await gitDriver.addAll();
    await gitDriver.commit(
      [
        `feat(skills): ${parsed.summary ?? `auto-authored skill for gap ${gap.gapId ?? "unknown"}`}`,
        "",
        "由 Skill Author 依据能力缺口自动生成（未人工编写）。",
        `gap: ${gap.gapId ?? "unknown"}`,
        parsed.capabilitiesUsed.length > 0 ? `capabilities: ${parsed.capabilitiesUsed.join(", ")}` : "capabilities: (none declared)",
        "验证：见本次运行的 gate 结果（typecheck + 单元测试）。",
      ].join("\n"),
    );
    outcome.commit = await gitDriver.headSha();

    logger.info("skill_author_committed", { branch, commit: outcome.commit, files: outcome.files.length });

    const gate = await deps.gate({ changedPaths: outcome.files, branch });
    outcome.steps = gate.steps ?? [];
    if (!gate.ok) {
      // 保留分支与提交供人工查看；回到起始分支，不合并。
      await gitDriver.checkout(startBranch);
      logger.warn("skill_author_gate_failed", { branch, failed: gate.failedLabel ?? null });
      return { ...outcome, status: "gate-failed", step: "gate", detail: gate.detail ?? "gate failed" };
    }

    if (deps.merge === false) {
      await gitDriver.checkout(startBranch);
      return { ...outcome, status: "verified-no-merge", step: "gate", detail: "gate passed; merge disabled by caller" };
    }

    await gitDriver.checkout(startBranch);
    await gitDriver.mergeNoFf(branch);
    outcome.mergeCommit = await gitDriver.headSha();
    if (deps.push !== false) {
      await gitDriver.push(deps.remote ?? "origin", startBranch);
      outcome.pushed = true;
    }
    logger.info("skill_author_merged", { branch, mergeCommit: outcome.mergeCommit, pushed: outcome.pushed === true });
    return { ...outcome, status: "merged", step: "done", detail: parsed.summary };
  } catch (error) {
    // 尽力回到起始分支，绝不把仓库留在临时分支上。
    await gitDriver.checkout(startBranch).catch(() => undefined);
    logger.warn("skill_author_failed", { branch, reason: error instanceof Error ? error.message : String(error) });
    return {
      ...outcome,
      status: "error",
      step: "exception",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 审计日志：只追加，永不改写。仅在运行时数据目录（已被 gitignore）。 */
export async function appendAuditLog(runtimeRoot, record) {
  const dir = path.join(runtimeRoot, "skill-author");
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "audit.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  return dir;
}

/** 回滚：对指定提交做 revert 并推送（保留历史，不改写已推送的历史）。 */
export async function rollbackSkillAuthor(deps, sha) {
  const gitDriver = deps.git ?? createGitDriver(deps.repoRoot);
  await gitDriver.revert(sha);
  if (deps.push !== false) await gitDriver.push(deps.remote ?? "origin", MAIN_BRANCH);
  return { reverted: sha };
}

/** 落盘实现：逐文件写，父目录按需创建。 */
export async function writeFilesToRepo(repoRoot, files) {
  for (const file of files) {
    const absolute = path.join(repoRoot, file.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, "utf8");
  }
}

/** 跑闸：逐条命令，任一失败即整闸失败，并保留输出尾部供人工定位。 */
export async function runGate({ repoRoot, changedPaths, steps = defaultGateSteps(changedPaths), runner = runCommand }) {
  const results = [];
  for (const step of steps) {
    const result = await runner({ command: step.command, args: step.args, cwd: repoRoot });
    results.push({
      label: step.label,
      ok: result.ok,
      code: result.code,
      tail: `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-25).join("\n"),
    });
    if (!result.ok) {
      return { ok: false, steps: results, failedLabel: step.label, detail: `${step.label} exited ${result.code}` };
    }
  }
  return { ok: true, steps: results, failedLabel: null, detail: null };
}
