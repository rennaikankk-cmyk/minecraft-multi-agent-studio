#!/usr/bin/env node
// 移动能力实测：登录成功后测三件事——①脚下方块/环境 ②强制疾跑 5s 的位移
// ③30 格 pathfinder goto 的结果与位移。区分"服务器冻结"vs"寻路问题"。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
const { Movements, goals } = pathfinderPkg;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const store = JSON.parse(readFileSync(path.join(homedir(), ".studio-auth", "StudioGray01.json"), "utf8"));
const PASSWORD = store.credentials.find((c) => c.serverHost === "luv.mc6.cn").password;

const bot = mineflayer.createBot({
  host: "202.189.13.131", port: 22936, fakeHost: "luv.mc6.cn",
  username: "StudioGray01", version: "1.21.11", auth: "offline",
});
const deadline = setTimeout(() => { log("TIMEOUT"); bot.quit(); process.exit(0); }, 300_000);
let authed = false;

bot.once("spawn", async () => {
  log(`SPAWN ${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}`);
  bot.on("message", (msg) => {
    const t = String(msg);
    if (/来登录|请登录|\/l\b/iu.test(t) && !authed) { log(`SERVER> ${t}`); bot.chat(`/l ${PASSWORD}`); }
    else if (/已成功登录|成功/.test(t)) { log(`SERVER> ${t}`); authed = true; startTests(); }
    else if (/密码错误|错误/.test(t)) log(`SERVER> ${t}`);
  });
});

async function startTests() {
  const p0 = bot.entity.position.clone();
  log('p0=' + p0.x.toFixed(1) + ',' + p0.y.toFixed(1) + ',' + p0.z.toFixed(1));
  log('>>> /rtp'); bot.chat('/rtp');
  await sleep(10000);
  const p1 = bot.entity.position;
  log('after-rtp pos=' + p1.x.toFixed(1) + ',' + p1.y.toFixed(1) + ',' + p1.z.toFixed(1) + ' delta=' + p1.distanceTo(p0).toFixed(1));
  // /rtp 后走路测试
  await bot.look(Math.PI / 2, 0, true).catch(() => undefined);
  bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', true);
  await sleep(5000); bot.clearControlStates();
  const p2 = bot.entity.position;
  log('walk-delta=' + p2.distanceTo(p1).toFixed(2) + ' pos=' + p2.x.toFixed(1) + ',' + p2.y.toFixed(1) + ',' + p2.z.toFixed(1));
  log(p2.distanceTo(p1) > 3 ? '*** MOVEMENT UNLOCKED ***' : '*** STILL FROZEN ***');
  log('PROBE-DONE'); bot.quit(); clearTimeout(deadline); process.exit(0);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
bot.on("end", (r) => { log(`END ${r}`); process.exit(0); });
bot.on("error", (e) => log(`ERROR ${e.message}`));
