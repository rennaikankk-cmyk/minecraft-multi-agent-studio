#!/usr/bin/env node
// 一次性法证探针：登录 luv 出生点，记录身边实体/伤害/聊天（死亡消息点名凶手）。
// 不带任何保护——目的就是看清谁/什么杀了它。用完即弃账号 StudioProbe01。
import mineflayer from "mineflayer";

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const bot = mineflayer.createBot({
  host: "202.189.13.131",
  port: 22936,
  fakeHost: "luv.mc6.cn",
  username: "StudioProbe01",
  version: "1.21.11",
  auth: "offline",
});

const deadline = setTimeout(() => { log("PROBE-EXIT: timeout"); bot.quit(); process.exit(0); }, 300_000);

bot.once("login", () => log("LOGIN ok"));
bot.once("spawn", () => {
  log(`SPAWN at ${JSON.stringify(bot.entity.position)} health=${bot.health}`);
  const dump = () => {
    const nearby = Object.values(bot.entities)
      .filter((e) => e.position && e.position.distanceTo(bot.entity.position) < 48)
      .slice(0, 40);
    for (const e of nearby) {
      log(`ENTITY id=${e.id} type=${e.type ?? e.name} username=${e.username ?? "-"} uuid=${e.uuid ?? "-"} pos=${e.position ? `${e.position.x.toFixed(0)},${e.position.y.toFixed(0)},${e.position.z.toFixed(0)}` : "-"} dist=${e.position ? e.position.distanceTo(bot.entity.position).toFixed(1) : "?"}`);
    }
    log(`BLOCK under: ${bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name} / at feet: ${bot.blockAt(bot.entity.position)?.name} / at head: ${bot.blockAt(bot.entity.position.offset(0, 1, 0))?.name}`);
  };
  dump();
  bot.on("entitySpawn", (e) => { if (e.type === "player" || e.username) log(`PLAYER-SPAWN ${e.username} id=${e.id} dist=${e.position?.distanceTo(bot.entity.position)?.toFixed?.(1) ?? "?"}`); });
  bot.on("playerJoined", (p) => log(`PLAYER-JOINED ${p.username}`));
  bot.on("health", () => log(`HEALTH ${bot.health}`));
  bot.on("death", () => log("DEATH"));
  bot.on("message", (msg) => log(`CHAT ${msg.toAnsi ? msg.toString() : String(msg)}`));
  bot.on("kicked", (r) => log(`KICKED ${String(r).slice(0, 300)}`));
  bot.on("end", (r) => { log(`END ${r}`); clearTimeout(deadline); process.exit(0); });
  setTimeout(dump, 3000);
  setTimeout(dump, 8000);
});
bot.on("error", (e) => log(`ERROR ${e.message}`));
bot.on("end", (r) => { log(`PRE-SPAWN-END ${r}`); clearTimeout(deadline); process.exit(0); });
