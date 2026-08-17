import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCpuResourceManagerConfig } from "../packages/cpu-resource-manager/dist/index.js";
import { createStructuredLogger } from "../packages/observability/dist/index.js";
import { BotProcessSupervisor } from "../apps/bot-runtime/dist/supervisor.js";

const BOT_COUNTS = [1, 5, 10, 20];
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const childEntryPath = path.join(
  repositoryRoot,
  "scripts/fixtures/bot-supervisor-child-harness.mjs",
);
const results = [];

for (const botCount of BOT_COUNTS) {
  const off = await measureDirectLifecycle(botCount);
  const on = await measureSupervisorLifecycle(botCount);
  results.push({
    botCount,
    botsPerProcess: 2,
    supervisorOff: off,
    supervisorOn: on,
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: "1.0",
      benchmarkType: "synthetic-bot-process-supervisor-lifecycle",
      warning:
        "该结果只测量空 Host 的进程启动、认证 IPC、分组和停止开销，不测量 Mineflayer、Minecraft TPS 或 P/E Core 收益。",
      realMinecraftBenchmarkRequired: true,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      results,
      unmeasuredMetrics: [
        "minecraftConnectionLatency",
        "botTickLatency",
        "pathfinderLatency",
        "pCoreUtilization",
        "eCoreUtilization",
        "tpsPerception",
      ],
    },
    null,
    2,
  )}\n`,
);

async function measureDirectLifecycle(botCount) {
  const cpuStart = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  const hosts = Array.from({ length: botCount }, () => ({
    async start() {},
    async stop() {},
  }));
  await Promise.all(hosts.map((host) => host.start()));
  const startupMs = performance.now() - startedAt;
  const eventLoopTurnMs = await eventLoopTurn();
  const stopStartedAt = performance.now();
  await Promise.all(hosts.map((host) => host.stop()));
  const shutdownMs = performance.now() - stopStartedAt;
  const cpu = process.cpuUsage(cpuStart);
  return {
    mode: "direct-empty-host",
    processCount: 1,
    startupMs: round(startupMs),
    shutdownMs: round(shutdownMs),
    eventLoopTurnMs: round(eventLoopTurnMs),
    cpuMicros: cpu.user + cpu.system,
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
    crashes: 0,
    timeouts: 0,
  };
}

async function measureSupervisorLifecycle(botCount) {
  const records = [];
  const cpuStart = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const supervisor = await BotProcessSupervisor.create({
    config: supervisorConfig(botCount),
    childEntryPath,
    logger: createStructuredLogger({
      service: "bot-supervisor-benchmark",
      instanceId: `bot-supervisor-benchmark-${botCount}`,
      sink: (record) => records.push(record),
    }),
    random: () => 0.5,
  });
  const startedAt = performance.now();
  await supervisor.start();
  const startupMs = performance.now() - startedAt;
  const running = supervisor.snapshot();
  const eventLoopTurnMs = await eventLoopTurn();
  const stopStartedAt = performance.now();
  await supervisor.stop("benchmark_complete");
  const shutdownMs = performance.now() - stopStartedAt;
  const cpu = process.cpuUsage(cpuStart);
  return {
    mode: "authenticated-child-processes",
    processCount: running.groups.length + 1,
    childProcessCount: running.groups.length,
    startupMs: round(startupMs),
    shutdownMs: round(shutdownMs),
    eventLoopTurnMs: round(eventLoopTurnMs),
    cpuMicros: cpu.user + cpu.system,
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
    crashes: records.filter(
      (record) => record.event === "bot_supervisor_child_exited",
    ).length,
    timeouts: records.filter((record) =>
      record.event.includes("timeout"),
    ).length,
  };
}

function supervisorConfig(botCount) {
  return {
    schemaVersion: "1.0",
    sourcePath: "/tmp/benchmark-supervisor.json",
    profileRoot: "/tmp",
    process: { mode: "process", botsPerProcess: 2, autoSize: false },
    restart: {
      maxAttempts: 1,
      windowMs: 10_000,
      baseDelayMs: 100,
      maxDelayMs: 100,
      stableAfterMs: 2_000,
    },
    ipc: {
      handshakeTimeoutMs: 3_000,
      sendTimeoutMs: 2_000,
      gracefulShutdownMs: 3_000,
      maxQueuedMessages: 16,
      maxQueuedBytes: 128 * 1_024,
    },
    bots: Array.from({ length: botCount }, (_, index) =>
      bot(`benchmark-bot-${String(index + 1).padStart(2, "0")}`),
    ),
    cpuResourceManager: loadCpuResourceManagerConfig({}).config,
    warnings: [],
  };
}

function bot(botId) {
  return {
    profile: {
      schemaVersion: "1.0",
      id: `profile-${botId}`,
      botId,
      purpose: "isolated-test",
      networkScope: "loopback",
      host: "127.0.0.1",
      port: 25_565,
      minecraftVersion: "1.21.8",
      username: "BenchmarkBot",
      auth: "offline",
      statusIntervalMs: 1_000,
      heartbeatIntervalMs: 5_000,
      stopGracePeriodMs: 1_000,
      reconnect: {
        enabled: false,
        maxAttempts: 0,
        baseDelayMs: 500,
        maxDelayMs: 1_000,
      },
    },
    assignment: {
      botId,
      profilePath: `/tmp/${botId}.json`,
      profileSha256: "a".repeat(64),
      deploymentTier: "production",
      runtimeLink: {
        url: "ws://127.0.0.1:3220/v1/runtime-link",
        keyId: `key-${botId}`,
        secret: "s".repeat(32),
      },
    },
  };
}

function eventLoopTurn() {
  const startedAt = performance.now();
  return new Promise((resolve) =>
    setImmediate(() => resolve(performance.now() - startedAt)),
  );
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
