export const CpuPriority = {
  BACKGROUND: "BACKGROUND",
  LOW: "LOW",
  NORMAL: "NORMAL",
  HIGH: "HIGH",
  REALTIME: "REALTIME",
  CRITICAL: "CRITICAL",
} as const;

export type CpuPriority = (typeof CpuPriority)[keyof typeof CpuPriority];

export const BotState = {
  IDLE: "IDLE",
  CHAT: "CHAT",
  TRAVEL: "TRAVEL",
  MINING: "MINING",
  BUILDING: "BUILDING",
  PATHFINDING: "PATHFINDING",
  COMBAT: "COMBAT",
  CRYSTAL_PVP: "CRYSTAL_PVP",
  ESCAPE: "ESCAPE",
  RECOVERY: "RECOVERY",
  TESTING: "TESTING",
} as const;

export type BotState = (typeof BotState)[keyof typeof BotState];

export const DeploymentTier = {
  PRODUCTION: "production",
  CANARY: "canary",
  TEST: "test",
  BATCH: "batch",
} as const;

export type DeploymentTier =
  (typeof DeploymentTier)[keyof typeof DeploymentTier];

export type WorkloadKind =
  | "minecraft-bot"
  | "pathfinder"
  | "combat"
  | "coordinator"
  | "database"
  | "redis"
  | "bullmq"
  | "web"
  | "logging"
  | "monitoring"
  | "rag"
  | "skill-test"
  | "batch"
  | "generic";

export type CpuCoreClass = "performance" | "efficiency" | "unknown";

export type CpuClassificationSource =
  | "manual"
  | "linux-cpuid-leaf-0x1a"
  | "linux-sysfs-cpu-capacity"
  | "generic";

export type CpuClassificationReliability = "exact" | "capacity" | "none";

export type LogicalCpu = Readonly<{
  id: number;
  online: boolean;
  allowed: boolean;
  packageId: number | null;
  dieId: number | null;
  coreId: number | null;
  numaNodeId: number | null;
  capacity: number | null;
  coreClass: CpuCoreClass;
}>;

export type CpuTopology = Readonly<{
  schemaVersion: "1.0";
  capturedAt: string;
  platform: NodeJS.Platform;
  architecture: string;
  vendor: string;
  model: string;
  logicalCores: number;
  availableLogicalCores: number;
  physicalCores: number | null;
  availablePhysicalCores: number | null;
  numaNodes: readonly number[];
  hybridCpuDetected: boolean;
  heterogeneousCapacityDetected: boolean;
  affinitySafe: boolean;
  classification: Readonly<{
    source: CpuClassificationSource;
    reliability: CpuClassificationReliability;
    reason: string;
  }>;
  cpus: readonly LogicalCpu[];
  warnings: readonly string[];
}>;

export type CpuPoolName =
  | "realtimePool"
  | "performancePool"
  | "backgroundPool"
  | "systemPool";

export type CpuPool = Readonly<{
  name: CpuPoolName;
  cpuIds: readonly number[];
  source: "exact" | "capacity" | "generic";
}>;

export type CpuPools = Readonly<Record<CpuPoolName, CpuPool>>;

export type CpuResourceEventType =
  | "CPU_ASSIGN"
  | "CPU_RELEASE"
  | "CPU_PROMOTE"
  | "CPU_DEMOTE"
  | "CPU_REBALANCE"
  | "CPU_AFFINITY_FAILURE"
  | "CPU_FALLBACK"
  /**
   * 周期 tick 自身失败。调度器是被监视的旁路，它的异常绝不能顺着
   * unhandledRejection 杀掉宿主 Bot 进程——失败在这里被如实上报，
   * 下一拍照常继续。
   */
  | "CPU_TICK_FAILED";

export type CpuResourceEvent = Readonly<{
  schemaVersion: "1.0";
  timestamp: string;
  type: CpuResourceEventType;
  workloadId: string | null;
  pid: number | null;
  previousPriority: CpuPriority | null;
  priority: CpuPriority | null;
  previousPool: CpuPoolName | null;
  pool: CpuPoolName | null;
  reason: string;
  errorCode?: string;
}>;

export type WorkloadMetrics = Readonly<{
  eventLoopLagMs?: number;
  botTickDelayMs?: number;
  pathfinderLatencyMs?: number;
  workerQueueDepth?: number;
  workerLatencyMs?: number;
  databaseLatencyMs?: number;
}>;

export type ManagedWorkloadSnapshot = Readonly<{
  id: string;
  pid: number;
  kind: WorkloadKind;
  deploymentTier: DeploymentTier;
  state: BotState | null;
  priority: CpuPriority;
  pool: CpuPoolName;
  assignedAt: string;
  lastPriorityChangeAt: string;
  lastMigrationAt: string | null;
  affinityApplied: boolean;
  metrics: WorkloadMetrics;
}>;


export type CpuLoadSample = Readonly<{
  capturedAt: string;
  totalUsagePercent: number | null;
  perCpuUsagePercent: Readonly<Record<number, number | null>>;
  loadAverage: readonly [number, number, number];
}>;

export type RuntimeSizingRecommendation = Readonly<{
  desiredBots: number;
  recommendedMaxActiveBots: number;
  botProcesses: number;
  botsPerProcess: number;
  pathfinderWorkers: number;
  testConcurrency: number;
  backgroundConcurrency: number;
  source: "detected-hardware";
  constrained: boolean;
  reasons: readonly string[];
}>;

export type HardwareProfile = Readonly<{
  schemaVersion: "1.0";
  capturedAt: string;
  cpu: Readonly<{
    vendor: string;
    model: string;
    architecture: string;
    logicalCores: number;
    availableLogicalCores: number;
    physicalCores: number | null;
    performanceCores: number | null;
    efficiencyCores: number | null;
    hybrid: boolean;
    classificationSource: CpuClassificationSource;
    classificationReliability: CpuClassificationReliability;
  }>;
  memory: Readonly<{
    totalBytes: number;
    freeBytes: number;
  }>;
  disk: Readonly<{
    status: "available" | "unavailable";
    source: string;
    totalBytes?: number;
    freeBytes?: number;
  }>;
  gpu: Readonly<{
    status: "detected" | "not_detected" | "probe_unavailable";
    source: string;
    devices: readonly Readonly<{ name: string }>[];
  }>;
  network: Readonly<{
    status: "available" | "unavailable";
    source: string;
    activeInterfaceCount: number;
  }>;
  recommended: RuntimeSizingRecommendation;
}>;
