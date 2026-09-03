#!/usr/bin/env node
// movementSync 整形器 luv 实测：登录后走路对照（无整形=0.03 冻结）。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import mineflayer from "mineflayer";
import { Vec3 } from "vec3";
import { MovementSyncShaper } from "../dist/movement-sync.js";

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const store = JSON.parse(readFileSync(path.join(homedir(), ".studio-auth", "StudioGray01.json"), "utf8"));
const PASSWORD = store.credentials.find((c) => c.serverHost === "luv.mc6.cn").password;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bot = mineflayer.createBot({
  host: "202.189.13.131", port: 22936, fakeHost: "luv.mc6.cn",
  username: "StudioGray01", version: "1.21.11", auth: "offline",
});
const deadline = setTimeout(() => { log("TIMEOUT"); bot.quit(); process.exit(0); }, 300_000);

bot.once("spawn", async () => {
  const wire = bot._client;
  const shaper = new MovementSyncShaper((pos) => {
    const below = bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y - 0.06), Math.floor(pos.z)));
    return below !== null && below.type !== 0;
  });
  const detach = shaper.install(wire);
  log("shaper installed");

  // 登录
  await sleep(2500);
  bot.chat(`/l ${PASSWORD}`);
  log(">>> /l");
  await sleep(6000);
  // 等落地+服从窗平息
  for (let i = 0; i < 24; i += 1) { await sleep(500); if (bot.entity.onGround) break; }
  await sleep(3000);

  const p0 = bot.entity.position.clone();
  log(`start pos=${p0.x.toFixed(2)},${p0.y.toFixed(2)},${p0.z.toFixed(2)} onGround=${bot.entity.onGround} stats=${JSON.stringify(shaper.stats)}`);

  // 走路窗口 10s（纯走）
  await bot.look(Math.PI / 2, 0, true).catch(() => undefined);
  bot.setControlState("forward", true);
  for (let s = 1; s <= 10; s += 1) {
    await sleep(1000);
    const p = bot.entity.position;
    log(`t+${s}s delta=${p.distanceTo(p0).toFixed(2)} pos=${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} onGround=${bot.entity.onGround}`);
    if (p.distanceTo(p0) > 20) break;
  }
  bot.clearControlStates();
  await sleep(1500);
  const d = bot.entity.position.distanceTo(p0);
  log(`FINAL delta=${d.toFixed(2)} shaper-stats=${JSON.stringify(shaper.stats)}`);
  log(d > 3 ? "*** MOVEMENT UNLOCKED BY SHAPER ***" : "*** STILL FROZEN ***");
  detach();
  bot.quit();
  clearTimeout(deadline);
  process.exit(0);
});
bot.on("message", (msg) => { const t = String(msg).trim(); if (/已成功登录|密码错误/.test(t)) log(`SERVER> ${t}`); });
bot.on("kicked", (r) => { log(`KICKED ${String(r).slice(0, 150)}`); process.exit(0); });
bot.on("end", (r) => { log(`END ${r}`); process.exit(0); });
bot.on("error", (e) => log(`ERROR ${e.message}`));
