import { describe, expect, it, vi } from "vitest";

import {
  BotState,
  CPUResourceManager,
  CpuPriority,
  DeploymentTier,
  HardwareProfiler,
  LinuxTasksetAffinityAdapter,
  ProcStatCpuMonitor,
  ResourceScheduler,
  createCpuPools,
  defaultCpuResourceManagerConfig,
  detectCpuTopology,
  formatCpuList,
  loadCpuResourceManagerConfig,
  parseCpuList,
  type CpuDetectionOptions,
  type CpuResourceEvent,
} from "../src/index.js";

const NOW = new Date("2026-08-17T12:00:00.000Z");

function hybridFixture(unknownCpuId: number | null = null): CpuDetectionOptions {
  const files = new Map<string, string>([
    ["/sys/devices/system/cpu/online", "0-3\n"],
    ["/proc/self/status", "Name:\tnode\nCpus_allowed_list:\t0-3\n"],
    [
      "/proc/cpuinfo",
      "vendor_id : GenuineIntel\nmodel name : Fixture Hybrid CPU\n",
    ],
  ]);
  for (let id = 0; id < 4; id += 1) {
    files.set(
      `/sys/devices/system/cpu/cpu${id}/topology/physical_package_id`,
      "0\n",
    );
    files.set(`/sys/devices/system/cpu/cpu${id}/topology/die_id`, "0\n");
    files.set(`/sys/devices/system/cpu/cpu${id}/topology/core_id`, `${id}\n`);
  }

  return {
    platform: "linux",
    architecture: "x64",
    cpuInfo: Array.from({ length: 4 }, () => ({ model: "Fixture CPU" })),
    availableParallelism: () => 4,
    now: () => NOW,
    readTextFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("fixture_file_missing");
      return value;
    },
    readDirectory: async () => ["node0"],
    readCpuid: async (cpuId, leaf) =>
      leaf === 0
        ? {
            eax: 0x1a,
            ebx: 0x756e6547,
            ecx: 0x6c65746e,
            edx: 0x49656e69,
          }
        : {
            eax:
              cpuId === unknownCpuId
                ? 0
                : (cpuId < 2 ? 0x40 : 0x20) << 24,
            ebx: 0,
            ecx: 0,
            edx: 0,
          },
  };
}

function enabledConfig() {
  return {
    ...defaultCpuResourceManagerConfig,
    enabled: true,
    mode: "manual" as const,
    manual: { performanceCpuIds: [0, 1], efficiencyCpuIds: [2, 3] },
    affinity: { enabled: true },
    scheduler: { enabled: true, intervalMs: 2_000 },
  };
}

describe("CPU topology", () => {
  it("round-trips sparse Linux CPU lists", () => {
    expect(parseCpuList("0-2,5,8-9")).toEqual([0, 1, 2, 5, 8, 9]);
    expect(formatCpuList([9, 0, 8, 2, 1, 5])).toBe("0-2,5,8-9");
    expect(() => parseCpuList("3-1")).toThrow();
  });

  it("uses Intel CPUID leaf 0x1A only when every allowed CPU is known", async () => {
    const exact = await detectCpuTopology(hybridFixture());
    const unknown = await detectCpuTopology(hybridFixture(3));

    expect(exact.hybridCpuDetected).toBe(true);
    expect(exact.classification).toMatchObject({
      source: "linux-cpuid-leaf-0x1a",
      reliability: "exact",
    });
    expect(createCpuPools(exact).backgroundPool.cpuIds).toEqual([2, 3]);
    expect(unknown.hybridCpuDetected).toBe(false);
    expect(unknown.classification.reliability).toBe("none");
    expect(createCpuPools(unknown).backgroundPool.cpuIds).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("does not claim P/E types on an unsupported platform", async () => {
    const topology = await detectCpuTopology({
      platform: "win32",
      architecture: "x64",
      cpuInfo: [{ model: "AMD or legacy Intel" }],
      availableParallelism: () => 1,
      now: () => NOW,
      readTextFile: async () => {
        throw new Error("not available");
      },
    });

    expect(topology.hybridCpuDetected).toBe(false);
    expect(topology.classification.source).toBe("generic");
    expect(topology.affinitySafe).toBe(false);
  });

  it("refuses affinity when the process cpuset boundary is unavailable", async () => {
    const base = hybridFixture();
    const topology = await detectCpuTopology({
      ...base,
      readTextFile: async (path) => {
        if (path === "/proc/self/status") throw new Error("denied");
        return base.readTextFile!(path);
      },
    });

    expect(topology.affinitySafe).toBe(false);
    expect(topology.hybridCpuDetected).toBe(false);
    expect(createCpuPools(topology).performancePool.cpuIds).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("keeps AMD and capacity-only Intel systems in overlapping generic pools", async () => {
    const base = hybridFixture();
    const capacityRead = async (path: string) => {
      if (path === "/proc/cpuinfo") {
        return "vendor_id : GenuineIntel\nmodel name : Capacity Fixture\n";
      }
      const capacity = path.match(/cpu([0-9]+)\/cpu_capacity$/u);
      if (capacity?.[1]) return Number(capacity[1]) < 2 ? "1024\n" : "512\n";
      return base.readTextFile!(path);
    };
    const capacityOnly = await detectCpuTopology({
      ...base,
      readTextFile: capacityRead,
      readCpuid: async () => {
        throw new Error("cpuid unavailable in VM");
      },
    });
    const amd = await detectCpuTopology({
      ...base,
      readTextFile: async (path) =>
        path === "/proc/cpuinfo"
          ? "vendor_id : AuthenticAMD\nmodel name : AMD Fixture\n"
          : capacityRead(path),
      readCpuid: async () => {
        throw new Error("not Intel");
      },
    });

    expect(capacityOnly.classification.reliability).toBe("capacity");
    expect(capacityOnly.hybridCpuDetected).toBe(false);
    expect(createCpuPools(capacityOnly).performancePool.cpuIds).toEqual([
      0, 1, 2, 3,
    ]);
    expect(createCpuPools(capacityOnly).backgroundPool.cpuIds).toEqual([
      0, 1, 2, 3,
    ]);
    expect(amd.classification).toMatchObject({
      source: "generic",
      reliability: "none",
    });
  });

  it("ARM64 异构容量信息不被猜测为 Intel P/E 核", async () => {
    const base = hybridFixture();
    const topology = await detectCpuTopology({
      ...base,
      architecture: "arm64",
      readTextFile: async (path) => {
        if (path === "/proc/cpuinfo") {
          return "model name : ARM64 双簇测试 CPU\n";
        }
        const capacity = path.match(/cpu([0-9]+)\/cpu_capacity$/u);
        if (capacity?.[1]) {
          return Number(capacity[1]) < 2 ? "1024\n" : "768\n";
        }
        return base.readTextFile!(path);
      },
      readCpuid: async () => {
        throw new Error("ARM64 不提供 Intel CPUID 叶");
      },
    });
    const pools = createCpuPools(topology);

    expect(topology.architecture).toBe("arm64");
    expect(topology.heterogeneousCapacityDetected).toBe(true);
    expect(topology.hybridCpuDetected).toBe(false);
    expect(topology.classification).toMatchObject({
      source: "generic",
      reliability: "none",
      reason: "non_intel_without_exact_core_types",
    });
    expect(pools.performancePool.cpuIds).toEqual([0, 1, 2, 3]);
    expect(pools.backgroundPool.cpuIds).toEqual([0, 1, 2, 3]);
  });
});

describe("configuration and scheduling", () => {
  it("ships disabled and keeps the scheduler off when its parent is off", () => {
    expect(loadCpuResourceManagerConfig({}).config.enabled).toBe(false);
    const result = loadCpuResourceManagerConfig({
      CPU_RESOURCE_MANAGER_ENABLED: "false",
      CPU_SCHEDULER_ENABLED: "true",
    });
    expect(result.config.scheduler.enabled).toBe(false);
    expect(result.warnings).toContain("cpu_scheduler_requires_resource_manager");
  });

  it("accepts validated state-priority overrides", () => {
    const result = loadCpuResourceManagerConfig({
      CPU_PRIORITY_COMBAT: "critical",
      CPU_PRIORITY_IDLE: "not-a-priority",
    });
    expect(result.config.priorities[BotState.COMBAT]).toBe(
      CpuPriority.CRITICAL,
    );
    expect(result.config.priorities[BotState.IDLE]).toBe(
      CpuPriority.BACKGROUND,
    );
    expect(result.warnings).toContain("cpu_priority_idle_invalid");
  });

  it("promotes escape and preempts test work for a production Bot", async () => {
    let nowMs = NOW.getTime();
    const topology = await detectCpuTopology({
      ...hybridFixture(),
      mode: "manual",
      manual: { performanceCpuIds: [0, 1], efficiencyCpuIds: [2, 3] },
    });
    const scheduler = new ResourceScheduler({
      pools: createCpuPools(topology),
      config: enabledConfig(),
      now: () => nowMs,
    });
    scheduler.register({
      id: "prod",
      pid: 1_001,
      kind: "minecraft-bot",
      deploymentTier: DeploymentTier.PRODUCTION,
      state: BotState.IDLE,
    });
    scheduler.register({
      id: "tests",
      pid: 1_002,
      kind: "skill-test",
      deploymentTier: DeploymentTier.TEST,
      priority: CpuPriority.HIGH,
    });
    scheduler.updateBotState("prod", BotState.ESCAPE);
    nowMs += 31_000;

    expect(scheduler.get("prod")?.priority).toBe(CpuPriority.CRITICAL);
    expect(scheduler.planRebalance()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workloadId: "tests",
          targetPool: "backgroundPool",
          reason: "production_realtime_preemption",
        }),
      ]),
    );
  });

  it("holds a demotion through cooldown and minimum residency", async () => {
    let nowMs = NOW.getTime();
    const topology = await detectCpuTopology({
      ...hybridFixture(),
      mode: "manual",
      manual: { performanceCpuIds: [0, 1], efficiencyCpuIds: [2, 3] },
    });
    const scheduler = new ResourceScheduler({
      pools: createCpuPools(topology),
      config: enabledConfig(),
      now: () => nowMs,
    });
    scheduler.register({
      id: "bot",
      pid: 1_001,
      kind: "minecraft-bot",
      deploymentTier: DeploymentTier.PRODUCTION,
      state: BotState.IDLE,
    });
    scheduler.updateBotState("bot", BotState.ESCAPE);
    const promotion = scheduler.planRebalance()[0]!;
    scheduler.commitMigration(promotion, true);
    scheduler.updateBotState("bot", BotState.IDLE);

    nowMs += 29_000;
    expect(scheduler.planRebalance()).toEqual([]);
    nowMs += 2_000;
    expect(scheduler.planRebalance()).toEqual([
      expect.objectContaining({
        workloadId: "bot",
        previousPool: "realtimePool",
        targetPool: "backgroundPool",
      }),
    ]);
  });

  it("never lets latency promotion demote CRITICAL work", async () => {
    const topology = await detectCpuTopology({
      ...hybridFixture(),
      mode: "manual",
      manual: { performanceCpuIds: [0, 1], efficiencyCpuIds: [2, 3] },
    });
    const scheduler = new ResourceScheduler({
      pools: createCpuPools(topology),
      config: enabledConfig(),
      now: () => NOW.getTime(),
    });
    scheduler.register({
      id: "escape",
      pid: 1_001,
      kind: "minecraft-bot",
      deploymentTier: DeploymentTier.PRODUCTION,
      state: BotState.IDLE,
    });
    scheduler.updateBotState("escape", BotState.ESCAPE);
    scheduler.updateMetrics("escape", { eventLoopLagMs: 100 });

    expect(scheduler.planRebalance()[0]).toMatchObject({
      targetPool: "realtimePool",
      priority: CpuPriority.CRITICAL,
    });
  });
});

describe("monitoring and hardware profiling", () => {
  it("computes CPU utilization from consecutive /proc/stat samples", async () => {
    const samples = [
      "cpu 100 0 100 800 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0\n",
      "cpu 150 0 150 900 0 0 0 0\ncpu0 75 0 75 450 0 0 0 0\n",
    ];
    const monitor = new ProcStatCpuMonitor({
      now: () => NOW,
      readTextFile: async () => samples.shift()!,
      loadAverage: () => [1, 0.5, 0.25],
    });

    expect((await monitor.sample()).totalUsagePercent).toBeNull();
    const second = await monitor.sample();
    expect(second.totalUsagePercent).toBe(50);
    expect(second.perCpuUsagePercent[0]).toBe(50);
    expect(second.loadAverage).toEqual([1, 0.5, 0.25]);
  });

  it("collects CPU, RAM, disk, GPU and network facts without model tables", async () => {
    const profile = await new HardwareProfiler({
      cpuDetection: hybridFixture(),
      platform: "linux",
      now: () => NOW,
      desiredBots: 10,
      memoryReader: () => ({ totalBytes: 16_000, freeBytes: 8_000 }),
      diskReader: async () => ({
        blockSize: 1_000,
        blocks: 100,
        availableBlocks: 40,
      }),
      networkReader: () => ({
        eth0: [
          {
            address: "192.0.2.10",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:5e:00:53:01",
            internal: false,
            cidr: "192.0.2.10/24",
          },
        ],
      }),
      commandRunner: async () => ({
        stdout:
          '00:02.0 "VGA compatible controller" "Example Vendor" "Example Adapter"',
        stderr: "",
      }),
    }).detect();

    expect(profile.memory).toEqual({ totalBytes: 16_000, freeBytes: 8_000 });
    expect(profile.disk).toMatchObject({
      status: "available",
      totalBytes: 100_000,
      freeBytes: 40_000,
    });
    expect(profile.gpu).toMatchObject({
      status: "detected",
      devices: [{ name: "Example Adapter" }],
    });
    expect(profile.network.activeInterfaceCount).toBe(1);
  });
});

describe("affinity failure isolation", () => {
  it("calls taskset through fixed argv", async () => {
    const runner = vi.fn(async () => undefined);
    const adapter = new LinuxTasksetAffinityAdapter({
      platform: "linux",
      commandRunner: runner,
    });

    await expect(adapter.apply(42, [3, 2, 1, 0])).resolves.toMatchObject({
      applied: true,
    });
    expect(runner).toHaveBeenCalledWith("taskset", [
      "--all-tasks",
      "--pid",
      "--cpu-list",
      "0-3",
      "42",
    ]);
  });

  it("records failure without rejecting Bot registration", async () => {
    const events: CpuResourceEvent[] = [];
    const manager = await CPUResourceManager.create({
      config: enabledConfig(),
      detection: hybridFixture(),
      affinityAdapter: {
        apply: async (pid, cpuIds) => ({
          applied: false,
          pid,
          cpuIds,
          source: "noop" as const,
          errorCode: "AFFINITY_PERMISSION_DENIED" as const,
        }),
      },
      eventSink: (event) => events.push(event),
      pidAuthorizer: () => true,
      now: () => NOW,
    });

    await expect(
      manager.assignProcess({
        id: "bot-7",
        pid: 7_007,
        kind: "minecraft-bot",
        deploymentTier: DeploymentTier.PRODUCTION,
        state: BotState.COMBAT,
      }),
    ).resolves.toMatchObject({ affinityApplied: false });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["CPU_AFFINITY_FAILURE", "CPU_ASSIGN"]),
    );
  });

  it("rejects a PID that the host supervisor did not authorize", async () => {
    const manager = await CPUResourceManager.create({
      detection: hybridFixture(),
      now: () => NOW,
    });
    await expect(
      manager.assignProcess({
        id: "untrusted",
        pid: process.pid + 100_000,
        kind: "generic",
        deploymentTier: DeploymentTier.BATCH,
      }),
    ).rejects.toThrow("not authorized");
  });
});
