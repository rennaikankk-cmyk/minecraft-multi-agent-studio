import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadCpuResourceManagerConfig } from "@minecraft-studio/cpu-resource-manager";
import { createStructuredLogger } from "@minecraft-studio/observability";

import { BotProcessSupervisor } from "../dist/supervisor.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const childEntryPath = path.join(
  repositoryRoot,
  "scripts/fixtures/bot-supervisor-child-harness.mjs",
);

test("真实子进程完成认证、分组启动和优雅停止", async () => {
  const records = [];
  const supervisor = await BotProcessSupervisor.create({
    config: supervisorConfig([
      bot("production-bot-01", "/tmp/unused-profile-01", "production"),
      bot("production-bot-02", "/tmp/unused-profile-02", "production"),
    ]),
    logger: logger(records),
    childEntryPath,
    random: () => 0.5,
  });

  await supervisor.start();
  const running = supervisor.snapshot();
  assert.equal(running.groups.length, 1);
  assert.equal(running.groups[0].state, "ready");
  assert.equal(running.groups[0].botIds.length, 2);
  assert.ok(Number.isInteger(running.groups[0].pid));
  assert.equal(running.cpu.workloads.length, 1);

  await supervisor.stop("node_acceptance_complete");
  const stopped = supervisor.snapshot();
  assert.equal(stopped.started, false);
  assert.equal(stopped.groups[0].pid, null);
  assert.equal(stopped.cpu.workloads.length, 0);
  assert.ok(records.some((record) => record.event === "bot_supervisor_group_ready"));
});

test("真实子进程首次崩溃后按预算退避并恢复", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "bot-supervisor-restart-"),
  );
  const markerPath = path.join(temporaryDirectory, "crashed-once.marker");
  const records = [];
  const supervisor = await BotProcessSupervisor.create({
    config: supervisorConfig([
      bot("crash-once-bot-01", markerPath, "production"),
    ]),
    logger: logger(records),
    childEntryPath,
    random: () => 0.5,
  });

  try {
    await supervisor.start();
    const recovered = supervisor.snapshot();
    assert.equal(recovered.groups[0].state, "ready");
    assert.equal(recovered.groups[0].restartAttempt, 1);
    assert.ok(
      records.some(
        (record) => record.event === "bot_supervisor_restart_scheduled",
      ),
    );
  } finally {
    await supervisor.stop("node_acceptance_complete");
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function supervisorConfig(bots) {
  return {
    schemaVersion: "1.0",
    sourcePath: "/tmp/node-acceptance-supervisor.json",
    profileRoot: "/tmp",
    process: { mode: "process", botsPerProcess: 2, autoSize: false },
    restart: {
      maxAttempts: 3,
      windowMs: 10_000,
      baseDelayMs: 100,
      maxDelayMs: 500,
      stableAfterMs: 2_000,
    },
    ipc: {
      handshakeTimeoutMs: 2_000,
      sendTimeoutMs: 2_000,
      gracefulShutdownMs: 3_000,
      maxQueuedMessages: 8,
      maxQueuedBytes: 64 * 1_024,
    },
    bots,
    cpuResourceManager: loadCpuResourceManagerConfig({}).config,
    warnings: [],
  };
}

function bot(botId, profilePath, deploymentTier) {
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
      username: "NodeTestBot",
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
      profilePath,
      profileSha256: "a".repeat(64),
      deploymentTier,
      runtimeLink: {
        url: "ws://127.0.0.1:3220/v1/runtime-link",
        keyId: `key-${botId}`,
        secret: "s".repeat(32),
      },
    },
  };
}

function logger(records) {
  return createStructuredLogger({
    service: "bot-supervisor-test",
    instanceId: "bot-supervisor-test-01",
    sink: (record) => records.push(record),
  });
}
