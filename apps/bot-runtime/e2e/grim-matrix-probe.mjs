#!/usr/bin/env node
// Grim 过闸矩阵：不同移动形态哪个能过反作弊（疾跑跳/纯走/潜行/缓加速）。
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
const deadline = setTimeout(() => { log("TIMEOUT"); bot.quit(); process.exit(0); }, 300_000);

bot.on("message", (msg) => {
  const t = String(msg).trim();
  if (/来登录游戏/.test(t)) { bot.chat(`/l ${PASSWORD}`); log(">>> /l"); }
  else if (t.length > 0 && !/如果你从未注册/.test(t)) log(`SERVER> ${t.slice(0, 150)}`);
});

bot.once("spawn", async () => {
  await sleep(3000); // 等 auth 落定
  for (let i = 0; i < 20; i += 1) { await sleep(500); if (bot.entity.onGround) break; }
  await sleep(2000);

  const test = async (name, states, ms, yaw = Math.PI / 2) => {
    const p0 = bot.entity.position.clone();
    await bot.look(yaw, 0, true).catch(() => undefined);
    await sleep(300);
    for (const [k, v] of states) bot.setControlState(k, v);
    await sleep(ms);
    bot.clearControlStates();
    const d = bot.entity.position.distanceTo(p0);
    log(`${name.padEnd(24)} delta=${d.toFixed(2)} pos=${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}`);
    await sleep(2000); // 让服务端状态平息
    return d;
  };

  await test("sprint+jump (已知冻结)", [["forward", true], ["sprint", true], ["jump", true]], 5000);
  await test("plain-walk", [["forward", true]], 6000);
  await test("walk+jump", [["forward", true], ["jump", true]], 5000);
  await test("sneak", [["forward", true], ["sneak", true]], 6000);
  await test("sprint-only", [["forward", true], ["sprint", true]], 5000);
  log("PROBE-DONE");
  bot.quit();
  clearTimeout(deadline);
  process.exit(0);
});
bot.on("kicked", (r) => { log(`KICKED ${String(r).slice(0, 150)}`); process.exit(0); });
bot.on("end", (r) => { log(`END ${r}`); process.exit(0); });
bot.on("error", (e) => log(`ERROR ${e.message}`));
