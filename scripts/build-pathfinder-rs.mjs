#!/usr/bin/env node
// pathfinder-rs 构建桥：cargo build --release → 拷贝 dll 为 .node。
// WinLibs GNU 工具链需要 dlltool 在 PATH（C:\Users\renna\mingw64\mingw64\bin）。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "pathfinder-rs");
const extraPath = process.env.PATHFINDER_RS_MINGW_BIN ?? "C:\Users\renna\mingw64\mingw64\bin";
const env = { ...process.env, PATH: `${extraPath};${process.env.PATH ?? ""}` };
const result = spawnSync("cargo", ["build", "--release"], { cwd: root, env, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
const dll = path.join(root, "target", "release", "pathfinder_rs.dll");
if (!existsSync(dll)) { console.error(`missing ${dll}`); process.exit(1); }
copyFileSync(dll, path.join(root, "pathfinder_rs.node"));
console.log("pathfinder-rs: addon refreshed (pathfinder_rs.node)");
