import { performance } from "node:perf_hooks";

import {
  BotState,
  CpuPriority,
  DeploymentTier,
  ResourceScheduler,
  createCpuPools,
  defaultCpuResourceManagerConfig,
  detectCpuTopology,
} from "../packages/cpu-resource-manager/dist/index.js";

const BOT_COUNTS = [1, 5, 10, 20];
const ITERATIONS = 500;
const SCENARIOS = [
  { id: "idle", state: BotState.IDLE },
  { id: "chat", state: BotState.CHAT },
  { id: "travel", state: BotState.TRAVEL },
  { id: "mining", state: BotState.MINING },
  { id: "ten-bot-pathfinding", state: BotState.PATHFINDING, pathfinderLatencyMs: 300 },
  { id: "building", state: BotState.BUILDING },
  { id: "dense-entities", state: BotState.COMBAT, eventLoopLagMs: 60 },
  { id: "pvp", state: BotState.CRYSTAL_PVP, botTickDelayMs: 60 },
  { id: "automatic-tests-concurrent", state: BotState.TESTING, includeTests: true },
  { id: "database-high-load", state: BotState.TRAVEL, includeDatabase: true, databaseLatencyMs: 100 },
];

const topology = await detectCpuTopology();
const pools = createCpuPools(topology);
const config = {
  ...defaultCpuResourceManagerConfig,
  enabled: true,
  scheduler: { enabled: true, intervalMs: 2_000 },
  rebalance: { cooldownMs: 0, minimumResidencyMs: 0, demotionDelayMs: 0 },
};

const results = [];
for (const botCount of BOT_COUNTS) {
  for (const scenario of SCENARIOS) {
    const off = measureOff(botCount, scenario);
    const on = measureOn(botCount, scenario);
    results.push({
      botCount,
      scenario: scenario.id,
      iterations: ITERATIONS,
      schedulerOffMs: round(off.durationMs),
      schedulerOnMs: round(on.durationMs),
      schedulerOverheadUsPerTick: round(
        ((on.durationMs - off.durationMs) * 1_000) / ITERATIONS,
      ),
      schedulerOffCpuMicros: off.cpuMicros,
      schedulerOnCpuMicros: on.cpuMicros,
      schedulerCpuOverheadMicros: on.cpuMicros - off.cpuMicros,
      decisions: on.decisions,
      heapDeltaBytes: on.heapDeltaBytes,
    });
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: "1.0",
      benchmarkType: "synthetic-resource-scheduler-overhead",
      warning:
        "This does not measure Mineflayer, Minecraft TPS, P/E utilization, database latency, or justify enabling the scheduler by default.",
      realHostBenchmarkRequired: true,
      unmeasuredMetrics: [
        "pCoreUtilization",
        "eCoreUtilization",
        "eventLoopLag",
        "botLatency",
        "pathfinderLatency",
        "tpsPerception",
        "databaseLatency",
        "crashAndTimeoutRate",
      ],
      host: {
        platform: topology.platform,
        architecture: topology.architecture,
        availableLogicalCores: topology.availableLogicalCores,
        hybridCpuDetected: topology.hybridCpuDetected,
        classificationReliability: topology.classification.reliability,
      },
      schedulerEnabledByDefault: defaultCpuResourceManagerConfig.scheduler.enabled,
      results,
    },
    null,
    2,
  )}\n`,
);

function measureOff(botCount, scenario) {
  const workloads = createRegistrations(botCount, scenario);
  let checksum = 0;
  const cpuStarted = process.cpuUsage();
  const started = performance.now();
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    for (const workload of workloads) {
      checksum += workload.pid + iteration + (workload.priority === CpuPriority.HIGH ? 1 : 0);
    }
  }
  const durationMs = performance.now() - started;
  if (checksum < 0) throw new Error("unreachable");
  const cpu = process.cpuUsage(cpuStarted);
  return { durationMs, cpuMicros: cpu.user + cpu.system };
}

function measureOn(botCount, scenario) {
  let nowMs = Date.parse("2026-08-17T12:00:00.000Z");
  const scheduler = new ResourceScheduler({ pools, config, now: () => nowMs });
  const workloads = createRegistrations(botCount, scenario);
  for (const workload of workloads) scheduler.register(workload);
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuStarted = process.cpuUsage();
  let decisions = 0;
  const started = performance.now();
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    nowMs += 2_000;
    for (let index = 0; index < botCount; index += 1) {
      scheduler.updateMetrics(`bot-${index}`, {
        ...(scenario.eventLoopLagMs !== undefined
          ? { eventLoopLagMs: scenario.eventLoopLagMs }
          : {}),
        ...(scenario.botTickDelayMs !== undefined
          ? { botTickDelayMs: scenario.botTickDelayMs }
          : {}),
        ...(scenario.pathfinderLatencyMs !== undefined
          ? { pathfinderLatencyMs: scenario.pathfinderLatencyMs }
          : {}),
      });
    }
    if (scenario.includeDatabase) {
      scheduler.updateMetrics("database", {
        databaseLatencyMs: scenario.databaseLatencyMs,
      });
    }
    const planned = scheduler.planRebalance();
    decisions += planned.length;
    for (const decision of planned) scheduler.commitMigration(decision, false);
  }
  const cpu = process.cpuUsage(cpuStarted);
  return {
    durationMs: performance.now() - started,
    cpuMicros: cpu.user + cpu.system,
    decisions,
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
  };
}

function createRegistrations(botCount, scenario) {
  const registrations = Array.from({ length: botCount }, (_, index) => ({
    id: `bot-${index}`,
    pid: 10_000 + index,
    kind: "minecraft-bot",
    deploymentTier:
      scenario.includeTests && index % 4 === 3
        ? DeploymentTier.TEST
        : DeploymentTier.PRODUCTION,
    state: scenario.state,
  }));
  if (scenario.includeTests) {
    registrations.push({
      id: "skill-tests",
      pid: 20_001,
      kind: "skill-test",
      deploymentTier: DeploymentTier.TEST,
      state: BotState.TESTING,
    });
  }
  if (scenario.includeDatabase) {
    registrations.push({
      id: "database",
      pid: 20_002,
      kind: "database",
      deploymentTier: DeploymentTier.PRODUCTION,
      priority: CpuPriority.LOW,
    });
  }
  return registrations;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
