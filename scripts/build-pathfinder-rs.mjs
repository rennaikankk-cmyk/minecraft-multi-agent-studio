#!/usr/bin/env node
// pathfinder-rs 构建桥：cargo build --release → 拷贝 dll 为 .node。
// WinLibs GNU 工具链需要 dlltool 在 PATH（C:\Users\renna\mingw64\mingw64\bin）。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "pathfinder-rs");
const extraPath = process.env.PATHFINDER_RS_MINGW_BIN;
const env = { ...process.env, ...(extraPath ? { PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ""}` } : {}) };
const result = spawnSync("cargo", ["build", "--release", "--locked"], { cwd: root, env, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
const library = { win32: "pathfinder_rs.dll", linux: "libpathfinder_rs.so", darwin: "libpathfinder_rs.dylib" }[process.platform];
if (!library) throw new Error(`Unsupported native build platform: ${process.platform}`);
const target = process.env.CARGO_TARGET_DIR ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, "target");
const dll = path.join(target, "release", library);
if (!existsSync(dll)) { console.error(`missing ${dll}`); process.exit(1); }
copyFileSync(dll, path.join(root, "pathfinder_rs.node"));
console.log("pathfinder-rs: addon refreshed (pathfinder_rs.node)");
