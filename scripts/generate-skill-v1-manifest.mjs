#!/usr/bin/env node
// ---------------------------------------------------------------------------
// generate-skill-v1-manifest.mjs —— 从 dist 构建产物生成 machine-readable 的
// skill-system-v1.manifest.json（Skill System v1 提示词 §三的 SSOT 落盘形态）。
//
// 用法：
//   node scripts/generate-skill-v1-manifest.mjs           # 写入 packages/skills/skill-system-v1.manifest.json
//   node scripts/generate-skill-v1-manifest.mjs --check   # 只校验落盘文件与推导一致（CI 门）
//
// 推导源：packages/skills/dist/v1-manifest.js（先 pnpm --filter skills build）。
// gates 测试（v1-manifest-gates.test.ts）在 vitest 里做同样的深比较，本脚本
// 供 CI/human 重新生成与本地校验。
// ---------------------------------------------------------------------------

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const outputPath = join(repoRoot, "packages/skills/skill-system-v1.manifest.json");

const { skillSystemV1Manifest } = await import(
  pathToFileURL(join(repoRoot, "packages/skills/dist/v1-manifest.js")).href
);

const serialized = `${JSON.stringify(skillSystemV1Manifest, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let existing = "";
  try {
    existing = readFileSync(outputPath, "utf8");
  } catch {
    console.error(`[manifest] missing ${outputPath} — run the generator first`);
    process.exit(1);
  }
  if (existing !== serialized) {
    console.error(
      "[manifest] checked-in skill-system-v1.manifest.json is stale — regenerate with:\n" +
        "  pnpm --filter @minecraft-studio/skills build && node scripts/generate-skill-v1-manifest.mjs",
    );
    process.exit(1);
  }
  console.log("[manifest] up to date");
  process.exit(0);
}

writeFileSync(outputPath, serialized, "utf8");
console.log(
  `[manifest] wrote ${outputPath} (${skillSystemV1Manifest.totalSkills} skills, ` +
    `summary ${JSON.stringify(skillSystemV1Manifest.maturitySummary)})`,
);
