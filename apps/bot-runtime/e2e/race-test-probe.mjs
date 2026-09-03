#!/usr/bin/env node
// luv 登录竞态验证：spawn 后等 4s 再发 /l（模拟人工节奏），然后测走路。
// 背景：用户（Fabric 客户端 1.21.11）手动输 /l 后能走；bot 毫秒级回 /l 后冻结。
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

bot.on("message", (msg) => {
  const t = String(msg).trim();
  if (t.length > 0 && !/来登录游戏|如果你从未注册/.test(t)) log(`SERVER> ${t.slice(0, 200)}`);
});

bot.once("spawn", async () => {
  log("spawned — holding /l for 4s (race test)");
  await sleep(4000);
  log(">>> /l (delayed)");
  bot.chat(`/l ${PASSWORD}`);
  await sleep(8000);
  for (let i = 0; i < 20; i += 1) { await sleep(500); if (bot.entity.onGround) break; }
  const p1 = bot.entity.position.clone();
  log(`pos=${p1.x.toFixed(1)},${p1.y.toFixed(1)},${p1.z.toFixed(1)}`);
  await bot.look(Math.PI / 2, 0, true).catch(() => undefined);
  bot.setControlState("forward", true);
  bot.setControlState("sprint", true);
  bot.setControlState("jump", true);
  await sleep(5000);
  bot.clearControlStates();
  const p2 = bot.entity.position;
  const delta = p2.distanceTo(p1);
  log(`walk-delta=${delta.toFixed(2)} pos=${p2.x.toFixed(1)},${p2.y.toFixed(1)},${p2.z.toFixed(1)}`);
  log(delta > 3 ? "*** MOVEMENT UNLOCKED — RACE CONFIRMED ***" : "*** STILL FROZEN — race hypothesis dead ***");
  log("PROBE-DONE");
  bot.quit();
  clearTimeout(deadline);
  process.exit(0);
});
bot.on("kicked", (r) => { log(`KICKED ${String(r).slice(0, 200)}`); process.exit(0); });
bot.on("end", (r) => { log(`END ${r}`); process.exit(0); });
bot.on("error", (e) => log(`ERROR ${e.message}`));
