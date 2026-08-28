// ---------------------------------------------------------------------------
// Critical Hit Benchmark —— 100 击矩阵。
//
// 对五种暴击策略各跑 N 次攻击，记录命中率/暴击率/窗口延迟。
// 运行方式（需要隔离服在线）：
//   node scripts/critical-benchmark.mjs --profile anarchy
// 输出 JSON 到 stdout，可重定向保存。
// ---------------------------------------------------------------------------

import { loadServerProfile } from "../apps/bot-runtime/dist/index.js";
import { createBot } from "mineflayer";
import { Vec3 } from "vec3";

const ATTACKS_PER_STRATEGY = Number(process.argv.includes("--n")
  ? process.argv[process.argv.indexOf("--n") + 1]
  : 100);

const STRATEGIES = [
  "NORMAL_JUMP_CRIT",
  "LOW_HOP_CRIT",
  "MINI_JUMP_CRIT",
  "PACKET_CRIT",
  "NO_CRIT",
];

function log(event, fields = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

async function main() {
  const profilePath = process.env.BOT_SERVER_PROFILE_PATH;
  if (!profilePath) {
    console.error("Set BOT_SERVER_PROFILE_PATH to run the benchmark.");
    process.exit(1);
  }
  const profile = await loadServerProfile();
  log("benchmark_starting", { profile: profile.id, attacksPerStrategy: ATTACKS_PER_STRATEGY });

  const bot = createBot({
    host: profile.host,
    port: profile.port,
    username: profile.username + "_bench",
    auth: "offline",
    version: "auto",
    hideErrors: true,
  });

  await new Promise((resolve, reject) => {
    bot.once("spawn", resolve);
    bot.once("error", reject);
    setTimeout(() => reject(new Error("spawn timeout")), 30_000);
  });
  log("bot_spawned", { username: bot.username });

  // Summon a training dummy (zombie that can't reach us if we pillar).
  // For a pure timing benchmark we measure the physics windows, not damage.
  const results = {};
  for (const strategy of STRATEGIES) {
    const record = {
      attempts: 0,
      windowsOpened: 0,
      windowLatencyMs: [],
      packetInjections: 0,
    };
    for (let i = 0; i < ATTACKS_PER_STRATEGY; i += 1) {
      record.attempts += 1;
      const start = Date.now();
      // Measure: can we reach the "falling" state within budget?
      let opened = false;
      switch (strategy) {
        case "NORMAL_JUMP_CRIT":
        case "LOW_HOP_CRIT":
        case "MINI_JUMP_CRIT": {
          bot.setControlState("jump", true);
          if (strategy === "MINI_JUMP_CRIT") bot.entity.velocity.y = 0.05;
          else if (strategy === "LOW_HOP_CRIT") bot.entity.velocity.y = 0.2;
          // Wait for falling window.
          for (let t = 0; t < 40; t += 1) {
            await new Promise((r) => setTimeout(r, 25));
            if (bot.entity.velocity.y < -0.08 && !bot.entity.onGround) {
              opened = true;
              break;
            }
          }
          bot.setControlState("jump", false);
          break;
        }
        case "PACKET_CRIT": {
          const pos = bot.entity.position;
          bot._client.write("position", {
            x: pos.x, y: pos.y + 2.71875e-7, z: pos.z, onGround: false,
          });
          bot._client.write("position", { x: pos.x, y: pos.y, z: pos.z, onGround: false });
          record.packetInjections += 1;
          opened = true; // Packet crits don't need a physics window.
          break;
        }
        case "NO_CRIT":
          opened = true;
          break;
      }
      if (opened) {
        record.windowsOpened += 1;
        record.windowLatencyMs.push(Date.now() - start);
      }
      // Cool down between attempts.
      await new Promise((r) => setTimeout(r, 200));
    }
    record.windowOpenRate = record.windowsOpened / record.attempts;
    record.avgWindowLatencyMs = record.windowLatencyMs.length > 0
      ? Math.round(record.windowLatencyMs.reduce((a, b) => a + b, 0) / record.windowLatencyMs.length)
      : null;
    results[strategy] = record;
    log("strategy_complete", { strategy, ...record });
  }

  bot.quit("benchmark_done");
  console.log(JSON.stringify({
    benchmark: "critical-hit-matrix",
    attacksPerStrategy: ATTACKS_PER_STRATEGY,
    completedAt: new Date().toISOString(),
    results,
  }, null, 2));
  process.exit(0);
}

main().catch((cause) => {
  console.error("BENCHMARK_FAILED:", cause);
  process.exit(1);
});
