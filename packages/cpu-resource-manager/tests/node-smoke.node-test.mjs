import assert from "node:assert/strict";
import test from "node:test";

import {
  BotState,
  CPUResourceManager,
  CpuPriority,
  DeploymentTier,
  LinuxTasksetAffinityAdapter,
  ResourceScheduler,
  createCpuPools,
  createHardwareProfile,
  defaultCpuResourceManagerConfig,
  detectCpuTopology,
  formatCpuList,
  loadCpuResourceManagerConfig,
  parseCpuList,
} from "../dist/index.js";

const FIXED_NOW = new Date("2026-08-17T12:00:00.000Z");

function intelHybridFixture({ unknownCpuId = null } = {}) {
  const files = new Map([
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
    now: () => FIXED_NOW,
    readTextFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    readDirectory: async () => ["node0"],
    readCpuid: async (cpuId, leaf) => {
      if (leaf === 0) {
        return {
          eax: 0x1a,
          ebx: 0x756e6547,
          ecx: 0x6c65746e,
          edx: 0x49656e69,
        };
      }
      return {
        eax:
          cpuId === unknownCpuId
            ? 0
            : (cpuId < 2 ? 0x40 : 0x20) << 24,
        ebx: 0,
        ecx: 0,
        edx: 0,
      };
    },
  };
}

function enabledConfig(overrides = {}) {
  return {
    ...defaultCpuResourceManagerConfig,
    enabled: true,
    mode: "manual",
    manual: { performanceCpuIds: [0, 1], efficiencyCpuIds: [2, 3] },
    affinity: { enabled: true },
    scheduler: { enabled: true, intervalMs: 2_000 },
    rebalance: {
      cooldownMs: 10_000,
      minimumResidencyMs: 30_000,
      demotionDelayMs: 30_000,
    },
    ...overrides,
  };
}

test("CPU-list parser round-trips sparse affinity sets", () => {
  const parsed = parseCpuList("0-2,5,8-9");
  assert.deepEqual(parsed, [0, 1, 2, 5, 8, 9]);
  assert.equal(formatCpuList(parsed), "0-2,5,8-9");
  assert.throws(() => parseCpuList("3-1"));
});

test("exact Intel CPUID classification creates disjoint pools", async () => {
  const topology = await detectCpuTopology(intelHybridFixture());
  const pools = createCpuPools(topology);

  assert.equal(topology.hybridCpuDetected, true);
  assert.equal(topology.classification.reliability, "exact");
  assert.deepEqual(pools.performancePool.cpuIds, [0, 1]);
  assert.deepEqual(pools.backgroundPool.cpuIds, [2, 3]);
  assert.deepEqual(pools.systemPool.cpuIds, [0, 1, 2, 3]);
});

test("one unknown core type discards the full P/E guess", async () => {
  const topology = await detectCpuTopology(
    intelHybridFixture({ unknownCpuId: 3 }),
  );
  const pools = createCpuPools(topology);

  assert.equal(topology.hybridCpuDetected, false);
  assert.equal(topology.classification.reliability, "none");
  assert.deepEqual(pools.performancePool.cpuIds, [0, 1, 2, 3]);
  assert.deepEqual(pools.backgroundPool.cpuIds, [0, 1, 2, 3]);
});

test("non-Linux platforms remain available in generic fallback mode", async () => {
  const topology = await detectCpuTopology({
    platform: "win32",
    architecture: "x64",
    cpuInfo: [{ model: "Generic CPU" }, { model: "Generic CPU" }],
    availableParallelism: () => 2,
    now: () => FIXED_NOW,
    readTextFile: async () => {
      throw new Error("not available");
    },
  });

  assert.equal(topology.hybridCpuDetected, false);
  assert.equal(topology.classification.source, "generic");
  assert.equal(topology.affinitySafe, false);
  assert.equal(createCpuPools(topology).backgroundPool.cpuIds.length, 2);
});

test("invalid manual CPU sets fail closed to generic pools", async () => {
  const topology = await detectCpuTopology({
    ...intelHybridFixture(),
    mode: "manual",
    manual: { performanceCpuIds: [0, 1], efficiencyCpuIds: [1, 3] },
  });

  assert.equal(topology.hybridCpuDetected, false);
  assert.equal(topology.classification.reason, "manual_configuration_invalid");
  assert.ok(topology.warnings.includes("manual_cpu_classification_invalid"));
});

test("configuration is disabled by default and rejects unsafe values", () => {
  assert.equal(loadCpuResourceManagerConfig({}).config.enabled, false);
  const loaded = loadCpuResourceManagerConfig({
    CPU_RESOURCE_MANAGER_ENABLED: "true",
    CPU_SCHEDULER_ENABLED: "true",
    CPU_SCHEDULER_INTERVAL_MS: "100",
    BOT_RUNTIME_BOTS_PER_PROCESS: "20",
  });

  assert.equal(loaded.config.scheduler.intervalMs, 2_000);
  assert.equal(loaded.config.botRuntime.botsPerProcess, 2);
  assert.ok(loaded.warnings.length >= 2);
});

test("Bot state drives priority and production critical work reclaims tests", () => {
  let nowMs = FIXED_NOW.getTime();
  const topologyPromise = detectCpuTopology({
    ...intelHybridFixture(),
    mode: "manual",
    manual: { performanceCpuIds: [0, 1], efficiencyCpuIds: [2, 3] },
  });
  return topologyPromise.then((topology) => {
    const scheduler = new ResourceScheduler({
      pools: createCpuPools(topology),
      config: enabledConfig(),
      now: () => nowMs,
    });
    scheduler.register({
      id: "bot-prod",
      pid: 1001,
      kind: "minecraft-bot",
      deploymentTier: DeploymentTier.PRODUCTION,
      state: BotState.IDLE,
    });
    scheduler.register({
      id: "tests",
      pid: 1002,
      kind: "skill-test",
      deploymentTier: DeploymentTier.TEST,
      priority: CpuPriority.HIGH,
    });
    scheduler.updateBotState("bot-prod", BotState.ESCAPE);
    nowMs += 31_000;
    const decisions = scheduler.planRebalance();

    assert.equal(scheduler.get("bot-prod").priority, CpuPriority.CRITICAL);
    assert.ok(
      decisions.some(
        (decision) =>
          decision.workloadId === "tests" &&
          decision.targetPool === "backgroundPool" &&
          decision.reason === "production_realtime_preemption",
      ),
    );
  });
});

test("affinity command uses fixed argv and never invokes a shell", async () => {
  let invocation = null;
  const adapter = new LinuxTasksetAffinityAdapter({
    platform: "linux",
    commandRunner: async (executable, args) => {
      invocation = { executable, args: [...args] };
    },
  });
  const result = await adapter.apply(42, [3, 2, 1, 0]);

  assert.equal(result.applied, true);
  assert.deepEqual(invocation, {
    executable: "taskset",
    args: ["--all-tasks", "--pid", "--cpu-list", "0-3", "42"],
  });
});

test("manager logs affinity failure and continues", async () => {
  const events = [];
  const manager = await CPUResourceManager.create({
    config: enabledConfig({ scheduler: { enabled: false, intervalMs: 2_000 } }),
    detection: intelHybridFixture(),
    affinityAdapter: {
      apply: async (pid, cpuIds) => ({
        applied: false,
        pid,
        cpuIds,
        source: "noop",
        errorCode: "AFFINITY_PERMISSION_DENIED",
      }),
    },
    eventSink: (event) => events.push(event),
    pidAuthorizer: () => true,
    now: () => FIXED_NOW,
  });

  const workload = await manager.assignProcess({
    id: "bot-7",
    pid: 7007,
    kind: "minecraft-bot",
    deploymentTier: DeploymentTier.PRODUCTION,
    state: BotState.COMBAT,
  });

  assert.equal(workload.affinityApplied, false);
  assert.ok(events.some((event) => event.type === "CPU_AFFINITY_FAILURE"));
  assert.ok(events.some((event) => event.type === "CPU_ASSIGN"));
});

test("hardware recommendations scale down 4-core machines", async () => {
  const topology = await detectCpuTopology({
    platform: "win32",
    architecture: "x64",
    cpuInfo: Array.from({ length: 4 }, () => ({ model: "4C4T" })),
    availableParallelism: () => 4,
    now: () => FIXED_NOW,
    readTextFile: async () => {
      throw new Error("not available");
    },
  });
  const profile = createHardwareProfile(
    topology,
    {
      memory: { totalBytes: 8_000_000_000, freeBytes: 4_000_000_000 },
      disk: { status: "unavailable", source: "test" },
      gpu: { status: "probe_unavailable", source: "test", devices: [] },
      network: { status: "available", source: "test", activeInterfaceCount: 1 },
    },
    { desiredBots: 10 },
  );

  assert.equal(profile.recommended.botProcesses, 2);
  assert.equal(profile.recommended.pathfinderWorkers, 1);
  assert.equal(profile.recommended.testConcurrency, 1);
  assert.equal(profile.cpu.performanceCores, null);
});
