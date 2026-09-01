#!/usr/bin/env node
// 离线 fixture 世界采集能力实证：起 fixture → 探针 bot → 依次试 dirt/oak_log/stone。
import { withE2EFixture } from "./fixture-manager.mjs";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createMineflayerClient } from "../dist/mineflayer-client.js";

await withE2EFixture(async (fixture) => {
  console.log(`[fp] fixture port=${fixture.port}`);
  const profile = {
    id: "probe-fixture", botId: "probe", purpose: "isolated-test", networkScope: "loopback",
    host: "127.0.0.1", port: fixture.port, minecraftVersion: "auto",
    username: "ProbeFix" + Date.now().toString(36).slice(-4), auth: "offline",
    statusIntervalMs: 250, heartbeatIntervalMs: 500, stopGracePeriodMs: 1000,
    reconnect: { enabled: false, maxAttempts: 0, baseDelayMs: 250, maxDelayMs: 500 },
  };
  const client = createMineflayerClient(profile);
  const bot = client.bot;
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 12_000);
    bot?.once?.("login", () => { console.log("[fp] login ok"); clearTimeout(t); setTimeout(resolve, 3_000); });
  });
  console.log("[fp] pos:", JSON.stringify(bot.entity?.position ?? null).slice(0, 60));
  // 附近方块采样
  const counts = {};
  for (const name of ["dirt", "grass_block", "oak_log", "stone", "sand", "oak_leaves"]) {
    try {
      const found = bot.findBlocks({ matching: (b) => b.name === name, maxDistance: 24, count: 64 });
      counts[name] = found.length;
    } catch { counts[name] = "err"; }
  }
  console.log("[fp] nearby blocks (24r):", JSON.stringify(counts));

  for (const blockName of ["dirt", "oak_log"]) {
    if (counts[blockName] === 0) { console.log(`[fp] ${blockName}: none nearby, skip`); continue; }
    try {
      const result = await client.invokeSkillCapability({
        invocationId: "fp-" + randomUUID().slice(0, 8),
        traceId: "fp", taskId: "fp", botId: "probe",
        skillId: "collect.block", skillVersion: "1.0.0",
        capability: "world.interact", operation: "collect.blocks-safe",
        input: { blockName, maxCount: 1, maxDistance: 24, dimension: "minecraft:overworld", serverProfileId: "probe-fixture" },
        authorization: {
          decisionId: "d1", actorId: "probe", sourceInstanceId: "probe", traceId: "fp", taskId: "fp",
          botId: "probe", invocationId: "fp", skillId: "collect.block", skillVersion: "1.0.0",
          issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString(),
          allowedCapabilities: new Set(["world.interact"]),
        },
        signal: new AbortController().signal,
      });
      console.log(`[fp] collect ${blockName}: OK`, JSON.stringify(result).slice(0, 160));
    } catch (e) {
      console.log(`[fp] collect ${blockName}: FAULT code=${e?.code ?? "?"} msg=${String(e?.message ?? e).slice(0, 140)}`);
    }
  }
  process.exit(0);
});
