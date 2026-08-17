import { open, readFile, readdir } from "node:fs/promises";
import os from "node:os";

import {
  intersectCpuLists,
  normalizeCpuIds,
  parseCpuList,
} from "./cpu-set.js";
import type {
  CpuClassificationReliability,
  CpuClassificationSource,
  CpuCoreClass,
  CpuTopology,
  LogicalCpu,
} from "./types.js";

const CPU_SYSFS_ROOT = "/sys/devices/system/cpu";
const PROC_SELF_STATUS = "/proc/self/status";
const PROC_CPUINFO = "/proc/cpuinfo";
const INTEL_CORE_TYPE = 0x40;
const INTEL_ATOM_TYPE = 0x20;

export type CpuidRegisters = Readonly<{
  eax: number;
  ebx: number;
  ecx: number;
  edx: number;
}>;

export type CpuDetectionMode = "auto" | "manual" | "disabled";

export type ManualCpuClassification = Readonly<{
  performanceCpuIds: readonly number[];
  efficiencyCpuIds: readonly number[];
}>;

export type CpuDetectionOptions = Readonly<{
  mode?: CpuDetectionMode;
  manual?: ManualCpuClassification;
  platform?: NodeJS.Platform;
  architecture?: string;
  cpuInfo?: readonly Readonly<{ model: string }>[];
  availableParallelism?: () => number;
  now?: () => Date;
  readTextFile?: (path: string) => Promise<string>;
  readDirectory?: (path: string) => Promise<readonly string[]>;
  readCpuid?: (cpuId: number, leaf: number) => Promise<CpuidRegisters>;
}>;

type MutableLogicalCpu = {
  id: number;
  online: boolean;
  allowed: boolean;
  packageId: number | null;
  dieId: number | null;
  coreId: number | null;
  numaNodeId: number | null;
  capacity: number | null;
  coreClass: CpuCoreClass;
};

type Classification = {
  source: CpuClassificationSource;
  reliability: CpuClassificationReliability;
  reason: string;
};

const defaultReadTextFile = async (path: string): Promise<string> =>
  readFile(path, "utf8");

const defaultReadDirectory = async (path: string): Promise<readonly string[]> =>
  readdir(path);

async function defaultReadCpuid(
  cpuId: number,
  leaf: number,
): Promise<CpuidRegisters> {
  const handle = await open(`/dev/cpu/${cpuId}/cpuid`, "r");
  try {
    const buffer = Buffer.alloc(16);
    const result = await handle.read(buffer, 0, buffer.length, leaf);
    if (result.bytesRead !== buffer.length) {
      throw new Error("CPUID_SHORT_READ");
    }
    return {
      eax: buffer.readUInt32LE(0),
      ebx: buffer.readUInt32LE(4),
      ecx: buffer.readUInt32LE(8),
      edx: buffer.readUInt32LE(12),
    };
  } finally {
    await handle.close();
  }
}

export async function detectCpuTopology(
  options: CpuDetectionOptions = {},
): Promise<CpuTopology> {
  const platform = options.platform ?? os.platform();
  const architecture = options.architecture ?? os.arch();
  const cpuInfo = options.cpuInfo ?? os.cpus();
  const availableParallelism =
    options.availableParallelism ?? (() => os.availableParallelism());
  const now = options.now ?? (() => new Date());
  const readText = options.readTextFile ?? defaultReadTextFile;
  const readDirectory = options.readDirectory ?? defaultReadDirectory;
  const readCpuid = options.readCpuid ?? defaultReadCpuid;
  const warnings: string[] = [];

  const fallbackIds = Array.from(
    { length: Math.max(1, cpuInfo.length) },
    (_, index) => index,
  );
  const identity = await readCpuIdentity(readText, cpuInfo[0]?.model);

  if (platform !== "linux") {
    return genericTopology({
      platform,
      architecture,
      identity,
      cpuIds: fallbackIds,
      availableCount: Math.max(1, availableParallelism()),
      capturedAt: now().toISOString(),
      reason: `unsupported_platform:${platform}`,
      warnings: [`cpu_topology_probe_unavailable:${platform}`],
    });
  }

  const onlineResult = await readCpuListFile(
    `${CPU_SYSFS_ROOT}/online`,
    readText,
  );
  const onlineCpuIds = onlineResult ?? fallbackIds;
  if (!onlineResult) warnings.push("cpu_online_list_unavailable");

  const allowedResult = await readAllowedCpuList(readText);
  const allowedCpuIds = allowedResult
    ? intersectCpuLists(onlineCpuIds, allowedResult)
    : onlineCpuIds;
  if (!allowedResult) warnings.push("cpu_allowed_list_unavailable");
  const affinitySafe =
    onlineResult !== null && allowedResult !== null && allowedCpuIds.length > 0;
  if (allowedCpuIds.length === 0) {
    warnings.push("cpu_online_allowed_intersection_empty");
  } else if (!affinitySafe) {
    warnings.push("cpu_affinity_boundary_unavailable");
  }
  const allowedSet = new Set(allowedCpuIds);

  const cpus = await Promise.all(
    onlineCpuIds.map((id) =>
      readLogicalCpu(id, allowedSet.has(id), readText, readDirectory),
    ),
  );

  const mode = options.mode ?? "auto";
  let classification: Classification = {
    source: "generic",
    reliability: "none",
    reason: mode === "disabled" ? "resource_manager_disabled" : "no_reliable_core_type",
  };

  if (mode === "manual" && affinitySafe) {
    classification = applyManualClassification(
      cpus,
      allowedCpuIds,
      options.manual,
      warnings,
    );
  } else if (mode === "manual") {
    warnings.push("manual_cpu_classification_validation_unavailable");
    classification = {
      source: "generic",
      reliability: "none",
      reason: "manual_validation_requires_online_and_allowed_cpu_sets",
    };
  } else if (mode === "auto" && affinitySafe) {
    const exact = await applyExactIntelClassification(
      cpus,
      allowedCpuIds,
      readCpuid,
    );
    if (exact) {
      classification = exact;
    } else {
      warnings.push("cpu_exact_core_type_unavailable");
      classification = applyCapacityClassification(cpus, identity.vendor);
    }
  }

  const capacities = cpus
    .filter((cpu) => cpu.allowed && cpu.capacity !== null)
    .map((cpu) => cpu.capacity!);
  const heterogeneousCapacityDetected = new Set(capacities).size > 1;
  const hybridCpuDetected =
    classification.reliability === "exact" &&
    cpus.some((cpu) => cpu.allowed && cpu.coreClass === "performance") &&
    cpus.some((cpu) => cpu.allowed && cpu.coreClass === "efficiency");

  const immutableCpus: LogicalCpu[] = cpus.map((cpu) => Object.freeze({ ...cpu }));
  const availableCpus = immutableCpus.filter((cpu) => cpu.allowed);
  const availableCount = affinitySafe
    ? availableCpus.length
    : Math.max(1, availableParallelism());

  return Object.freeze({
    schemaVersion: "1.0",
    capturedAt: now().toISOString(),
    platform,
    architecture,
    vendor: identity.vendor,
    model: identity.model,
    logicalCores: immutableCpus.length,
    availableLogicalCores: availableCount,
    physicalCores: countPhysicalCores(immutableCpus),
    availablePhysicalCores: countPhysicalCores(availableCpus),
    numaNodes: uniqueNumbers(
      availableCpus.map((cpu) => cpu.numaNodeId).filter(isNumber),
    ),
    hybridCpuDetected,
    heterogeneousCapacityDetected,
    affinitySafe,
    classification: Object.freeze(classification),
    cpus: Object.freeze(immutableCpus),
    warnings: Object.freeze(warnings),
  });
}

async function readLogicalCpu(
  id: number,
  allowed: boolean,
  readText: (path: string) => Promise<string>,
  readDirectory: (path: string) => Promise<readonly string[]>,
): Promise<MutableLogicalCpu> {
  const cpuRoot = `${CPU_SYSFS_ROOT}/cpu${id}`;
  const topologyRoot = `${cpuRoot}/topology`;
  const [packageId, dieId, coreId, capacity, numaNodeId] = await Promise.all([
    readInteger(`${topologyRoot}/physical_package_id`, readText),
    readInteger(`${topologyRoot}/die_id`, readText),
    readInteger(`${topologyRoot}/core_id`, readText),
    readPositiveInteger(`${cpuRoot}/cpu_capacity`, readText),
    readNumaNode(cpuRoot, readDirectory),
  ]);

  return {
    id,
    online: true,
    allowed,
    packageId,
    dieId,
    coreId,
    numaNodeId,
    capacity,
    coreClass: "unknown",
  };
}

async function readCpuIdentity(
  readText: (path: string) => Promise<string>,
  fallbackModel: string | undefined,
): Promise<{ vendor: string; model: string }> {
  try {
    const cpuInfo = await readText(PROC_CPUINFO);
    const vendor = firstField(cpuInfo, "vendor_id") ?? "unknown";
    const model =
      firstField(cpuInfo, "model name") ??
      fallbackModel?.trim() ??
      "Unknown CPU reported by operating system";
    return { vendor: boundedText(vendor), model: boundedText(model) };
  } catch {
    return {
      vendor: "unknown",
      model: boundedText(
        fallbackModel?.trim() || "Unknown CPU reported by operating system",
      ),
    };
  }
}

function applyManualClassification(
  cpus: MutableLogicalCpu[],
  allowedCpuIds: readonly number[],
  manual: ManualCpuClassification | undefined,
  warnings: string[],
): Classification {
  if (!manual) {
    warnings.push("manual_cpu_classification_missing");
    return {
      source: "generic",
      reliability: "none",
      reason: "manual_configuration_missing",
    };
  }

  try {
    const performance = normalizeCpuIds(manual.performanceCpuIds);
    const efficiency = normalizeCpuIds(manual.efficiencyCpuIds);
    const allowed = new Set(allowedCpuIds);
    if (
      performance.length === 0 ||
      efficiency.length === 0 ||
      performance.some((id) => !allowed.has(id)) ||
      efficiency.some((id) => !allowed.has(id)) ||
      performance.some((id) => efficiency.includes(id))
    ) {
      throw new Error("CPU_MANUAL_PROFILE_INVALID");
    }
    const performanceSet = new Set(performance);
    const efficiencySet = new Set(efficiency);
    for (const cpu of cpus) {
      if (performanceSet.has(cpu.id)) cpu.coreClass = "performance";
      if (efficiencySet.has(cpu.id)) cpu.coreClass = "efficiency";
    }
    return {
      source: "manual",
      reliability: "exact",
      reason: "validated_manual_cpu_sets",
    };
  } catch {
    warnings.push("manual_cpu_classification_invalid");
    return {
      source: "generic",
      reliability: "none",
      reason: "manual_configuration_invalid",
    };
  }
}

async function applyExactIntelClassification(
  cpus: MutableLogicalCpu[],
  allowedCpuIds: readonly number[],
  readCpuid: (cpuId: number, leaf: number) => Promise<CpuidRegisters>,
): Promise<Classification | null> {
  try {
    const firstCpuId = allowedCpuIds[0];
    if (firstCpuId === undefined) return null;
    const leafZero = await readCpuid(firstCpuId, 0);
    if (leafZero.eax < 0x1a || cpuidVendor(leafZero) !== "GenuineIntel") {
      return null;
    }

    const classes = new Map<number, CpuCoreClass>();
    for (const cpuId of allowedCpuIds) {
      const registers = await readCpuid(cpuId, 0x1a);
      const coreType = registers.eax >>> 24;
      if (coreType === INTEL_CORE_TYPE) classes.set(cpuId, "performance");
      else if (coreType === INTEL_ATOM_TYPE) classes.set(cpuId, "efficiency");
      else return null;
    }
    const values = new Set(classes.values());
    if (!values.has("performance") || !values.has("efficiency")) return null;

    for (const cpu of cpus) {
      cpu.coreClass = classes.get(cpu.id) ?? "unknown";
    }
    return {
      source: "linux-cpuid-leaf-0x1a",
      reliability: "exact",
      reason: "intel_core_type_reported_for_every_allowed_cpu",
    };
  } catch {
    return null;
  }
}

function applyCapacityClassification(
  cpus: MutableLogicalCpu[],
  vendor: string,
): Classification {
  const available = cpus.filter((cpu) => cpu.allowed);
  if (
    vendor !== "GenuineIntel" ||
    available.length === 0 ||
    available.some((cpu) => cpu.capacity === null)
  ) {
    return {
      source: "generic",
      reliability: "none",
      reason:
        vendor === "GenuineIntel"
          ? "cpu_capacity_incomplete"
          : "non_intel_without_exact_core_types",
    };
  }

  const capacities = uniqueNumbers(available.map((cpu) => cpu.capacity!));
  if (capacities.length < 2) {
    return {
      source: "generic",
      reliability: "none",
      reason: "uniform_cpu_capacity",
    };
  }

  const maximum = Math.max(...capacities);
  for (const cpu of cpus) {
    if (!cpu.allowed || cpu.capacity === null) continue;
    cpu.coreClass = cpu.capacity === maximum ? "performance" : "efficiency";
  }
  return {
    source: "linux-sysfs-cpu-capacity",
    reliability: "capacity",
    reason: "kernel_reported_asymmetric_cpu_capacity",
  };
}

function genericTopology(input: {
  platform: NodeJS.Platform;
  architecture: string;
  identity: { vendor: string; model: string };
  cpuIds: readonly number[];
  availableCount: number;
  capturedAt: string;
  reason: string;
  warnings: readonly string[];
}): CpuTopology {
  const cpus = input.cpuIds.map<LogicalCpu>((id) =>
    Object.freeze({
      id,
      online: true,
      allowed: true,
      packageId: null,
      dieId: null,
      coreId: null,
      numaNodeId: null,
      capacity: null,
      coreClass: "unknown",
    }),
  );
  return Object.freeze({
    schemaVersion: "1.0",
    capturedAt: input.capturedAt,
    platform: input.platform,
    architecture: input.architecture,
    vendor: input.identity.vendor,
    model: input.identity.model,
    logicalCores: cpus.length,
    availableLogicalCores: Math.min(input.availableCount, cpus.length),
    physicalCores: null,
    availablePhysicalCores: null,
    numaNodes: Object.freeze([]),
    hybridCpuDetected: false,
    heterogeneousCapacityDetected: false,
    affinitySafe: false,
    classification: Object.freeze({
      source: "generic" as const,
      reliability: "none" as const,
      reason: input.reason,
    }),
    cpus: Object.freeze(cpus),
    warnings: Object.freeze([...input.warnings]),
  });
}

async function readCpuListFile(
  path: string,
  readText: (path: string) => Promise<string>,
): Promise<number[] | null> {
  try {
    return parseCpuList(await readText(path));
  } catch {
    return null;
  }
}

async function readAllowedCpuList(
  readText: (path: string) => Promise<string>,
): Promise<number[] | null> {
  try {
    const status = await readText(PROC_SELF_STATUS);
    const match = status.match(/^Cpus_allowed_list:\s*([^\r\n]+)$/mu);
    return match?.[1] ? parseCpuList(match[1]) : null;
  } catch {
    return null;
  }
}

async function readInteger(
  path: string,
  readText: (path: string) => Promise<string>,
): Promise<number | null> {
  try {
    const value = Number((await readText(path)).trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

async function readPositiveInteger(
  path: string,
  readText: (path: string) => Promise<string>,
): Promise<number | null> {
  const value = await readInteger(path, readText);
  return value !== null && value > 0 ? value : null;
}

async function readNumaNode(
  cpuRoot: string,
  readDirectory: (path: string) => Promise<readonly string[]>,
): Promise<number | null> {
  try {
    const nodes = (await readDirectory(cpuRoot))
      .flatMap((entry) => {
        const match = entry.match(/^node([0-9]+)$/u);
        return match?.[1] ? [Number(match[1])] : [];
      })
      .filter((value) => Number.isSafeInteger(value) && value >= 0)
      .sort((left, right) => left - right);
    return nodes[0] ?? null;
  } catch {
    return null;
  }
}

function countPhysicalCores(cpus: readonly LogicalCpu[]): number | null {
  if (
    cpus.length === 0 ||
    cpus.some((cpu) => cpu.packageId === null || cpu.coreId === null)
  ) {
    return null;
  }
  const keys = new Set(
    cpus.map(
      (cpu) => `${cpu.packageId}:${cpu.dieId ?? "unknown"}:${cpu.coreId}`,
    ),
  );
  return keys.size;
}

function cpuidVendor(registers: CpuidRegisters): string {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt32LE(registers.ebx >>> 0, 0);
  buffer.writeUInt32LE(registers.edx >>> 0, 4);
  buffer.writeUInt32LE(registers.ecx >>> 0, 8);
  return buffer.toString("ascii");
}

function firstField(value: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = value.match(new RegExp(`^${escaped}\\s*:\\s*(.+)$`, "mu"));
  return match?.[1]?.trim() || null;
}

function boundedText(value: string): string {
  return value.slice(0, 240) || "unknown";
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function isNumber(value: number | null): value is number {
  return value !== null;
}
