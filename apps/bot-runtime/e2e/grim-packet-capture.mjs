#!/usr/bin/env node
// Grim 定性抓包：双向包捕获——服务端 setback/传送/abilities 形态 +
// 我方发出的位置包节奏与内容（含 teleport confirm 纪律）。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import mineflayer from "mineflayer";

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const store = JSON.parse(readFileSync(path.join(homedir(), ".studio-auth", "StudioGray01.json"), "utf8"));
const PASSWORD = store.credentials.find((c) => c.serverHost === "luv.mc6.cn").password;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bot = mineflayer.createBot({
  host: "202.189.13.131", port: 22936, fakeHost: "luv.mc6.cn",
  username: "StudioGray01", version: "1.21.11", auth: "offline",
});
const deadline = setTimeout(() => { log("TIMEOUT"); bot.quit(); process.exit(0); }, 240_000);

bot.once("spawn", async () => {
  const client = bot._client;
  // ---- 入向：全部包名计数 + 关键包全量 ----
  const inCount = new Map();
  const interesting = new Set(["position", "abilities", "entity_velocity", "player_abilities", "set_center_chunk", "teleport_confirm", "accept_teleportation", "ping", "pong"]);
  client.on("packet", (packet) => {
    const name = packet?.name ?? "?";
    inCount.set(name, (inCount.get(name) ?? 0) + 1);
    if (interesting.has(name) && (inCount.get(name) ?? 0) <= 6) {
      log(`IN  ${name} ${JSON.stringify(packet?.params ?? {}).slice(0, 260)}`);
    }
  });
  // ---- 出向：包装 write ----
  const outCount = new Map();
  const origWrite = client.write.bind(client);
  client.write = (name, params, ...rest) => {
    outCount.set(name, (outCount.get(name) ?? 0) + 1);
    if (/position|rotate|look|teleport|accept|confirm|flying|abilities/.test(name) && (outCount.get(name) ?? 0) <= 8) {
      log(`OUT ${name} ${JSON.stringify(params ?? {}).slice(0, 260)}`);
    }
    return origWrite(name, params, ...rest);
  };

  log("spawned — waiting 3s (auth)");
  await sleep(3000);
  bot.chat(`/l ${PASSWORD}`);
  log(">>> /l");
  await sleep(5000);

  // ---- 移动窗口：纯走 8s，期间每秒报位置 + 计数快照 ----
  log("=== walk window (8s plain forward) ===");
  await bot.look(Math.PI / 2, 0, true).catch(() => undefined);
  bot.setControlState("forward", true);
  const t0 = Date.now();
  const posSnap0 = bot.entity.position.clone();
  const outWalk0 = new Map(outCount);
  const inWalk0 = new Map(inCount);
  for (let s = 1; s <= 8; s += 1) {
    await sleep(1000);
    const p = bot.entity.position;
    log(`t+${s}s pos=${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} onGround=${bot.entity.onGround} delta-from-start=${p.distanceTo(posSnap0).toFixed(2)}`);
  }
  bot.clearControlStates();
  const walkOut = [...outCount].filter(([k]) => (outWalk0.get(k) ?? 0) !== outCount.get(k));
  const walkIn = [...inCount].filter(([k]) => (inWalk0.get(k) ?? 0) !== inCount.get(k));
  log(`OUT during walk: ${JSON.stringify(walkOut.map(([k, v]) => `${k}×${v - (outWalk0.get(k) ?? 0)}`))}`);
  log(`IN  during walk: ${JSON.stringify(walkIn.map(([k, v]) => `${k}×${v - (inWalk0.get(k) ?? 0)}`)).slice(0, 500)}`);
  log("PROBE-DONE");
  bot.quit();
  clearTimeout(deadline);
  process.exit(0);
});
bot.on("message", (msg) => { const t = String(msg).trim(); if (/已成功登录|密码错误/.test(t)) log(`SERVER> ${t}`); });
bot.on("kicked", (r) => { log(`KICKED ${String(r).slice(0, 150)}`); process.exit(0); });
bot.on("end", (r) => { log(`END ${r}`); process.exit(0); });
bot.on("error", (e) => log(`ERROR ${e.message}`));
