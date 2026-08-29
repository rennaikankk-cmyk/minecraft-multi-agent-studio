// ---------------------------------------------------------------------------
// Generic Minecraft E2E —— 本地 offline-mode 测试服务器 fixture（三十九/四十节）
//
// E2E-A 层：Paper/Vanilla 兼容、offline 模式、固定种子、RCON 可用。
// 不需要 AuthMe（AuthMe 属于 E2E-B 层，单独环境单独测）。
//
// 用法：
//   node e2e/server-manager.mjs start   # 启动（等待 Done）
//   node e2e/server-manager.mjs stop    # 停止并清理（保留日志到 e2e/logs/）
//   node e2e/server-manager.mjs rcon "<command>"   # 执行服务器命令
//
// 依赖：本机 Docker + 已拉取 itzg/minecraft-server 镜像。
// ---------------------------------------------------------------------------

import { execFile, spawn } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(E2E_DIR, "logs");
mkdirSync(LOGS_DIR, { recursive: true });

export const E2E_CONTAINER = "studio-e2e-mc";
export const E2E_HOST_PORT = 25599;
export const E2E_MC_VERSION = "1.21.11"; // mineflayer 4.37.1 tested 上限
// 本地镜像（daocloud 镜像源已缓存）；直连用户可改 docker.io/itzg/minecraft-server
export const E2E_IMAGE = process.env.STUDIO_E2E_IMAGE ?? "docker.m.daocloud.io/itzg/minecraft-server:latest";

function docker(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args.join(" ")} failed: ${stderr || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(join(LOGS_DIR, "server-manager.log"), `${stamped}\n`, "utf8");
}

export async function isRunning() {
  const state = await docker(["inspect", "-f", "{{.State.Running}}", E2E_CONTAINER], { timeoutMs: 10_000 }).catch(() => null);
  return state === "true";
}

/** 启动 offline 模式服务器并等待 "Done"（server 完全 ready）。 */
export async function startServer({ timeoutMs = 240_000 } = {}) {
  if (await isRunning()) {
    log(`server already running (${E2E_CONTAINER}); waiting for ready`);
    await waitUntilDone(timeoutMs);
    return;
  }
  log(`starting ${E2E_IMAGE} version=${E2E_MC_VERSION} offline seed=studio-e2e`);
  await docker([
    "run", "-d", "--name", E2E_CONTAINER,
    "-p", `${E2E_HOST_PORT}:25565`,
    // named volume：重启复用已下载的 server jar（世界每次仍由固定种子重建）
    "-v", "studio-e2e-data:/data",
    "-e", "EULA=TRUE",
    "-e", "ONLINE_MODE=FALSE",
    "-e", `VERSION=${E2E_MC_VERSION}`,
    "-e", "TYPE=VANILLA",
    "-e", "SEED=studio-e2e-fixed",
    "-e", "MODE=survival",
    "-e", "DIFFICULTY=peaceful",
    "-e", "MEMORY=2G",
    "-e", "USE_AIKAR_FLAGS=true",
    "-e", "SPAWN_PROTECTION=0",
    "-e", "ENABLE_COMMAND_BLOCK=false",
    "-e", "VIEW_DISTANCE=6",
    E2E_IMAGE,
  ]);
  await waitUntilDone(timeoutMs);
}

/** 轮询 docker logs 直到出现 "Done ("（服务器 ready）或超时。 */
export async function waitUntilDone(timeoutMs = 240_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const logs = await docker(["logs", "--tail", "80", E2E_CONTAINER], { timeoutMs: 15_000 }).catch(() => "");
    appendFileSync(join(LOGS_DIR, "server-lifecycle.log"), `${logs}\n---\n`, "utf8");
    if (/Done \([\d.]+s\)!/i.test(logs)) {
      log("server ready (Done line observed)");
      return;
    }
    if (/ERROR|Failed to start/i.test(logs) && Date.now() - startedAt > 30_000) {
      throw new Error(`server failed to start:\n${logs.slice(-2000)}`);
    }
    await sleep(3_000);
  }
  const tail = await docker(["logs", "--tail", "40", E2E_CONTAINER]).catch(() => "");
  throw new Error(`server not ready within ${timeoutMs}ms; last logs:\n${tail}`);
}

export async function stopServer({ keepLogs = true } = {}) {
  if (keepLogs) {
    const logs = await docker(["logs", E2E_CONTAINER], { timeoutMs: 15_000 }).catch(() => "");
    appendFileSync(join(LOGS_DIR, "server-full.log"), `${logs}\n`, "utf8");
  }
  await docker(["rm", "-f", E2E_CONTAINER], { timeoutMs: 60_000 }).catch((error) => log(`rm failed: ${error.message}`));
  log("server stopped and removed");
}

/** 通过 rcon-cli 在服务器执行命令（给物品/传送/setblock 等）。 */
export async function rcon(command) {
  const out = await docker(["exec", E2E_CONTAINER, "rcon-cli", command], { timeoutMs: 20_000 });
  if (keepRconLog) appendFileSync(join(LOGS_DIR, "rcon.log"), `> ${command}\n${out}\n`, "utf8");
  return out;
}
let keepRconLog = true;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -- CLI（仅直接调用时执行；被 import 时不跑） -------------------------------
const isDirect = import.meta.url === `file://${fileURLToPath(import.meta.url).replace(/\\/g, "/")}` || process.argv[1]?.endsWith("server-manager.mjs");
if (isDirect) {
  const command = process.argv[2];
  if (command === "start") {
    await startServer();
  } else if (command === "stop") {
    await stopServer();
  } else if (command === "rcon") {
    console.log(await rcon(process.argv[3] ?? "list"));
  } else if (command) {
    console.error(`unknown command: ${command} (start|stop|rcon)`);
    process.exit(1);
  }
}
