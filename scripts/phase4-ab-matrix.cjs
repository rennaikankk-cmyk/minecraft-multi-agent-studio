#!/usr/bin/env node
// Phase 4 A/B 矩阵执行器（诊断专用）。
// 组：A0(基线)/B0(无遥测)/B1(跳世界快照)/C0(静景)/C1(实体批量)/A2(shadow rust)
// A1/A3（rust 开）需 studio 级 env——由外部重启切换，本脚本只跑 rust-off 代际。
// 每组：设置门/场景 → 预热一窗(35s) → 采集 3 窗(95s) → 落盘 JSON。
//
// F-C3：本脚本**不再经 shell**。原实现在 `execSync(...)` 里拼
// `curl -H "Authorization: Bearer ${TOKEN}"`，令牌进入命令行字符串，是 CWE-78
// 形状（SECURITY.md §2 要求 execFile + shell: false）。现在：
//   - start-bot 走 Node 内建 fetch，令牌只作为请求头，永不进命令行；
//   - rcon 走 execFileSync（argv 数组，shell: false）；
//   - 同步等待用 Atomics.wait，不再 ping 出子进程。
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * 仓库根目录 = 本脚本所在目录的上一级（脚本固定住在 scripts/，不随 cwd 变化）。
 * 可用 STUDIO_WORKSPACE_ROOT 显式覆盖（诊断/夹具用）。
 */
function workspaceRoot() {
  if (process.env.STUDIO_WORKSPACE_ROOT) return path.resolve(process.env.STUDIO_WORKSPACE_ROOT);
  return path.resolve(__dirname, "..");
}

const ROOT = workspaceRoot();
const GATE = path.join(ROOT, "runtime-data", "perf-ab.json");
const OUT = path.join(ROOT, "runtime-data", "phase4-results");
const LOG = path.join(ROOT, "runtime-data", "logs", "bot-studio-bot-02.log");
const TOKEN = JSON.parse(
  fs.readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"),
).dashboardToken;
fs.mkdirSync(OUT, { recursive: true });

const TOKEN_X = TOKEN;
/** 同步等待：Atomics.wait 阻塞本线程，不再依赖 `ping -n` 子进程。 */
const sleepSync = (ms) => {
  const requested = Math.max(0, Math.floor(ms));
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  let remaining = requested;
  while (remaining > 0) {
    const slice = Math.min(remaining, 1_000);
    Atomics.wait(buffer, 0, 0, slice);
    remaining -= slice;
  }
};
/**
 * 经内建 fetch 触发 start-bot：令牌只出现在请求头里，绝不进 argv/命令行。
 * 失败信息只保留稳定类别（HTTP 状态或异常名），不回显响应体/地址。
 */
async function postJson(url, token, headers, timeoutMs = 8_000) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error && error.name ? error.name : "request_failed" };
  }
}
const ensureBotOnline = () => {
  // 注：本函数当前是死代码（原实现同样如此，矩阵主体从未调用它）。保留是为了
  // 不改变脚本结构；start-bot 的调用方式已改成 shell-free 的内建 fetch。
  try {
    const list = rcon("list");
    if (!list.includes("StudioWatch01")) {
      // 诊断动作：失败不阻塞矩阵（原实现把 curl 的 stderr 丢进 >nul 2>&1）。
      void postJson(
        "http://127.0.0.1:3230/v1/bots/studio-bot-02/start",
        TOKEN_X,
        { "x-studio-action": "start-bot" },
      );
      sleepSync(12000);
    }
  } catch {}
};
/** rcon：argv 数组 + shell: false（docker 与命令都不经过 shell 解析）。 */
const rcon = (cmd) =>
  execFileSync("docker", ["exec", "studio-local-test-mc", "rcon-cli", "--", cmd], {
    encoding: "utf8",
    shell: false,
  }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setGate = (mode) => fs.writeFileSync(GATE, JSON.stringify({ mode }));
const readNewWindows = (sinceByteOffset, label) => {
  const stat = fs.statSync(LOG);
  const fd = fs.openSync(LOG, "r");
  const length = stat.size - sinceByteOffset;
  const buffer = Buffer.alloc(Math.max(0, length));
  fs.readSync(fd, buffer, 0, buffer.length, sinceByteOffset);
  fs.closeSync(fd);
  const windows = [];
  for (const line of buffer.toString("utf8").split("\n")) {
    if (!line.includes("runtime_perf_window")) continue;
    try {
      windows.push(JSON.parse(line));
    } catch { /* 忽略残行 */ }
  }
  return { windows, endOffset: stat.size };
};

async function runGroup(name, setup) {
  console.log(`\n=== ${name} ===`);
  const setupInfo = setup ? await setup() : {};
  await sleep(35_000); // 预热一窗（丢弃）
  const { windows, endOffset } = readNewWindows(fs.statSync(LOG).size, name);
  await sleep(95_000); // 3 窗
  const second = readNewWindows(endOffset, name);
  const collected = second.windows;
  fs.writeFileSync(
    path.join(OUT, `${name}.json`),
    JSON.stringify({ group: name, setup: setupInfo, at: new Date().toISOString(), windows: collected }, null, 1),
  );
  console.log(`${name}: ${collected.length} windows captured`);
  return collected;
}

(async () => {
  const results = {};

   // C0：静景——tp 到远离村庄/实体的开阔点
  results.C0 = await runGroup("C0", async () => {
    try { rcon("tp StudioWatch01 246.5 68.0 -160.5"); } catch {}
    return { teleported: "246.5 68 -160.5" };
  });

  // C1：实体批量——召唤 60 只鸡在 bot 周围（可控实体负载）
  results.C1 = await runGroup("C1", async () => {
    const summons = [];
    for (let i = 0; i < 60; i += 1) {
      const dx = Math.floor(Math.random() * 16) - 8;
      const dz = Math.floor(Math.random() * 16) - 8;
      try { summons.push(rcon(`summon minecraft:chicken ${400 + dx} 80 ${400 + dz}`)); } catch {}
    }
    return { summoned: summons.length, at: "400,80,400" };
  });

  // 清场：杀掉诊断实体（只杀鸡，坐标限定诊断区）
  try { rcon("kill @e[type=minecraft:chicken,x=230,y=60,z=-180,dx=40,dy=20,dz=40]"); } catch {}
  setGate("off");

  // A2：shadow rust（诊断门：1s 计划请求，不执行）
  setGate("shadow_rust");
  results.A2 = await runGroup("A2", async () => ({ gate: "shadow_rust" }));
  setGate("off");

  // 汇总表
  const summary = {};
  for (const [name, windows] of Object.entries(results)) {
    const delay = windows.map((w) => w).filter(Boolean);
    summary[name] = {
      windowCount: windows.length,
      note: "see per-group json",
    };
  }
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
  console.log("\nphase4 matrix (rust-off generation) done");
})();
