import type {
  CpuTopology,
  HardwareProfile,
  LogicalCpu,
  RuntimeSizingRecommendation,
} from "./types.js";

export type HardwareProfileFacts = Readonly<{
  memory: Readonly<{
    totalBytes: number;
    freeBytes: number;
  }>;
  disk: HardwareProfile["disk"];
  gpu: HardwareProfile["gpu"];
  network: HardwareProfile["network"];
}>;

export type RuntimeSizingOptions = Readonly<{
  desiredBots?: number;
}>;

export function recommendRuntimeSizing(
  topology: CpuTopology,
  options: RuntimeSizingOptions = {},
): RuntimeSizingRecommendation {
  const desiredBots = boundedInteger(options.desiredBots ?? 10, 1, 1_000);
  const effectiveCores = Math.max(
    1,
    topology.availablePhysicalCores ?? topology.availableLogicalCores,
  );
  const exactPerformanceCores =
    topology.classification.reliability === "exact"
      ? countClassifiedPhysicalCores(topology, "performance")
      : null;
  const exactEfficiencyCores =
    topology.classification.reliability === "exact"
      ? countClassifiedPhysicalCores(topology, "efficiency")
      : null;

  const botProcessBudget =
    effectiveCores <= 4
      ? Math.max(1, Math.floor(effectiveCores / 2))
      : Math.max(
          1,
          exactPerformanceCores ?? Math.floor(effectiveCores / 2),
        );
  const requestedProcesses = Math.max(1, Math.ceil(desiredBots / 2));
  const botProcesses = Math.max(
    1,
    Math.min(desiredBots, requestedProcesses, botProcessBudget),
  );
  const botsPerProcess = Math.max(
    1,
    Math.min(3, Math.ceil(desiredBots / botProcesses)),
  );
  const recommendedMaxActiveBots = Math.min(
    desiredBots,
    botProcesses * botsPerProcess,
  );

  const pathfinderBase = exactPerformanceCores ?? effectiveCores;
  const pathfinderWorkers = Math.max(
    1,
    Math.min(6, Math.floor(pathfinderBase / (exactPerformanceCores ? 2 : 4))),
  );
  const testBase = exactEfficiencyCores ?? effectiveCores;
  const testConcurrency = Math.max(
    1,
    Math.min(4, Math.floor(testBase / (exactEfficiencyCores ? 3 : 5))),
  );
  const backgroundConcurrency = Math.max(
    1,
    Math.min(8, Math.floor(testBase / 3)),
  );
  const reasons: string[] = [];
  if (effectiveCores <= 4) reasons.push("low_core_count");
  if (recommendedMaxActiveBots < desiredBots) {
    reasons.push("desired_bot_count_exceeds_recommended_cpu_budget");
  }
  if (!topology.hybridCpuDetected) reasons.push("generic_or_unconfirmed_core_types");
  if (!topology.affinitySafe) reasons.push("affinity_cpu_set_unavailable");

  return Object.freeze({
    desiredBots,
    recommendedMaxActiveBots,
    botProcesses,
    botsPerProcess,
    pathfinderWorkers,
    testConcurrency,
    backgroundConcurrency,
    source: "detected-hardware",
    constrained: reasons.length > 0,
    reasons: Object.freeze(reasons),
  });
}

export function createHardwareProfile(
  topology: CpuTopology,
  facts: HardwareProfileFacts,
  options: RuntimeSizingOptions = {},
): HardwareProfile {
  validateHardwareFacts(facts);
  const exact = topology.classification.reliability === "exact";
  return Object.freeze({
    schemaVersion: "1.0",
    capturedAt: topology.capturedAt,
    cpu: Object.freeze({
      vendor: topology.vendor,
      model: topology.model,
      architecture: topology.architecture,
      logicalCores: topology.logicalCores,
      availableLogicalCores: topology.availableLogicalCores,
      physicalCores: topology.physicalCores,
      performanceCores: exact
        ? countClassifiedPhysicalCores(topology, "performance")
        : null,
      efficiencyCores: exact
        ? countClassifiedPhysicalCores(topology, "efficiency")
        : null,
      hybrid: topology.hybridCpuDetected,
      classificationSource: topology.classification.source,
      classificationReliability: topology.classification.reliability,
    }),
    memory: Object.freeze({ ...facts.memory }),
    disk: Object.freeze({ ...facts.disk }),
    gpu: Object.freeze({
      ...facts.gpu,
      devices: Object.freeze(
        facts.gpu.devices.map((device) => Object.freeze({ ...device })),
      ),
    }),
    network: Object.freeze({ ...facts.network }),
    recommended: recommendRuntimeSizing(topology, options),
  });
}

function countClassifiedPhysicalCores(
  topology: CpuTopology,
  coreClass: "performance" | "efficiency",
): number | null {
  const cpus = topology.cpus.filter(
    (cpu) => cpu.allowed && cpu.coreClass === coreClass,
  );
  if (cpus.length === 0) return 0;
  if (cpus.some((cpu) => cpu.packageId === null || cpu.coreId === null)) {
    return null;
  }
  return new Set(cpus.map(coreKey)).size;
}

function coreKey(cpu: LogicalCpu): string {
  return `${cpu.packageId}:${cpu.dieId ?? "unknown"}:${cpu.coreId}`;
}

function validateHardwareFacts(facts: HardwareProfileFacts): void {
  if (
    !Number.isSafeInteger(facts.memory.totalBytes) ||
    facts.memory.totalBytes <= 0 ||
    !Number.isSafeInteger(facts.memory.freeBytes) ||
    facts.memory.freeBytes < 0 ||
    facts.memory.freeBytes > facts.memory.totalBytes ||
    !Number.isSafeInteger(facts.network.activeInterfaceCount) ||
    facts.network.activeInterfaceCount < 0
  ) {
    throw new TypeError("Hardware profile facts are invalid.");
  }
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError("Runtime sizing input is outside the allowed range.");
  }
  return value;
}
