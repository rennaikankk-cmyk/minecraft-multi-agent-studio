// ---------------------------------------------------------------------------
// RuntimeIdentity —— Incident 元数据的唯一可信来源
//
// 优先级：dist/build-manifest.json（build 时写入 = 实际运行的构建身份）
//   > env STUDIO_RUNTIME_COMMIT/BRANCH（manager 注入，打包/无 git 场景 fallback）
//   > null（缺省，不伪造）
//
// 关键性质：Incident.gitCommit 必须等于"正在运行的 runtime build commit"，
// 而不是 manager 进程启动那一刻的 HEAD —— 否则跨 commit 存活的 manager
// 会让所有 Incident 记录过期的 commit（INC-0008 错位的机制性根因）。
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimeIdentity {
  readonly gitCommit: string | null;
  readonly branch: string | null;
  readonly buildVersion: string | null;
  readonly dirtyBuild: boolean | null;
  readonly source: "build-manifest" | "env" | "none";
}

interface BuildManifest {
  readonly gitCommit?: string | null;
  readonly gitCommitShort?: string | null;
  readonly branch?: string | null;
  readonly dirty?: boolean;
  readonly buildVersion?: string;
}

let cached: RuntimeIdentity | null = null;

export function loadRuntimeIdentity(): RuntimeIdentity {
  if (cached) return cached;
  const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "build-manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BuildManifest;
      if (manifest.gitCommit || manifest.gitCommitShort) {
        cached = {
          gitCommit: manifest.gitCommitShort ?? (manifest.gitCommit ? manifest.gitCommit.slice(0, 7) : null),
          branch: manifest.branch ?? null,
          buildVersion: manifest.buildVersion ?? null,
          dirtyBuild: typeof manifest.dirty === "boolean" ? manifest.dirty : null,
          source: "build-manifest",
        };
        return cached;
      }
    } catch {
      // manifest 损坏 → 走 env fallback
    }
  }
  const envCommit = process.env.STUDIO_RUNTIME_COMMIT?.trim();
  if (envCommit) {
    cached = {
      gitCommit: envCommit,
      branch: process.env.STUDIO_RUNTIME_BRANCH?.trim() ?? null,
      buildVersion: null,
      dirtyBuild: null,
      source: "env",
    };
    return cached;
  }
  cached = { gitCommit: null, branch: null, buildVersion: null, dirtyBuild: null, source: "none" };
  return cached;
}
