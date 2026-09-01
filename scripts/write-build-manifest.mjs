#!/usr/bin/env node
// ---------------------------------------------------------------------------
// write-build-manifest.mjs — 把构建身份写进 dist（Incident 元数据唯一可信来源）
//
// 背景：此前 Incident.gitCommit 来自 manager 进程启动时的 `git rev-parse`
// 快照注入 env。manager 跨 commit 存活 / 只 commit 不 rebuild 时，runtime
// 上报的 commit 与实际运行的代码脱节（INC-0008 记录 8084c70 而最终 HEAD
// 是 505eb97 的错位即源于此）。
//
// 现在：build 时把 { gitCommit, branch, dirty, buildTimestamp, buildVersion }
// 写进 <distDir>/build-manifest.json；runtime 产生 Incident 时优先读 build
// manifest（= 实际运行的构建），env STUDIO_RUNTIME_COMMIT 仅作打包/无 git
// 场景的 fallback。dirty=true 时如实记录，不伪装纯 commit build。
//
// 用法：node scripts/write-build-manifest.mjs <distDir> [packageName]
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const distDir = process.argv[2];
if (!distDir) {
  console.error("usage: write-build-manifest.mjs <distDir> [packageName]");
  process.exit(1);
}
const packageName = process.argv[3] ?? null;
const repoRoot = path.resolve(import.meta.dirname, "..");

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

let commit = null;
let branch = null;
let dirty = false;
try {
  commit = git(["rev-parse", "HEAD"]);
  branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  dirty = status.length > 0;
} catch {
  // packaged staging（无 .git）→ manifest 记 null；runtime 会退回 env
}

const manifest = {
  schemaVersion: "1.0",
  gitCommit: commit,
  gitCommitShort: commit ? commit.slice(0, 7) : null,
  branch,
  dirty,
  packageName,
  buildTimestamp: new Date().toISOString(),
  buildVersion: process.env.STUDIO_BUILD_VERSION?.trim() || "0.1.0",
};

const target = path.resolve(repoRoot, distDir);
mkdirSync(target, { recursive: true });
writeFileSync(path.join(target, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`build-manifest: commit=${manifest.gitCommitShort} branch=${branch} dirty=${dirty} → ${path.relative(repoRoot, target)}/build-manifest.json`);
