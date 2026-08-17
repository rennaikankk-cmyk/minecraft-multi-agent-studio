import { normalizeCpuIds } from "./cpu-set.js";
import { CpuPriority, type CpuPoolName, type CpuPools, type CpuTopology } from "./types.js";

export function createCpuPools(topology: CpuTopology): CpuPools {
  const allowedCpuIds = normalizeCpuIds(
    topology.cpus.filter((cpu) => cpu.allowed).map((cpu) => cpu.id),
  );
  const systemCpuIds = allowedCpuIds.length > 0
    ? allowedCpuIds
    : normalizeCpuIds(topology.cpus.filter((cpu) => cpu.online).map((cpu) => cpu.id));
  const performanceCpuIds = normalizeCpuIds(
    topology.cpus
      .filter((cpu) => cpu.allowed && cpu.coreClass === "performance")
      .map((cpu) => cpu.id),
  );
  const efficiencyCpuIds = normalizeCpuIds(
    topology.cpus
      .filter((cpu) => cpu.allowed && cpu.coreClass === "efficiency")
      .map((cpu) => cpu.id),
  );

  const classified =
    topology.affinitySafe &&
    topology.classification.reliability === "exact" &&
    performanceCpuIds.length > 0 &&
    efficiencyCpuIds.length > 0;
  const source = classified ? "exact" : "generic";
  const performance = classified
    ? baselinePerformanceCpuIds(topology, performanceCpuIds)
    : systemCpuIds;
  const realtime = classified ? performanceCpuIds : systemCpuIds;
  const background = classified ? efficiencyCpuIds : systemCpuIds;

  return Object.freeze({
    realtimePool: Object.freeze({
      name: "realtimePool",
      cpuIds: Object.freeze([...realtime]),
      source,
    }),
    performancePool: Object.freeze({
      name: "performancePool",
      cpuIds: Object.freeze([...performance]),
      source,
    }),
    backgroundPool: Object.freeze({
      name: "backgroundPool",
      cpuIds: Object.freeze([...background]),
      source,
    }),
    systemPool: Object.freeze({
      name: "systemPool",
      cpuIds: Object.freeze([...systemCpuIds]),
      source: classified ? source : "generic",
    }),
  });
}

function baselinePerformanceCpuIds(
  topology: CpuTopology,
  performanceCpuIds: readonly number[],
): number[] {
  const performance = topology.cpus.filter(
    (cpu) => cpu.allowed && cpu.coreClass === "performance",
  );
  if (
    performance.some(
      (cpu) => cpu.packageId === null || cpu.coreId === null,
    )
  ) {
    return [...performanceCpuIds];
  }
  const groups = new Map<string, number[]>();
  for (const cpu of performance) {
    const key = `${cpu.packageId}:${cpu.dieId ?? "unknown"}:${cpu.coreId}`;
    const group = groups.get(key) ?? [];
    group.push(cpu.id);
    groups.set(key, group);
  }
  if (groups.size < 4) return [...performanceCpuIds];
  const baselineCoreCount = Math.max(1, Math.ceil(groups.size * 0.75));
  return normalizeCpuIds(
    [...groups.values()].slice(0, baselineCoreCount).flat(),
  );
}

export function cpuPoolForPriority(priority: CpuPriority): CpuPoolName {
  switch (priority) {
    case CpuPriority.BACKGROUND:
    case CpuPriority.LOW:
      return "backgroundPool";
    case CpuPriority.NORMAL:
      return "systemPool";
    case CpuPriority.HIGH:
      return "performancePool";
    case CpuPriority.REALTIME:
    case CpuPriority.CRITICAL:
      return "realtimePool";
  }
}

export function cpuPoolsHaveSameCpuSet(
  pools: CpuPools,
  left: CpuPoolName,
  right: CpuPoolName,
): boolean {
  const leftIds = pools[left].cpuIds;
  const rightIds = pools[right].cpuIds;
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id, index) => id === rightIds[index])
  );
}
