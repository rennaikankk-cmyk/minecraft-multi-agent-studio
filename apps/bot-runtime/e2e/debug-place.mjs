// 最小放置探针：逐项打点定位 placeBlock 失败原因
import mineflayer from "mineflayer";
import vec3 from "vec3";
import { rcon } from "./server-manager.mjs";
import { InMemoryWorkstationRegistry, FacilityRegistry, smeltingLinePattern } from "@minecraft-studio/skills";
const _keepalive = [InMemoryWorkstationRegistry, FacilityRegistry, smeltingLinePattern];

const bot = mineflayer.createBot({ host: "127.0.0.1", port: 25599, username: "studio-e2e-bot", version: "1.21.11", auth: "offline" });

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }

bot.once("spawn", async () => {
  try {
    log("spawned; gameMode=", bot.game.gameMode);
    await rcon("tp studio-e2e-bot 8 66 8");
    await new Promise((r) => setTimeout(r, 1500));
    // 等 onGround
    for (let i = 0; i < 50 && !bot.entity.onGround; i += 1) await new Promise((r) => setTimeout(r, 100));
    log("onGround=", bot.entity.onGround, "pos=", JSON.stringify(bot.entity.position));

    await rcon("fill 6 64 6 12 64 12 dirt");
    await rcon("fill 6 65 6 12 65 12 air");
    await new Promise((r) => setTimeout(r, 1000));

    const ref = bot.blockAt(vec3(10, 64, 8));
    log("ref block:", ref?.name);
    log("target before:", bot.blockAt(vec3(10, 65, 8))?.name);

    await rcon("give studio-e2e-bot cobblestone 8");
    for (let i = 0; i < 30; i += 1) {
      const item = bot.inventory.items().find((it) => it.name === "cobblestone");
      if (item) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const item = bot.inventory.items().find((it) => it.name === "cobblestone");
    log("item in inventory:", item?.name, item?.count);

    await bot.equip(item, "hand");
    log("held:", bot.heldItem?.name);
    await bot.lookAt(vec3(10.5, 64.5, 8.5));
    log("looking at ref; yaw/pitch=", bot.entity.yaw.toFixed(2), bot.entity.pitch.toFixed(2));

    try {
      await bot.placeBlock(ref, vec3(0, 1, 0));
      log("placeBlock resolved");
    } catch (e) {
      log("placeBlock threw:", e.message);
    }
    for (let i = 0; i < 20; i += 1) {
      const b = bot.blockAt(vec3(10, 65, 8));
      log(`poll ${i}: target=`, b?.name);
      if (b?.name === "cobblestone") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const finalBlock = bot.blockAt(vec3(10, 65, 8));
    log("FINAL target block:", finalBlock?.name);
    bot.quit();
    process.exit(finalBlock?.name === "cobblestone" ? 0 : 1);
  } catch (e) {
    log("FATAL:", e.message);
    bot.quit();
    process.exit(1);
  }
});

bot.on("kicked", (r) => log("kicked:", r));
bot.on("error", (e) => log("error:", e.message));
