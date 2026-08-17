export {
  LinuxTasksetAffinityAdapter,
  NoopCpuAffinityAdapter,
  type AffinityCommandRunner,
  type AffinityFailureCode,
  type AffinityResult,
  type CpuAffinityAdapter,
} from "./affinity.js";
export {
  defaultCpuResourceManagerConfig,
  loadCpuResourceManagerConfig,
  type BotRuntimeProcessMode,
  type CpuResourceManagerConfig,
  type CpuResourceManagerConfigLoadResult,
} from "./config.js";
export {
  CpuSetParseError,
  formatCpuList,
  intersectCpuLists,
  normalizeCpuIds,
  parseCpuList,
  type CpuSetParseErrorCode,
} from "./cpu-set.js";
export {
  detectCpuTopology,
  detectCpuTopology as detectCPU,
  type CpuidRegisters,
  type CpuDetectionMode,
  type CpuDetectionOptions,
  type ManualCpuClassification,
} from "./detect.js";
export {
  createHardwareProfile,
  recommendRuntimeSizing,
  type HardwareProfileFacts,
  type RuntimeSizingOptions,
} from "./hardware-profile.js";
export {
  parseProcStat,
  ProcStatCpuMonitor,
  type ProcStatCpuMonitorOptions,
} from "./monitor.js";
export {
  cpuPoolForPriority,
  cpuPoolsHaveSameCpuSet,
  createCpuPools,
} from "./pools.js";
export {
  compareWorkloadImportance,
  cpuPriorityForBotState,
  cpuPriorityRank,
  defaultBotStatePriorities,
  defaultCpuPriorityForWorkload,
  deploymentTierRank,
} from "./priority.js";
export {
  detectHardwareProfile,
  HardwareProfiler,
  writeHardwareProfile,
  type HardwareProfilerCommandResult,
  type HardwareProfilerCommandRunner,
  type HardwareProfilerOptions,
} from "./profiler.js";
export {
  CPUResourceManager,
  type CpuResourceEventSink,
  type CpuResourceManagerOptions,
  type CpuResourceManagerSnapshot,
} from "./resource-manager.js";
export {
  ResourceScheduler,
  type RebalanceDecision,
  type WorkloadRegistration,
} from "./scheduler.js";
export {
  BotState,
  CpuPriority,
  DeploymentTier,
  type CpuClassificationReliability,
  type CpuClassificationSource,
  type CpuCoreClass,
  type CpuLoadSample,
  type CpuPool,
  type CpuPoolName,
  type CpuPools,
  type CpuResourceEvent,
  type CpuResourceEventType,
  type CpuTopology,
  type DeploymentTier as DeploymentTierValue,
  type HardwareProfile,
  type LogicalCpu,
  type ManagedWorkloadSnapshot,
  type RuntimeSizingRecommendation,
  type WorkloadKind,
  type WorkloadMetrics,
} from "./types.js";

import type { CpuTopology, LogicalCpu } from "./types.js";

/** Exact P/E detection only; capacity-only and generic topologies return false. */
export function detectHybridArchitecture(topology: CpuTopology): boolean {
  return (
    topology.hybridCpuDetected &&
    topology.classification.reliability === "exact"
  );
}

/** Returns only CPUs whose core type was explicitly classified as performance. */
export function detectPerformanceCores(
  topology: CpuTopology,
): readonly LogicalCpu[] {
  if (topology.classification.reliability !== "exact") return Object.freeze([]);
  return Object.freeze(
    topology.cpus.filter(
      (cpu) => cpu.allowed && cpu.coreClass === "performance",
    ),
  );
}

/** Returns only CPUs whose core type was explicitly classified as efficiency. */
export function detectEfficiencyCores(
  topology: CpuTopology,
): readonly LogicalCpu[] {
  if (topology.classification.reliability !== "exact") return Object.freeze([]);
  return Object.freeze(
    topology.cpus.filter(
      (cpu) => cpu.allowed && cpu.coreClass === "efficiency",
    ),
  );
}
