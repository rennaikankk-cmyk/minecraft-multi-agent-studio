import type { CpuAffinityAdapter } from "./affinity.js";
import {
  LinuxTasksetAffinityAdapter,
  NoopCpuAffinityAdapter,
} from "./affinity.js";
import {
  defaultCpuResourceManagerConfig,
  type CpuResourceManagerConfig,
} from "./config.js";
import {
  detectCpuTopology,
  type CpuDetectionOptions,
} from "./detect.js";
import { ProcStatCpuMonitor } from "./monitor.js";
import { cpuPoolForPriority, createCpuPools } from "./pools.js";
import {
  ResourceScheduler,
  type RebalanceDecision,
  type WorkloadRegistration,
} from "./scheduler.js";
import {
  type BotState,
  type CpuLoadSample,
  type CpuPoolName,
  type CpuPools,
  type CpuPriority,
  type CpuResourceEvent,
  type CpuTopology,
  type ManagedWorkloadSnapshot,
  type WorkloadMetrics,
} from "./types.js";

export type CpuResourceEventSink = (event: CpuResourceEvent) => void;

export type CpuResourceManagerOptions = Readonly<{
  config?: CpuResourceManagerConfig;
  detection?: CpuDetectionOptions;
  affinityAdapter?: CpuAffinityAdapter;
  monitor?: ProcStatCpuMonitor;
  eventSink?: CpuResourceEventSink;
  pidAuthorizer?: (pid: number) => boolean;
  now?: () => Date;
}>;

export type CpuResourceManagerSnapshot = Readonly<{
  schemaVersion: "1.0";
  capturedAt: string;
  enabled: boolean;
  schedulerRunning: boolean;
  topology: CpuTopology;
  pools: CpuPools;
  workloads: readonly ManagedWorkloadSnapshot[];
  cpuLoad: CpuLoadSample | null;
}>;

type PendingPriorityChange = Readonly<{
  previous: CpuPriority;
  reason: string;
}>;

export class CPUResourceManager {
  readonly topology: CpuTopology;
  readonly pools: CpuPools;

  private readonly config: CpuResourceManagerConfig;
  private readonly affinity: CpuAffinityAdapter;
  private readonly monitor: ProcStatCpuMonitor;
  private readonly eventSink: CpuResourceEventSink;
  private readonly pidAuthorizer: (pid: number) => boolean;
  private readonly now: () => Date;
  private readonly scheduler: ResourceScheduler;
  private readonly pendingPriorityChanges = new Map<
    string,
    PendingPriorityChange
  >();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCpuLoad: CpuLoadSample | null = null;
  private tickRunning = false;

  private constructor(
    topology: CpuTopology,
    pools: CpuPools,
    options: Required<
      Pick<CpuResourceManagerOptions, "config" | "affinityAdapter" | "monitor" | "eventSink" | "pidAuthorizer" | "now">
    >,
  ) {
    this.topology = topology;
    this.pools = pools;
    this.config = options.config;
    this.affinity = options.affinityAdapter;
    this.monitor = options.monitor;
    this.eventSink = options.eventSink;
    this.pidAuthorizer = options.pidAuthorizer;
    this.now = options.now;
    this.scheduler = new ResourceScheduler({
      pools,
      config: options.config,
      now: () => this.now().getTime(),
    });
  }

  static async create(
    options: CpuResourceManagerOptions = {},
  ): Promise<CPUResourceManager> {
    const config = options.config ?? defaultCpuResourceManagerConfig;
    const now = options.now ?? (() => new Date());
    let topology: CpuTopology;
    try {
      topology = await detectCpuTopology({
        ...options.detection,
        mode: config.mode,
        ...(config.manual ? { manual: config.manual } : {}),
        now,
      });
    } catch {
      topology = await detectCpuTopology({
        ...options.detection,
        mode: "disabled",
        now,
      });
    }
    const pools = createCpuPools(topology);
    const manager = new CPUResourceManager(topology, pools, {
      config,
      affinityAdapter:
        options.affinityAdapter ??
        (config.affinity.enabled
          ? new LinuxTasksetAffinityAdapter({ platform: topology.platform })
          : new NoopCpuAffinityAdapter()),
      monitor: options.monitor ?? new ProcStatCpuMonitor({ now }),
      eventSink: options.eventSink ?? (() => undefined),
      pidAuthorizer: options.pidAuthorizer ?? ((pid) => pid === process.pid),
      now,
    });
    if (
      !topology.hybridCpuDetected ||
      topology.classification.reliability !== "exact"
    ) {
      manager.emit({
        type: "CPU_FALLBACK",
        workloadId: null,
        pid: null,
        previousPriority: null,
        priority: null,
        previousPool: null,
        pool: "systemPool",
        reason: topology.classification.reason,
      });
    }
    return manager;
  }

  async assignProcess(
    input: WorkloadRegistration,
  ): Promise<ManagedWorkloadSnapshot> {
    if (!this.isPidAuthorized(input.pid)) {
      throw new TypeError("CPU workload PID is not authorized by the host.");
    }
    const initial = this.scheduler.register(input);
    const result = await this.applyPool(initial.pid, initial.pool);
    const snapshot = this.scheduler.markInitialAffinity(
      initial.id,
      result.applied,
    );
    if (result.failed) {
      this.affinityFailure(snapshot, result.errorCode);
    }
    this.emit({
      type: "CPU_ASSIGN",
      workloadId: snapshot.id,
      pid: snapshot.pid,
      previousPriority: null,
      priority: snapshot.priority,
      previousPool: null,
      pool: snapshot.pool,
      reason: result.applied
        ? "initial_affinity_applied"
        : this.config.enabled
          ? "logical_assignment_without_affinity"
          : "resource_manager_disabled",
    });
    return snapshot;
  }

  async assignWorker(
    input: WorkloadRegistration,
  ): Promise<ManagedWorkloadSnapshot> {
    return this.assignProcess(input);
  }

  async updateBotState(
    workloadId: string,
    state: BotState,
    reason = `bot_state_${state.toLowerCase()}`,
  ): Promise<ManagedWorkloadSnapshot> {
    const previous = this.requireSnapshot(workloadId);
    const current = this.scheduler.updateBotState(workloadId, state);
    this.rememberPriorityChange(previous, current, reason);
    await this.rebalance(reason);
    return this.requireSnapshot(workloadId);
  }

  async updatePriority(
    workloadId: string,
    priority: CpuPriority,
    reason = "explicit_priority_update",
  ): Promise<ManagedWorkloadSnapshot> {
    const previous = this.requireSnapshot(workloadId);
    const current = this.scheduler.updatePriority(workloadId, priority);
    this.rememberPriorityChange(previous, current, reason);
    await this.rebalance(reason);
    return this.requireSnapshot(workloadId);
  }

  updateMetrics(
    workloadId: string,
    metrics: WorkloadMetrics,
  ): ManagedWorkloadSnapshot {
    return this.scheduler.updateMetrics(workloadId, metrics);
  }

  async monitorCpuLoad(): Promise<CpuLoadSample | null> {
    try {
      this.lastCpuLoad = await this.monitor.sample();
      return this.lastCpuLoad;
    } catch {
      return null;
    }
  }

  async rebalance(reason = "periodic_sample"): Promise<RebalanceDecision[]> {
    if (!this.config.enabled) return [];
    const decisions = this.scheduler.planRebalance(
      this.lastCpuLoad ?? undefined,
    );
    const committed: RebalanceDecision[] = [];
    for (const decision of decisions) {
      const result = await this.applyPool(decision.pid, decision.targetPool);
      if (result.failed) {
        const workload = this.requireSnapshot(decision.workloadId);
        this.affinityFailure(workload, result.errorCode);
        continue;
      }
      const snapshot = this.scheduler.commitMigration(
        decision,
        result.applied,
      );
      const priorityChange = this.pendingPriorityChanges.get(
        decision.workloadId,
      );
      this.pendingPriorityChanges.delete(decision.workloadId);
      this.emit({
        type: migrationEventType(decision),
        workloadId: decision.workloadId,
        pid: decision.pid,
        previousPriority: priorityChange?.previous ?? null,
        priority: snapshot.priority,
        previousPool: decision.previousPool,
        pool: decision.targetPool,
        reason: priorityChange?.reason ?? `${reason}:${decision.reason}`,
      });
      committed.push(decision);
    }
    if (committed.length > 0) {
      this.emit({
        type: "CPU_REBALANCE",
        workloadId: null,
        pid: null,
        previousPriority: null,
        priority: null,
        previousPool: null,
        pool: null,
        reason: `${reason}:migrations=${committed.length}`,
      });
    }
    return committed;
  }

  async releaseResources(
    workloadId: string,
  ): Promise<ManagedWorkloadSnapshot | null> {
    const snapshot = this.scheduler.get(workloadId);
    if (!snapshot) return null;
    if (
      this.config.enabled &&
      this.config.affinity.enabled &&
      snapshot.affinityApplied
    ) {
      const result = await this.applyPool(snapshot.pid, "systemPool");
      if (result.failed) this.affinityFailure(snapshot, result.errorCode);
    }
    const released = this.scheduler.release(workloadId);
    this.pendingPriorityChanges.delete(workloadId);
    if (released) {
      this.emit({
        type: "CPU_RELEASE",
        workloadId: released.id,
        pid: released.pid,
        previousPriority: released.priority,
        priority: null,
        previousPool: released.pool,
        pool: "systemPool",
        reason: "workload_released",
      });
    }
    return released;
  }

  start(): boolean {
    if (
      this.timer ||
      !this.config.enabled ||
      !this.config.scheduler.enabled
    ) {
      return false;
    }
    this.timer = setInterval(() => void this.tick(), this.config.scheduler.intervalMs);
    this.timer.unref();
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): CpuResourceManagerSnapshot {
    return Object.freeze({
      schemaVersion: "1.0",
      capturedAt: this.now().toISOString(),
      enabled: this.config.enabled,
      schedulerRunning: this.timer !== null,
      topology: this.topology,
      pools: this.pools,
      workloads: Object.freeze(this.scheduler.snapshots()),
      cpuLoad: this.lastCpuLoad,
    });
  }

  private async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.monitorCpuLoad();
      await this.rebalance();
    } finally {
      this.tickRunning = false;
    }
  }

  private async applyPool(
    pid: number,
    poolName: CpuPoolName,
  ): Promise<{
    applied: boolean;
    failed: boolean;
    errorCode?: string;
  }> {
    if (!this.config.enabled || !this.config.affinity.enabled) {
      return { applied: false, failed: false };
    }
    if (!this.isPidAuthorized(pid)) {
      return {
        applied: false,
        failed: true,
        errorCode: "AFFINITY_PID_NOT_AUTHORIZED",
      };
    }
    if (this.topology.classification.reliability !== "exact") {
      return { applied: false, failed: false };
    }
    const pool = this.pools[poolName];
    if (!this.topology.affinitySafe || pool.cpuIds.length === 0) {
      return {
        applied: false,
        failed: true,
        errorCode: "AFFINITY_CPU_SET_EMPTY",
      };
    }
    const result = await this.affinity.apply(pid, pool.cpuIds);
    return result.applied
      ? { applied: true, failed: false }
      : {
          applied: false,
          failed: true,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        };
  }

  private affinityFailure(
    workload: ManagedWorkloadSnapshot,
    errorCode: string | undefined,
  ): void {
    this.emit({
      type: "CPU_AFFINITY_FAILURE",
      workloadId: workload.id,
      pid: workload.pid,
      previousPriority: workload.priority,
      priority: workload.priority,
      previousPool: workload.pool,
      pool: workload.pool,
      reason: "affinity_apply_failed_continuing_without_exit",
      ...(errorCode ? { errorCode } : {}),
    });
  }

  private isPidAuthorized(pid: number): boolean {
    try {
      return this.pidAuthorizer(pid) === true;
    } catch {
      return false;
    }
  }

  private rememberPriorityChange(
    previous: ManagedWorkloadSnapshot,
    current: ManagedWorkloadSnapshot,
    reason: string,
  ): void {
    if (previous.priority === current.priority) return;
    if (cpuPoolForPriority(current.priority) === current.pool) {
      this.pendingPriorityChanges.delete(current.id);
      return;
    }
    this.pendingPriorityChanges.set(current.id, {
      previous: previous.priority,
      reason,
    });
  }

  private requireSnapshot(workloadId: string): ManagedWorkloadSnapshot {
    const snapshot = this.scheduler.get(workloadId);
    if (!snapshot) throw new TypeError("CPU workload is not registered.");
    return snapshot;
  }

  private emit(
    event: Omit<CpuResourceEvent, "schemaVersion" | "timestamp">,
  ): void {
    try {
      this.eventSink(
        Object.freeze({
          schemaVersion: "1.0",
          timestamp: this.now().toISOString(),
          ...event,
        }),
      );
    } catch {
      // Resource telemetry must never make a Bot exit.
    }
  }
}

function migrationEventType(
  decision: RebalanceDecision,
): "CPU_PROMOTE" | "CPU_DEMOTE" | "CPU_REBALANCE" {
  const previous = poolRank(decision.previousPool);
  const target = poolRank(decision.targetPool);
  if (target > previous) return "CPU_PROMOTE";
  if (target < previous) return "CPU_DEMOTE";
  return "CPU_REBALANCE";
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
