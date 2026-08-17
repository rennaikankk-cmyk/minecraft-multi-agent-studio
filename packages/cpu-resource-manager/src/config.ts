import { parseCpuList } from "./cpu-set.js";
import type { CpuDetectionMode, ManualCpuClassification } from "./detect.js";
import { defaultBotStatePriorities } from "./priority.js";
import { BotState, CpuPriority } from "./types.js";

export type BotRuntimeProcessMode = "process" | "grouped-process";

export type CpuResourceManagerConfig = Readonly<{
  enabled: boolean;
  mode: CpuDetectionMode;
  manual?: ManualCpuClassification;
  affinity: Readonly<{
    enabled: boolean;
  }>;
  scheduler: Readonly<{
    enabled: boolean;
    intervalMs: number;
  }>;
  rebalance: Readonly<{
    cooldownMs: number;
    minimumResidencyMs: number;
    demotionDelayMs: number;
  }>;
  thresholds: Readonly<{
    eventLoopLagHighMs: number;
    botTickDelayHighMs: number;
    pathfinderLatencyHighMs: number;
    performancePoolBusyPercent: number;
  }>;
  priorities: Readonly<Record<BotState, CpuPriority>>;
  botRuntime: Readonly<{
    mode: BotRuntimeProcessMode;
    botsPerProcess: number;
    autoSize: boolean;
  }>;
}>;

export type CpuResourceManagerConfigLoadResult = Readonly<{
  config: CpuResourceManagerConfig;
  warnings: readonly string[];
}>;

export const defaultCpuResourceManagerConfig: CpuResourceManagerConfig =
  Object.freeze({
    enabled: false,
    mode: "auto",
    affinity: Object.freeze({ enabled: false }),
    scheduler: Object.freeze({ enabled: false, intervalMs: 2_000 }),
    rebalance: Object.freeze({
      cooldownMs: 10_000,
      minimumResidencyMs: 30_000,
      demotionDelayMs: 30_000,
    }),
    thresholds: Object.freeze({
      eventLoopLagHighMs: 50,
      botTickDelayHighMs: 50,
      pathfinderLatencyHighMs: 250,
      performancePoolBusyPercent: 90,
    }),
    priorities: defaultBotStatePriorities,
    botRuntime: Object.freeze({
      mode: "process",
      botsPerProcess: 2,
      autoSize: true,
    }),
  });

export function loadCpuResourceManagerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CpuResourceManagerConfigLoadResult {
  const warnings: string[] = [];
  const enabled = booleanValue(
    environment.CPU_RESOURCE_MANAGER_ENABLED,
    defaultCpuResourceManagerConfig.enabled,
    "CPU_RESOURCE_MANAGER_ENABLED",
    warnings,
  );
  let mode = modeValue(environment.CPU_RESOURCE_MANAGER_MODE, warnings);
  let manual: ManualCpuClassification | undefined;
  if (mode === "manual") {
    try {
      manual = {
        performanceCpuIds: parseCpuList(
          environment.CPU_MANUAL_PERFORMANCE_CPUS ?? "",
        ),
        efficiencyCpuIds: parseCpuList(
          environment.CPU_MANUAL_EFFICIENCY_CPUS ?? "",
        ),
      };
    } catch {
      warnings.push("cpu_manual_sets_invalid_detection_disabled");
      mode = "disabled";
    }
  }

  const affinityEnabled = booleanValue(
    environment.CPU_AFFINITY_ENABLED,
    defaultCpuResourceManagerConfig.affinity.enabled,
    "CPU_AFFINITY_ENABLED",
    warnings,
  );
  let schedulerEnabled = booleanValue(
    environment.CPU_SCHEDULER_ENABLED,
    defaultCpuResourceManagerConfig.scheduler.enabled,
    "CPU_SCHEDULER_ENABLED",
    warnings,
  );
  if (schedulerEnabled && !enabled) {
    schedulerEnabled = false;
    warnings.push("cpu_scheduler_requires_resource_manager");
  }

  return Object.freeze({
    config: Object.freeze({
      enabled,
      mode,
      ...(manual ? { manual: Object.freeze(manual) } : {}),
      affinity: Object.freeze({ enabled: affinityEnabled }),
      scheduler: Object.freeze({
        enabled: schedulerEnabled,
        intervalMs: integerValue(
          environment.CPU_SCHEDULER_INTERVAL_MS,
          2_000,
          1_000,
          5_000,
          "CPU_SCHEDULER_INTERVAL_MS",
          warnings,
        ),
      }),
      rebalance: Object.freeze({
        cooldownMs: integerValue(
          environment.CPU_REBALANCE_COOLDOWN_MS,
          10_000,
          1_000,
          300_000,
          "CPU_REBALANCE_COOLDOWN_MS",
          warnings,
        ),
        minimumResidencyMs: integerValue(
          environment.CPU_MINIMUM_RESIDENCY_MS,
          30_000,
          1_000,
          900_000,
          "CPU_MINIMUM_RESIDENCY_MS",
          warnings,
        ),
        demotionDelayMs: integerValue(
          environment.CPU_DEMOTION_DELAY_MS,
          30_000,
          0,
          900_000,
          "CPU_DEMOTION_DELAY_MS",
          warnings,
        ),
      }),
      thresholds: defaultCpuResourceManagerConfig.thresholds,
      priorities: loadStatePriorities(environment, warnings),
      botRuntime: Object.freeze({
        mode: processModeValue(environment.BOT_RUNTIME_PROCESS_MODE, warnings),
        botsPerProcess: integerValue(
          environment.BOT_RUNTIME_BOTS_PER_PROCESS,
          2,
          1,
          3,
          "BOT_RUNTIME_BOTS_PER_PROCESS",
          warnings,
        ),
        autoSize: booleanValue(
          environment.BOT_RUNTIME_AUTO_SIZE,
          true,
          "BOT_RUNTIME_AUTO_SIZE",
          warnings,
        ),
      }),
    }),
    warnings: Object.freeze(warnings),
  });
}

function loadStatePriorities(
  environment: NodeJS.ProcessEnv,
  warnings: string[],
): Readonly<Record<BotState, CpuPriority>> {
  return Object.freeze(
    Object.fromEntries(
      Object.values(BotState).map((state) => [
        state,
        priorityValue(
          environment[`CPU_PRIORITY_${state}`],
          defaultBotStatePriorities[state],
          `CPU_PRIORITY_${state}`,
          warnings,
        ),
      ]),
    ) as Record<BotState, CpuPriority>,
  );
}

function priorityValue(
  value: string | undefined,
  fallback: CpuPriority,
  name: string,
  warnings: string[],
): CpuPriority {
  if (value === undefined || value === "") return fallback;
  const normalized = value.toUpperCase();
  if ((Object.values(CpuPriority) as string[]).includes(normalized)) {
    return normalized as CpuPriority;
  }
  warnings.push(`${name.toLowerCase()}_invalid`);
  return fallback;
}

function booleanValue(
  value: string | undefined,
  fallback: boolean,
  name: string,
  warnings: string[],
): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  warnings.push(`${name.toLowerCase()}_invalid`);
  return fallback;
}

function integerValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
  warnings: string[],
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]+$/u.test(value)) {
    warnings.push(`${name.toLowerCase()}_invalid`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    warnings.push(`${name.toLowerCase()}_invalid`);
    return fallback;
  }
  return parsed;
}

function modeValue(
  value: string | undefined,
  warnings: string[],
): CpuDetectionMode {
  if (value === undefined || value === "") return "auto";
  if (value === "auto" || value === "manual" || value === "disabled") {
    return value;
  }
  warnings.push("cpu_resource_manager_mode_invalid");
  return "auto";
}

function processModeValue(
  value: string | undefined,
  warnings: string[],
): BotRuntimeProcessMode {
  if (value === undefined || value === "") return "process";
  if (value === "process" || value === "grouped-process") return value;
  warnings.push("bot_runtime_process_mode_invalid");
  return "process";
}
