#!/usr/bin/env node
// Phase 4 A/B 矩阵执行器（诊断专用）。
// 组：A0(基线)/B0(无遥测)/B1(跳世界快照)/C0(静景)/C1(实体批量)/A2(shadow rust)
// A1/A3（rust 开）需 studio 级 env——由外部重启切换，本脚本只跑 rust-off 代际。
// 每组：设置门/场景 → 预热一窗(35s) → 采集 3 窗(95s) → 落盘 JSON。
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const GATE = path.join(ROOT, "runtime-data", "perf-ab.json");
const OUT = path.join(ROOT, "runtime-data", "phase4-results");
const LOG = path.join(ROOT, "runtime-data", "logs", "bot-studio-bot-02.log");
const TOKEN = JSON.parse(
  fs.readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"),
).dashboardToken;
fs.mkdirSync(OUT, { recursive: true });

const TOKEN_X = TOKEN;
const ensureBotOnline = () => {
  try {
    const list = rcon("list");
    if (!list.includes("StudioWatch01")) {
      execSync(`curl -s -m 8 -X POST -H "Authorization: Bearer ${TOKEN_X}" -H "x-studio-action: start-bot" http://127.0.0.1:3230/v1/bots/studio-bot-02/start >nul 2>&1`, { shell: "cmd.exe" });
      sleepSync(12000);
    }
  } catch {}
};
const sleepSync = (ms) => execSync(`ping -n ${Math.floor(ms/1000)+1} 127.0.0.1 >nul`, { shell: "cmd.exe" });
const rcon = (cmd) =>
  execSync(`docker exec studio-local-test-mc rcon-cli -- ${cmd}`, { encoding: "utf8" }).trim();
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
