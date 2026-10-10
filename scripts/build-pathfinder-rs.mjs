#!/usr/bin/env node
// pathfinder-rs 构建桥：cargo build --release → 拷贝 dll 为 .node。
// Windows 无 MSVC（或 Git Bash coreutils link.exe 遮蔽 MSVC 链接器）时，
// 自动回退 rustup GNU 工具链 + 探测到的 mingw-w64 dlltool 目录。
// 显式指定目录仍走 PATHFINDER_RS_MINGW_BIN；Linux/macOS 行为不变。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "pathfinder-rs");

function buildEnv(mingwBin, overrides = {}) {
  const PATH = mingwBin ? `${mingwBin}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH;
  return { ...process.env, ...(PATH ? { PATH } : {}), ...overrides };
}

function findGnuToolchain() {
  const listed = spawnSync("rustup", ["toolchain", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (listed.status !== 0 || !listed.stdout) return null;
  const names = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*\(.*\)\s*$/, "").trim())
    .filter((name) => name.endsWith("x86_64-pc-windows-gnu"));
  return names.find((name) => name.startsWith("stable-")) ?? names[0] ?? null;
}

function findMingwBin(gnuToolchain) {
  const candidates = [];
  if (process.env.PATHFINDER_RS_MINGW_BIN) candidates.push(process.env.PATHFINDER_RS_MINGW_BIN);
  candidates.push("C:\\msys64\\mingw64\\bin", "C:\\msys64\\ucrt64\\bin", "C:\\mingw64\\bin");
  if (process.env.USERPROFILE) {
    candidates.push(
      path.join(process.env.USERPROFILE, "mingw64", "mingw64", "bin"),
      path.join(process.env.USERPROFILE, "mingw64", "bin"),
    );
  }
  if (gnuToolchain && (process.env.RUSTUP_HOME || process.env.USERPROFILE)) {
    const rustupHome = process.env.RUSTUP_HOME ?? path.join(process.env.USERPROFILE, ".rustup");
    candidates.push(path.join(rustupHome, "toolchains", gnuToolchain, "lib", "rustlib", "x86_64-pc-windows-gnu", "bin", "self-contained"));
  }
  return candidates.find((dir) => existsSync(path.join(dir, "dlltool.exe"))) ?? null;
}

const args = ["build", "--release", "--locked"];
let result = spawnSync("cargo", args, { cwd: root, env: buildEnv(process.env.PATHFINDER_RS_MINGW_BIN), stdio: "inherit" });
if (result.status !== 0 && process.platform === "win32") {
  const gnuToolchain = findGnuToolchain();
  const mingwBin = gnuToolchain ? findMingwBin(gnuToolchain) : null;
  if (gnuToolchain && mingwBin) {
    console.warn(`pathfinder-rs: 默认工具链构建失败，回退 GNU 工具链 ${gnuToolchain}（dlltool: ${mingwBin}）`);
    result = spawnSync("cargo", args, { cwd: root, env: buildEnv(mingwBin, { RUSTUP_TOOLCHAIN: gnuToolchain }), stdio: "inherit" });
  }
}
if (result.status !== 0) process.exit(result.status ?? 1);
const library = { win32: "pathfinder_rs.dll", linux: "libpathfinder_rs.so", darwin: "libpathfinder_rs.dylib" }[process.platform];
if (!library) throw new Error(`Unsupported native build platform: ${process.platform}`);
const target = process.env.CARGO_TARGET_DIR ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, "target");
const dll = path.join(target, "release", library);
if (!existsSync(dll)) { console.error(`missing ${dll}`); process.exit(1); }
copyFileSync(dll, path.join(root, "pathfinder_rs.node"));
console.log("pathfinder-rs: addon refreshed (pathfinder_rs.node)");
