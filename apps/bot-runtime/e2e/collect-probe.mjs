#!/usr/bin/env node
// 只读诊断探针：真实 mineflayer 登录 local test server，执行一次 collect.block
// 能力调用，插桩 dig/pickup/entity 事件，隔离 coordinator 观察拾取链。
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createMineflayerClient } from "../dist/mineflayer-client.js";

const profile = JSON.parse(readFileSync(new URL("../../../runtime-data/bots/studio-bot-01/server-profile.json", import.meta.url), "utf8"));
const client = createMineflayerClient({ ...profile, username: "ProbePickup" + Date.now().toString(36).slice(-4), botId: "probe" });
const bot = client.bot ?? null;

// 拿到底层 bot 事件
setTimeout(() => {
  if (!bot) { console.log("NO BOT HANDLE"); process.exit(1); }
  const seen = { dug: 0, pickups: 0, entitySpawn: 0, inventoryUpdates: 0 };
  bot.on("diggingStarted", () => { seen.dug += 1; console.log(`[probe] diggingStarted`); });
  bot.on("itemPickedUp", () => { seen.pickups += 1; console.log(`[probe] itemPickedUp`); });
  bot.on("entitySpawn", (e) => {
    const name = String(e?.name ?? e?.displayName ?? "");
    if (name.toLowerCase() === "item") { seen.entitySpawn += 1; console.log(`[probe] item entity spawned at`, JSON.stringify(e.position ?? null)); }
  });
  bot.inventory?.on?.("updateSlot", () => { seen.inventoryUpdates += 1; });
  bot.on("error", (e) => console.log(`[probe] bot error:`, String(e?.message ?? e).slice(0, 150)));

  setTimeout(async () => {
    console.log(`[probe] pre-collect pos:`, JSON.stringify(bot.entity?.position ?? null).slice(0, 60));
    console.log(`[probe] entities sample:`, Object.values(bot.entities ?? {}).slice(0, 3).map((e) => e?.name).join(","));
    const controller = new AbortController();
    const t = setTimeout(() => { console.log("[probe] OVERALL TIMEOUT 45s"); dumpAndExit(); }, 45_000);
    function dumpAndExit() {
      console.log(`[probe] summary:`, JSON.stringify(seen), "inventoryItems:", bot.inventory?.items?.().length ?? "?");
      process.exit(0);
    }
    try {
      const result = await client.invokeSkillCapability({
        invocationId: "probe-" + randomUUID().slice(0, 8),
        traceId: "probe", taskId: "probe", botId: "probe",
        skillId: "collect.block", skillVersion: "1.0.0", capability: "world.interact", operation: "collect.blocks-safe",
        input: { blockName: "oak_log", maxCount: 1, maxDistance: 16, dimension: "minecraft:overworld", serverProfileId: profile.id },
        authorization: {
          decisionId: "d1", actorId: "probe", sourceInstanceId: "probe", traceId: "probe", taskId: "probe",
          botId: "probe", invocationId: "probe", skillId: "collect.block", skillVersion: "1.0.0",
          issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
          allowedCapabilities: new Set(["world.interact"]),
        },
        signal: controller.signal,
      });
      console.log("[probe] RESULT:", JSON.stringify(result).slice(0, 300));
      clearTimeout(t); setTimeout(dumpAndExit, 300);
    } catch (e) {
      console.log("[probe] FAULT code=", e?.code ?? "?", "msg:", String(e?.message ?? e).slice(0, 250));
      clearTimeout(t); setTimeout(dumpAndExit, 300);
    }
  }, 10_000);
}, 2_000);
process.on("uncaughtException", (e) => { console.log("[probe] UNCAUGHT:", String(e?.message).slice(0, 200)); process.exit(1); });
