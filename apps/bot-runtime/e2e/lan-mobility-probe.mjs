#!/usr/bin/env node
// LAN 世界（用户官方客户端 1.21.11 开的局域网世界）对照实验：
// mineflayer 在干净 vanilla 服上能不能走路——切开"客户端问题 vs luv 服务端问题"。
import mineflayer from "mineflayer";

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.LAN_PORT ?? "10110");
const HOST = process.env.LAN_HOST ?? "127.0.0.1";

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: "StudioLanTest",
  version: "1.21.11",
  auth: "offline",
});
const deadline = setTimeout(() => { log("TIMEOUT"); bot.quit(); process.exit(0); }, 120_000);

bot.once("spawn", async () => {
  const p0 = bot.entity.position;
  log(`SPAWN ${p0.x.toFixed(1)},${p0.y.toFixed(1)},${p0.z.toFixed(1)} under=${bot.blockAt(p0.offset(0, -1, 0))?.name}`);
  await sleep(2000);
  // 跳跃
  bot.setControlState("jump", true);
  await sleep(2000);
  bot.clearControlStates();
  const pj = bot.entity.position;
  log(`jump delta-y=${(pj.y - p0.y).toFixed(2)}`);
  // 疾跑
  await bot.look(Math.PI / 2, 0, true).catch(() => undefined);
  bot.setControlState("forward", true);
  bot.setControlState("sprint", true);
  bot.setControlState("jump", true);
  await sleep(5000);
  bot.clearControlStates();
  const p1 = bot.entity.position;
  const delta = p1.distanceTo(p0);
  log(`sprint delta=${delta.toFixed(2)} pos=${p1.x.toFixed(1)},${p1.y.toFixed(1)},${p1.z.toFixed(1)}`);
  log(delta > 3 ? "*** WALKS ON LAN — mineflayer 移动健康，luv 冻结=服务端 ***" : "*** FROZEN ON LAN TOO — 客户端/本机问题 ***");
  log("PROBE-DONE");
  bot.quit();
  clearTimeout(deadline);
  process.exit(0);
});
bot.on("kicked", (r) => { log(`KICKED ${String(r).slice(0, 200)}`); process.exit(0); });
bot.on("end", (r) => { log(`END ${r}`); process.exit(0); });
bot.on("error", (e) => log(`ERROR ${e.message}`));
