// ---------------------------------------------------------------------------
// Skill Author 管道端到端假件测试。
//
// 这是"自动合并到 main"这套行为的安全网，因此覆盖重点是**不该发生的事**：
//   - 脏工作区/不在 main → 拒绝开跑（脏树无法可靠回滚）
//   - 越界路径 → 一个字节都不落盘、不建分支
//   - 闸红 → 不合并、不推送，并回到起始分支
//   - 任何异常 → 尽力回到起始分支，绝不把仓库留在临时分支上
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { DEFAULT_SKILL_AUTHOR_POLICY } from "./policy.mjs";
import { appendAuditLog, defaultGateSteps, runSkillAuthorOnce, writeFilesToRepo } from "./pipeline.mjs";

const GAP = {
  gapId: "gap-abc",
  kind: "missing_skill",
  severity: "warning",
  occurrenceCount: 2,
  gap: { actionFamily: "fluid", terminalFailureCode: "FLUID_PLACE_MISSING", causedByFailureCodes: [] },
  goal: { requestedOutcome: "get water into a bucket" },
};

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "skill-author-pipeline-"));
  tempDirs.push(dir);
  return dir;
}

/** 记录调用的假 git 驱动，可配置起点分支与是否干净。 */
function fakeGit({ branch = "main", clean = true } = {}) {
  const calls = [];
  let current = branch;
  // 调用名放在 `call` 字段：extra 里也有 name（分支名），用 name 会被覆盖。
  const record = (call, extra = {}) => {
    calls.push({ call, ...extra });
  };
  return {
    calls,
    get branch() {
      return current;
    },
    async currentBranch() {
      record("currentBranch");
      return current;
    },
    async isClean() {
      record("isClean");
      return clean;
    },
    async headSha() {
      record("headSha");
      return `sha-${calls.length}`;
    },
    async createBranch(name) {
      record("createBranch", { name });
      current = name;
    },
    async checkout(name) {
      record("checkout", { name });
      current = name;
    },
    async addAll() {
      record("addAll");
    },
    async commit(message) {
      record("commit", { message });
    },
    async mergeNoFf(name) {
      record("mergeNoFf", { name });
    },
    async push(remote, target) {
      record("push", { remote, target });
    },
    async revert(sha) {
      record("revert", { sha });
    },
  };
}

function responseWith(files) {
  return JSON.stringify({ files, summary: "auto-authored skill", capabilitiesUsed: ["world.interact"] });
}

function baseDeps(overrides = {}) {
  const written = [];
  const git = overrides.git ?? fakeGit();
  return {
    written,
    deps: {
      repoRoot: "/repo",
      policy: DEFAULT_SKILL_AUTHOR_POLICY,
      git,
      logger: { info: () => undefined, warn: () => undefined },
      loadGap: async () => GAP,
      loadBundle: async () => null,
      listExistingSkillIds: async () => ["movement.goto"],
      generate: async () => responseWith([{ path: "packages/skills/src/a.ts", content: "export const a = 1;\n" }]),
      writeFiles: async (files) => written.push(...files),
      gate: async () => ({ ok: true, steps: [{ label: "typecheck", ok: true, code: 0, tail: "" }] }),
      ...overrides,
    },
  };
}

describe("pipeline: preconditions", () => {
  it("refuses when not on main", async () => {
    const { deps } = baseDeps({ git: fakeGit({ branch: "feature/x" }) });
    const result = await runSkillAuthorOnce(deps);
    assert.equal(result.status, "refused");
    assert.match(result.detail, /not on main/u);
  });

  it("refuses when the working tree is dirty (a dirty tree cannot be rolled back reliably)", async () => {
    const { deps } = baseDeps({ git: fakeGit({ clean: false }) });
    const result = await runSkillAuthorOnce(deps);
    assert.equal(result.status, "refused");
    assert.match(result.detail, /not clean/u);
  });

  it("refuses when there is no gap", async () => {
    const { deps } = baseDeps({ loadGap: async () => null });
    const result = await runSkillAuthorOnce(deps);
    assert.equal(result.status, "refused");
    assert.equal(result.step, "load-gap");
  });
});

describe("pipeline: an out-of-policy path aborts everything", () => {
  it("writing into the safety core is rejected with no branch, no write, no commit", async () => {
    const git = fakeGit();
    const { deps, written } = baseDeps({
      git,
      generate: async () =>
        responseWith([
          { path: "packages/skills/src/ok.ts", content: "ok" },
          { path: "packages/safety/src/index.ts", content: "evil" },
        ]),
    });
    const result = await runSkillAuthorOnce(deps);

    assert.equal(result.status, "rejected");
    assert.equal(result.step, "policy");
    assert.ok(result.violations.some((item) => item.rule === "readonly-prefix"));
    assert.deepEqual(written, [], "not a single byte may be written on a policy violation");
    const names = git.calls.map((entry) => entry.call);
    assert.equal(names.includes("createBranch"), false);
    assert.equal(names.includes("commit"), false);
    assert.equal(names.includes("mergeNoFf"), false);
  });

  it("forbidden file inside a writable prefix is still rejected", async () => {
    const { deps, written } = baseDeps({
      generate: async () => responseWith([{ path: "apps/bot-runtime/src/server-profile.ts", content: "x" }]),
    });
    const result = await runSkillAuthorOnce(deps);
    assert.equal(result.status, "rejected");
    assert.equal(result.violations[0].rule, "readonly-path");
    assert.deepEqual(written, []);
  });

  it("an unparseable model response is rejected with no side effects", async () => {
    const git = fakeGit();
    const { deps, written } = baseDeps({ git, generate: async () => "sorry, I cannot do that." });
    const result = await runSkillAuthorOnce(deps);
    assert.equal(result.status, "rejected");
    assert.equal(result.step, "parse");
    assert.deepEqual(written, []);
    assert.equal(git.calls.some((entry) => entry.call === "commit"), false);
  });
});

describe("pipeline: the gate decides whether it merges", () => {
  it("green gate merges into main and pushes, ending back on main", async () => {
    const git = fakeGit();
    const { deps, written } = baseDeps({ git });
    const result = await runSkillAuthorOnce(deps);

    assert.equal(result.status, "merged");
    assert.equal(written.length, 1);
    const names = git.calls.map((entry) => entry.call);
    assert.ok(names.includes("createBranch"));
    assert.ok(names.includes("commit"));
    assert.ok(names.includes("mergeNoFf"));
    assert.ok(names.includes("push"));
    assert.equal(git.branch, "main", "must end on main");
    assert.ok(names.indexOf("mergeNoFf") > names.indexOf("commit"));
    assert.ok(names.indexOf("push") > names.indexOf("mergeNoFf"));
  });

  it("red gate never merges or pushes, keeps the branch, and returns to main", async () => {
    const git = fakeGit();
    const { deps } = baseDeps({
      git,
      gate: async () => ({
        ok: false,
        failedLabel: "typecheck",
        detail: "typecheck exited 2",
        steps: [{ label: "typecheck", ok: false, code: 2, tail: "error TS2304" }],
      }),
    });
    const result = await runSkillAuthorOnce(deps);

    assert.equal(result.status, "gate-failed");
    assert.equal(result.branch !== null, true);
    const names = git.calls.map((entry) => entry.call);
    assert.equal(names.includes("mergeNoFf"), false, "a red gate must never merge");
    assert.equal(names.includes("push"), false, "a red gate must never push");
    assert.ok(names.includes("createBranch"), "the branch is kept for human inspection");
    assert.ok(names.includes("commit"));
    assert.equal(git.branch, "main", "must return to main");
  });

  it("merge:false commits to the branch but does not merge", async () => {
    const git = fakeGit();
    const { deps } = baseDeps({ git, merge: false });
    const result = await runSkillAuthorOnce(deps);
    assert.equal(result.status, "verified-no-merge");
    const names = git.calls.map((entry) => entry.call);
    assert.ok(names.includes("commit"));
    assert.equal(names.includes("mergeNoFf"), false);
    assert.equal(git.branch, "main");
  });

  it("an exception while writing still returns to the starting branch", async () => {
    const git = fakeGit();
    const { deps } = baseDeps({
      git,
      writeFiles: async () => {
        throw new Error("disk full");
      },
    });
    const result = await runSkillAuthorOnce(deps);
    assert.equal(result.status, "error");
    assert.equal(result.step, "exception");
    assert.equal(git.branch, "main", "must return to main even on an exception");
    assert.equal(git.calls.some((entry) => entry.call === "mergeNoFf"), false);
  });
});

describe("pipeline: gate steps and file writing", () => {
  it("the default gate always typechecks the whole repo and tests skills", () => {
    const skillsOnly = defaultGateSteps(["packages/skills/src/a.ts"]).map((step) => step.label);
    assert.deepEqual(skillsOnly, ["typecheck", "skills test"]);

    const withRuntime = defaultGateSteps(["apps/bot-runtime/src/a.ts"]).map((step) => step.label);
    assert.deepEqual(withRuntime, ["typecheck", "bot-runtime typecheck", "skills test"]);
    for (const step of defaultGateSteps([])) assert.equal(step.command, "pnpm");
  });

  it("writeFilesToRepo creates parent directories as needed", async () => {
    const root = makeTempDir();
    await writeFilesToRepo(root, [{ path: "packages/skills/src/deep/a.ts", content: "export const a = 1;\n" }]);
    assert.equal(readFileSync(path.join(root, "packages/skills/src/deep/a.ts"), "utf8"), "export const a = 1;\n");
  });

  it("the audit log is append-only and lives under the runtime root", async () => {
    const root = makeTempDir();
    await appendAuditLog(root, { status: "merged", gapId: "gap-abc" });
    await appendAuditLog(root, { status: "gate-failed", gapId: "gap-def" });
    const lines = readFileSync(path.join(root, "skill-author/audit.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).gapId, "gap-abc");
    assert.equal(JSON.parse(lines[1]).status, "gate-failed");
  });
});
