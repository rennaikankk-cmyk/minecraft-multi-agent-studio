import type { CpuResourceManagerConfig } from "./config.js";
import {
  compareWorkloadImportance,
  cpuPriorityForBotState,
  cpuPriorityRank,
  defaultCpuPriorityForWorkload,
} from "./priority.js";
import { cpuPoolForPriority } from "./pools.js";
import {
  BotState,
  CpuPriority,
  DeploymentTier,
  type CpuLoadSample,
  type CpuPoolName,
  type CpuPools,
  type ManagedWorkloadSnapshot,
  type WorkloadKind,
  type WorkloadMetrics,
} from "./types.js";

const WORKLOAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type WorkloadRegistration = Readonly<{
  id: string;
  pid: number;
  kind: WorkloadKind;
  deploymentTier: DeploymentTier;
  state?: BotState;
  priority?: CpuPriority;
}>;

export type RebalanceDecision = Readonly<{
  workloadId: string;
  pid: number;
  previousPool: CpuPoolName;
  targetPool: CpuPoolName;
  priority: CpuPriority;
  reason: string;
  critical: boolean;
}>;

type MutableWorkload = {
  id: string;
  pid: number;
  kind: WorkloadKind;
  deploymentTier: DeploymentTier;
  state: BotState | null;
  priority: CpuPriority;
  pool: CpuPoolName;
  assignedAtMs: number;
  lastPriorityChangeAtMs: number;
  lastMigrationAtMs: number | null;
  affinityApplied: boolean;
  metrics: WorkloadMetrics;
};

export class ResourceScheduler {
  private readonly workloads = new Map<string, MutableWorkload>();
  private readonly pools: CpuPools;
  private readonly config: CpuResourceManagerConfig;
  private readonly now: () => number;
  private lastRebalanceAtMs: number | null = null;

  constructor(options: {
    pools: CpuPools;
    config: CpuResourceManagerConfig;
    now?: () => number;
  }) {
    this.pools = options.pools;
    this.config = options.config;
    this.now = options.now ?? (() => Date.now());
  }

  register(input: WorkloadRegistration): ManagedWorkloadSnapshot {
    validateRegistration(input);
    if (this.workloads.has(input.id)) {
      throw new TypeError("CPU workload ID is already registered.");
    }
    const timestamp = this.now();
    const state = input.state ?? null;
    const priority =
      input.priority ??
      (state
        ? cpuPriorityForBotState(state, this.config.priorities)
        : defaultCpuPriorityForWorkload(input.kind));
    const workload: MutableWorkload = {
      id: input.id,
      pid: input.pid,
      kind: input.kind,
      deploymentTier: input.deploymentTier,
      state,
      priority,
      pool: cpuPoolForPriority(priority),
      assignedAtMs: timestamp,
      lastPriorityChangeAtMs: timestamp,
      lastMigrationAtMs: null,
      affinityApplied: false,
      metrics: Object.freeze({}),
    };
    this.workloads.set(input.id, workload);
    return snapshot(workload);
  }

  updateBotState(id: string, state: BotState): ManagedWorkloadSnapshot {
    const workload = this.requireWorkload(id);
    const priority = cpuPriorityForBotState(state, this.config.priorities);
    workload.state = state;
    if (priority !== workload.priority) {
      workload.priority = priority;
      workload.lastPriorityChangeAtMs = this.now();
    }
    return snapshot(workload);
  }

  updatePriority(id: string, priority: CpuPriority): ManagedWorkloadSnapshot {
    const workload = this.requireWorkload(id);
    if (priority !== workload.priority) {
      workload.priority = priority;
      workload.lastPriorityChangeAtMs = this.now();
    }
    return snapshot(workload);
  }

  updateMetrics(id: string, metrics: WorkloadMetrics): ManagedWorkloadSnapshot {
    validateMetrics(metrics);
    const workload = this.requireWorkload(id);
    workload.metrics = Object.freeze({ ...metrics });
    return snapshot(workload);
  }

  planRebalance(loadSample?: CpuLoadSample): RebalanceDecision[] {
    const now = this.now();
    const productionCritical = [...this.workloads.values()].some(
      (workload) =>
        workload.deploymentTier === DeploymentTier.PRODUCTION &&
        cpuPriorityRank(workload.priority) >= cpuPriorityRank(CpuPriority.REALTIME),
    );

    return [...this.workloads.values()]
      .sort((left, right) => compareWorkloadImportance(right, left))
      .flatMap((workload) => {
        const target = targetPool(
          workload,
          productionCritical,
          loadSample,
          this.config,
          this.pools,
        );
        if (target.pool === workload.pool) return [];
        const critical = workload.priority === CpuPriority.CRITICAL;
        if (!this.migrationAllowed(workload, target.pool, now, critical)) {
          return [];
        }
        return [
          Object.freeze({
            workloadId: workload.id,
            pid: workload.pid,
            previousPool: workload.pool,
            targetPool: target.pool,
            priority: workload.priority,
            reason: target.reason,
            critical,
          }),
        ];
      });
  }

  commitMigration(
    decision: RebalanceDecision,
    affinityApplied: boolean,
  ): ManagedWorkloadSnapshot {
    const workload = this.requireWorkload(decision.workloadId);
    if (workload.pool !== decision.previousPool) {
      throw new TypeError("CPU migration decision is stale.");
    }
    const timestamp = this.now();
    workload.pool = decision.targetPool;
    workload.lastMigrationAtMs = timestamp;
    workload.affinityApplied = affinityApplied;
    this.lastRebalanceAtMs = timestamp;
    return snapshot(workload);
  }

  markInitialAffinity(id: string, applied: boolean): ManagedWorkloadSnapshot {
    const workload = this.requireWorkload(id);
    workload.affinityApplied = applied;
    if (applied) workload.lastMigrationAtMs = this.now();
    return snapshot(workload);
  }

  release(id: string): ManagedWorkloadSnapshot | null {
    const workload = this.workloads.get(id);
    if (!workload) return null;
    this.workloads.delete(id);
    return snapshot(workload);
  }

  get(id: string): ManagedWorkloadSnapshot | null {
    const workload = this.workloads.get(id);
    return workload ? snapshot(workload) : null;
  }

  snapshots(): ManagedWorkloadSnapshot[] {
    return [...this.workloads.values()]
      .map(snapshot)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private migrationAllowed(
    workload: MutableWorkload,
    targetPool: CpuPoolName,
    now: number,
    critical: boolean,
  ): boolean {
    if (critical && poolRank(targetPool) > poolRank(workload.pool)) return true;
    if (
      this.lastRebalanceAtMs !== null &&
      now - this.lastRebalanceAtMs < this.config.rebalance.cooldownMs
    ) {
      return false;
    }
    if (
      workload.lastMigrationAtMs !== null &&
      now - workload.lastMigrationAtMs <
        this.config.rebalance.minimumResidencyMs
    ) {
      return false;
    }
    const demotion = poolRank(targetPool) < poolRank(workload.pool);
    return !demotion ||
      now - workload.lastPriorityChangeAtMs >=
        this.config.rebalance.demotionDelayMs;
  }

  private requireWorkload(id: string): MutableWorkload {
    const workload = this.workloads.get(id);
    if (!workload) throw new TypeError("CPU workload is not registered.");
    return workload;
  }
}

function targetPool(
  workload: MutableWorkload,
  productionCritical: boolean,
  loadSample: CpuLoadSample | undefined,
  config: CpuResourceManagerConfig,
  pools: CpuPools,
): { pool: CpuPoolName; reason: string } {
  if (
    productionCritical &&
    (workload.deploymentTier === DeploymentTier.TEST ||
      workload.deploymentTier === DeploymentTier.BATCH)
  ) {
    return { pool: "backgroundPool", reason: "production_realtime_preemption" };
  }

  const lagging =
    (workload.metrics.eventLoopLagMs ?? 0) >
      config.thresholds.eventLoopLagHighMs ||
    (workload.metrics.botTickDelayMs ?? 0) >
      config.thresholds.botTickDelayHighMs ||
    (workload.metrics.pathfinderLatencyMs ?? 0) >
      config.thresholds.pathfinderLatencyHighMs;
  if (
    lagging &&
    cpuPriorityRank(workload.priority) >= cpuPriorityRank(CpuPriority.NORMAL) &&
    cpuPriorityRank(workload.priority) < cpuPriorityRank(CpuPriority.REALTIME)
  ) {
    return { pool: "performancePool", reason: "latency_threshold_exceeded" };
  }

  const target = cpuPoolForPriority(workload.priority);
  if (
    target === "performancePool" &&
    poolUsagePercent(loadSample, pools.performancePool.cpuIds) >=
      config.thresholds.performancePoolBusyPercent &&
    workload.priority === CpuPriority.HIGH &&
    (workload.deploymentTier === DeploymentTier.PRODUCTION ||
      workload.deploymentTier === DeploymentTier.CANARY) &&
    !sameCpuSet(
      pools.performancePool.cpuIds,
      pools.realtimePool.cpuIds,
    )
  ) {
    return { pool: "realtimePool", reason: "high_priority_burst" };
  }
  return { pool: target, reason: `priority_${workload.priority.toLowerCase()}` };
}

function sameCpuSet(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function poolUsagePercent(
  sample: CpuLoadSample | undefined,
  cpuIds: readonly number[],
): number {
  if (!sample || cpuIds.length === 0) return 0;
  const values = cpuIds.flatMap((id) => {
    const value = sample.perCpuUsagePercent[id];
    return value === null || value === undefined ? [] : [value];
  });
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function poolRank(pool: CpuPoolName): number {
  switch (pool) {
    case "backgroundPool":
      return 0;
    case "systemPool":
      return 1;
    case "performancePool":
      return 2;
    case "realtimePool":
      return 3;
  }
}

function snapshot(workload: MutableWorkload): ManagedWorkloadSnapshot {
  return Object.freeze({
    id: workload.id,
    pid: workload.pid,
    kind: workload.kind,
    deploymentTier: workload.deploymentTier,
    state: workload.state,
    priority: workload.priority,
    pool: workload.pool,
    assignedAt: new Date(workload.assignedAtMs).toISOString(),
    lastPriorityChangeAt: new Date(
      workload.lastPriorityChangeAtMs,
    ).toISOString(),
    lastMigrationAt:
      workload.lastMigrationAtMs === null
        ? null
        : new Date(workload.lastMigrationAtMs).toISOString(),
    affinityApplied: workload.affinityApplied,
    metrics: Object.freeze({ ...workload.metrics }),
  });
}

function validateRegistration(input: WorkloadRegistration): void {
  if (
    !WORKLOAD_ID_PATTERN.test(input.id) ||
    !Number.isSafeInteger(input.pid) ||
    input.pid <= 0
  ) {
    throw new TypeError("CPU workload registration is invalid.");
  }
}

function validateMetrics(metrics: WorkloadMetrics): void {
  if (
    Object.values(metrics).some(
      (value) =>
        value !== undefined &&
        (!Number.isFinite(value) || value < 0 || value > 1_000_000),
    )
  ) {
    throw new TypeError("CPU workload metrics are invalid.");
  }
}
