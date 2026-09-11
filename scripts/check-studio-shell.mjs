// studio-shell 的 cargo check：前置条件说明 + 条件执行。
//
// 已实测的事实（2026-09-11）：
//   tauri-build 在**编译期**强制要求 tauri.conf.json 的 bundle.resources 全部存在：
//     - 精确路径缺失 → `resource path \`MinecraftMultiAgentStudioBackend.exe\` doesn't exist`
//     - 改成 glob 也无效 → `glob pattern ... didn't match any files`
//   而该资源是 Windows 专属构建产物：
//     - 由 `pnpm build:exe` 产出（scripts/build-studio-exe.mjs 在非 win32 直接抛错）
//     - 由 scripts/build-studio-shell.mjs 复制到 apps/studio-shell/ 后才参与打包
//     - 运行时由 main.rs:203-209 从 shell 可执行文件同级目录加载，故**不能**从
//       tauri.conf.json 里删掉（删了打包后的应用会找不到后端）。
//   ⇒ 结论：cargo check 只能在"资源已就位"的机器（Windows 且已跑过 build:exe）上运行；
//     Linux/CI runner 上结构性地无法执行。这不是配置疏漏，是本项目的构建形态决定的。
//
// 本脚本的纪律：资源存在就跑**真实**的 cargo check；缺失就打印醒目的 SKIPPED 说明并
// 返回 0 —— 只报告"未验证"，绝不伪造"通过"（AGENTS.md §1.6 / §9）。

import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const manifest = path.join(root, "apps", "studio-shell", "Cargo.toml");
const resource = path.join(root, "apps", "studio-shell", "MinecraftMultiAgentStudioBackend.exe");

if (!existsSync(resource)) {
  console.log("[studio-shell] SKIPPED cargo check — 前置资源缺失，本项未验证");
  console.log(`[studio-shell]   缺失: ${path.relative(root, resource)}`);
  console.log("[studio-shell]   原因: tauri-build 编译期强制要求 bundle.resources 存在；");
  console.log("[studio-shell]         该文件只在 Windows 上由 `pnpm build:exe` 产出。");
  console.log("[studio-shell]   要真正验证: 在 Windows 上先 `pnpm build:exe`（或 `pnpm build:exe:skip-build`），");
  console.log("[studio-shell]         再 `pnpm studio:shell:check`。");
  console.log("[studio-shell]   ⚠ 本次未运行 cargo check，不得据此认为 studio-shell 已通过编译检查。");
  process.exit(0);
}

const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const child = spawn(cargo, ["check", "--manifest-path", manifest], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
child.once("error", (error) => {
  console.error(`[studio-shell] failed to run ${cargo}: ${error.message}`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 1));
});
