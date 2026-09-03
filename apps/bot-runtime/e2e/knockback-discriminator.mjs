#!/usr/bin/env node
// 击退判别：台顶（无怪区）满血走路——持续速度/血量不变/可控行为三重判据。
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
  const shaper = new MovementSyncShaper((pos) => {
    const below = bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y - 0.06), Math.floor(pos.z)));
    return below !== null && below.type !== 0;
  });
  shaper.install(bot._client);
  let hp = bot.health ?? 20;
  bot.on("health", () => {
    if (bot.health !== hp) { log(`!! HEALTH ${hp} -> ${bot.health}`); hp = bot.health; }
  });

  await sleep(2500);
  bot.chat(`/l ${PASSWORD}`);
  log(">>> /l");
  await sleep(6000);
  for (let i = 0; i < 24; i += 1) { await sleep(500); if (bot.entity.onGround) break; }
  await sleep(2500);

  // 判别零：基准漂移（站立 5s 的环境力）+ 满血门（受击会话=击退混淆无法排除）
  log("=== baseline drift 5s (no input)");
  const b0 = bot.entity.position.clone();
  await sleep(5000);
  const drift = bot.entity.position.distanceTo(b0);
  log(`baseline drift=${drift.toFixed(2)}`);
  if (hp < 20 || bot.entity.position.distanceTo(b0) > 0.5) {
    log("*** INVALID SESSION（已受击或有环境力——重试下一窗）***");
    bot.quit();
    clearTimeout(deadline);
    process.exit(0);
  }
  const p0 = bot.entity.position.clone();
  log(`start ${p0.x.toFixed(2)},${p0.y.toFixed(2)},${p0.z.toFixed(2)} hp=${hp} onGround=${bot.entity.onGround}`);

  // 判别一：持续匀速前进 6s（每秒报速率）
  // instrumented：记录走路窗口内的服务端 position 包
  const pins = [];
  const walkT0 = Date.now();
  bot._client.on("position", (p) => {
    pins.push({ dt: Date.now() - walkT0, x: p.x, y: p.y, z: p.z });
  });
  log("=== walk forward 6s (rate check)");
  await bot.look(Math.PI / 2, 0, true).catch(() => undefined);
  bot.setControlState("forward", true);
  let prev = bot.entity.position.clone();
  for (let s = 1; s <= 6; s += 1) {
    await sleep(1000);
    const p = bot.entity.position;
    log(`t+${s}s rate=${p.distanceTo(prev).toFixed(2)}b/s total=${p.distanceTo(p0).toFixed(2)} hp=${hp}`);
    prev = p.clone();
  }
  bot.clearControlStates();
  log(`pins during walk: ${JSON.stringify(pins).slice(0, 700)}`);
  log(`shaper stats: ${JSON.stringify(shaper.stats)}`);
  await sleep(1500);

  // 判别 1.5：多方向行走（撞墙假说——每方向都应真实位移直到障碍）
  for (const [name, yaw] of [["回头+x", -Math.PI / 2], ["+z", 0], ["-z", Math.PI]]) {
    const d0 = bot.entity.position.clone();
    await bot.look(yaw, 0, true).catch(() => undefined);
    bot.setControlState("forward", true);
    await sleep(2500);
    bot.setControlState("forward", false);
    const dd = bot.entity.position.distanceTo(d0);
    log(`dir ${name} delta=${dd.toFixed(2)} hp=${hp} pos=${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}`);
    await sleep(800);
  }

  // 判别二：往返机动（击退无法随叫随到）——先左 2s 再右 2s
  log("=== strafe left 2s then right 2s");
  const s0 = bot.entity.position.clone();
  bot.setControlState("left", true);
  await sleep(2000);
  const sL = bot.entity.position.clone();
  bot.setControlState("left", false);
  bot.setControlState("right", true);
  await sleep(2000);
  bot.setControlState("right", false);
  const sR = bot.entity.position.clone();
  const movedL = sL.distanceTo(s0);
  const movedR = sR.distanceTo(sL);
  log(`left-delta=${movedL.toFixed(2)} right-delta=${movedR.toFixed(2)} hp=${hp}`);

  const verdict =
    hp === 20 &&
    prev.distanceTo(p0) > 3 &&
    movedL > 1.5 &&
    movedR > 1.5;
  log(verdict
    ? "*** SELF-WALKED：满血+持续速率+双向机动=击退排除 ***"
    : "*** 判别未过（看上方数字人工判定）***");
  log(`FINAL pos=${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)} hp=${hp}`);
  bot.quit();
  clearTimeout(deadline);
  process.exit(0);
});
bot.on("message", (msg) => { const t = String(msg).trim(); if (/已成功登录|密码错误/.test(t)) log(`SERVER> ${t}`); });
bot.on("kicked", (r) => { log(`KICKED ${String(r).slice(0, 120)}`); process.exit(0); });
bot.on("end", (r) => { log(`END ${r}`); process.exit(0); });
bot.on("error", (e) => log(`ERROR ${e.message}`));
