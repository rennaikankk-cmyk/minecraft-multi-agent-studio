#!/usr/bin/env node
// 认证验证探针：用 StudioGray01 + 凭据库密码登录 luv，逐字记录服务器
// 对 /login（或必要时 /reg）的回复——回答"到底注册/登录成功过没有"。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import mineflayer from "mineflayer";

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const store = JSON.parse(
  readFileSync(path.join(homedir(), ".studio-auth", "StudioGray01.json"), "utf8"),
);
const cred = store.credentials.find((c) => c.serverHost === "luv.mc6.cn");
if (!cred) { console.error("no credential for luv"); process.exit(1); }
const PASSWORD = cred.password;
log(`using stored password (${PASSWORD.length} chars, registeredAt=${cred.registeredAt})`);

const bot = mineflayer.createBot({
  host: "202.189.13.131",
  port: 22936,
  fakeHost: "luv.mc6.cn",
  username: "StudioGray01",
  version: "1.21.11",
  auth: "offline",
});

const deadline = setTimeout(() => { log("PROBE-EXIT: timeout"); bot.quit(); process.exit(0); }, 300_000);
let acted = false;

bot.once("spawn", () => {
  const p = bot.entity.position;
  log(`SPAWN ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} health=${bot.health}`);
  bot.on("message", (msg) => {
    const text = String(msg);
    log(`SERVER> ${text}`);
    if (acted) return;
    if (/还没有注册|请注册|register/iu.test(text)) {
      acted = true;
      log(">>> sending /reg (registration apparently never succeeded)");
      bot.chat(`/reg ${PASSWORD} ${PASSWORD}`);
    } else if (/请登录|请输入密码|\/login|\/l\b|来登录/iu.test(text)) {
      acted = true;
      log(">>> sending /login");
      bot.chat(`/login ${PASSWORD}`);
    }
  });
  bot.on("health", () => log(`HEALTH ${bot.health}`));
  // 每 5s 记录位置——拉回循环（未认证）vs 自由坠落/移动（已认证）
  let ticks = 0;
  const posTimer = setInterval(() => {
    ticks += 1;
    const q = bot.entity?.position;
    if (q) log(`POS ${q.x.toFixed(1)},${q.y.toFixed(1)},${q.z.toFixed(1)}`);
    if (ticks > 20) { clearInterval(posTimer); log("PROBE-DONE (100s)"); bot.quit(); }
  }, 5_000);
});
bot.on("kicked", (r) => { log(`KICKED ${String(r).slice(0, 300)}`); clearTimeout(deadline); process.exit(0); });
bot.on("end", (r) => { log(`END ${r}`); clearTimeout(deadline); process.exit(0); });
bot.on("error", (e) => log(`ERROR ${e.message}`));
