import type {
  CpuResourceManagerConfig,
  CpuTopology,
} from "@minecraft-studio/cpu-resource-manager";
import { describe, expect, it } from "vitest";

import type { BotSupervisorConfig } from "../src/supervisor-config.js";
import {
  createBotSupervisorPlan,
  RestartBudget,
} from "../src/supervisor-plan.js";

describe("Bot Process Supervisor 计划", () => {
  it("低核心设备采用建议分组且隔离部署等级", () => {
    const plan = createBotSupervisorPlan(supervisorConfig(), genericTopology(4));

    expect(plan.effectiveBotsPerProcess).toBe(3);
    expect(plan.groups.map((group) => group.deploymentTier)).toEqual([
      "production",
      "production",
      "test",
      "batch",
    ]);
    expect(plan.groups[0]?.bots).toHaveLength(3);
    expect(
      plan.groups.every((group) =>
        group.bots.every(
          (bot) => bot.assignment.deploymentTier === group.deploymentTier,
        ),
      ),
    ).toBe(true);
    expect(plan.warnings).toContain("hardware_low_core_count");
    expect(plan.warnings).toContain(
      "planned_processes_exceed_hardware_recommendation",
    );
  });

  it("关闭自动参数时严格采用显式 botsPerProcess", () => {
    const config = supervisorConfig();
    const plan = createBotSupervisorPlan(
      {
        ...config,
        process: { mode: "process", botsPerProcess: 1, autoSize: false },
      },
      genericTopology(20),
    );
    expect(plan.effectiveBotsPerProcess).toBe(1);
    expect(plan.groups).toHaveLength(7);
  });

  it("ARM64 普通核心主机安全回退且不会丢弃 Bot", () => {
    const config = supervisorConfig();
    const plan = createBotSupervisorPlan(config, genericTopology(20, "arm64"));

    expect(plan.effectiveBotsPerProcess).toBe(2);
    expect(plan.recommendation.reasons).toContain(
      "generic_or_unconfirmed_core_types",
    );
    expect(plan.groups.flatMap((group) => group.bots)).toHaveLength(
      config.bots.length,
    );
    expect(plan.warnings).toContain(
      "hardware_generic_or_unconfirmed_core_types",
    );
  });
});

describe("Supervisor 崩溃预算", () => {
  const restart = {
    maxAttempts: 3,
    windowMs: 60_000,
    baseDelayMs: 1_000,
    maxDelayMs: 10_000,
    stableAfterMs: 30_000,
  } as const;

  it("采用带抖动的指数退避并在预算耗尽时停止", () => {
    const budget = new RestartBudget(restart, () => 0.5);
    expect(budget.recordFailure(0, null)).toMatchObject({
      allowed: true,
      attempt: 1,
      delayMs: 1_000,
    });
    expect(budget.recordFailure(1_000, null)).toMatchObject({
      allowed: true,
      attempt: 2,
      delayMs: 2_000,
    });
    expect(budget.recordFailure(2_000, null)).toMatchObject({
      allowed: true,
      attempt: 3,
      delayMs: 4_000,
    });
    expect(budget.recordFailure(3_000, null)).toEqual({
      allowed: false,
      attempt: 3,
      delayMs: null,
      reason: "restart_budget_exhausted",
    });
  });

  it("稳定驻留后重置崩溃窗口", () => {
    const budget = new RestartBudget(restart, () => 0.5);
    budget.recordFailure(0, null);
    budget.recordFailure(1_000, null);
    expect(budget.recordFailure(40_000, 5_000)).toMatchObject({
      allowed: true,
      attempt: 1,
      delayMs: 1_000,
    });
  });
});

function supervisorConfig(): BotSupervisorConfig {
  const tiers = [
    "production",
    "production",
    "production",
    "production",
    "test",
    "test",
    "batch",
  ] as const;
  return {
    schemaVersion: "1.0",
    sourcePath: "/tmp/supervisor.json",
    profileRoot: "/tmp/profiles",
    process: { mode: "process", botsPerProcess: 2, autoSize: true },
    restart: {
      maxAttempts: 3,
      windowMs: 60_000,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      stableAfterMs: 10_000,
    },
    ipc: {
      handshakeTimeoutMs: 1_000,
      sendTimeoutMs: 1_000,
      gracefulShutdownMs: 5_000,
      maxQueuedMessages: 8,
      maxQueuedBytes: 16_384,
    },
    bots: tiers.map((tier, index) => {
      const botId = `bot-${index + 1}`;
      return {
        profile: {
          schemaVersion: "1.0",
          id: `profile-${index + 1}`,
          botId,
          purpose: "isolated-test",
          networkScope: "loopback",
          host: "127.0.0.1",
          port: 25_565,
          minecraftVersion: "1.21.8",
          username: `Bot${String(index + 1).padStart(2, "0")}`,
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
          profilePath: `/tmp/profiles/${botId}.json`,
          profileSha256: "a".repeat(64),
          deploymentTier: tier,
          runtimeLink: {
            url: "ws://127.0.0.1:3220/v1/runtime-link",
            keyId: `key-${index + 1}`,
            secret: "s".repeat(32),
          },
        },
      };
    }),
    cpuResourceManager: {} as CpuResourceManagerConfig,
    warnings: [],
  };
}

function genericTopology(
  cores: number,
  architecture = "x64",
): CpuTopology {
  return {
    schemaVersion: "1.0",
    capturedAt: "2026-08-17T00:00:00.000Z",
    platform: "linux",
    architecture,
    vendor: "Generic",
    model: "测试 CPU",
    logicalCores: cores,
    availableLogicalCores: cores,
    physicalCores: cores,
    availablePhysicalCores: cores,
    numaNodes: [0],
    hybridCpuDetected: false,
    heterogeneousCapacityDetected: false,
    affinitySafe: true,
    classification: {
      source: "generic",
      reliability: "none",
      reason: "测试使用普通核心回退。",
    },
    cpus: Array.from({ length: cores }, (_, id) => ({
      id,
      online: true,
      allowed: true,
      packageId: 0,
      dieId: 0,
      coreId: id,
      numaNodeId: 0,
      capacity: null,
      coreClass: "unknown",
    })),
    warnings: [],
  };
}
