// ---------------------------------------------------------------------------
// WorkstationCreationPolicy + CapacityPlanner
//
// 职责分离：
//   WorkstationRegistry: 有什么工作站、在哪里、是否还存在
//   CapacityPlanner:     是否值得增加新的工作站（收益判断）
//
// P0-5: busy ≠ not_found——已有 furnace 被占用时返回 busy，
// CapacityPlanner 决定等待还是扩容。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Creation Policy
// ---------------------------------------------------------------------------

export type WorkstationCreationPolicy =
  | "reuse_only"       // 附近有就复用，绝对不新建
  | "reuse_preferred"  // 优先复用，没有才新建（crafting_table 默认）
  | "scale_out";       // 有收益时主动扩容（furnace/blast_furnace 默认）

export function creationPolicyFor(type: string): WorkstationCreationPolicy {
  if (type === "furnace" || type === "blast_furnace" || type === "smoker") return "scale_out";
  return "reuse_preferred";
}

// ---------------------------------------------------------------------------
// Capacity Assessment
// ---------------------------------------------------------------------------

export type CapacityDecision =
  | Readonly<{
      decision: "reuse";
      entry: { position: { x: number; y: number; z: number }; type: string };
      reason: string;
    }>
  | Readonly<{
      decision: "wait";
      entry: { position: { x: number; y: number; z: number }; type: string };
      reason: string;
      estimatedWaitMs: number;
    }>
  | Readonly<{
      decision: "scale_out";
      reason: string;
      pendingItems: number;
      availableWorkstations: number;
      busyWorkstations: number;
      estimatedWaitMs: number;
    }>
  | Readonly<{
      decision: "create_first";
      reason: string;
    }>;

export interface CapacityPlannerInput {
  readonly policy: WorkstationCreationPolicy;
  /** 已知工作站数。 */
  readonly totalWorkstations: number;
  /** 其中 busy（被 lease 占用）数。 */
  readonly busyWorkstations: number;
  /** 待处理工作量（如待熔炼物品数）。 */
  readonly pendingItems: number;
  /** 每个工作站每分钟处理量。 */
  readonly throughputPerWorkstationPerMin: number;
}

/**
 * 确定性产能判断——LLM 不参与。
 *
 * scale_out 条件（全部满足）：
 *   1. policy 允许 scale_out
 *   2. busy 工作站 >= total（全部忙）
 *   3. 预估等待时间 > 阈值（新做一台比等更快）
 */
export function assessCapacity(input: CapacityPlannerInput): CapacityDecision {
  const { policy, totalWorkstations, busyWorkstations, pendingItems, throughputPerWorkstationPerMin } = input;

  if (totalWorkstations === 0) {
    return { decision: "create_first", reason: "no existing workstations" };
  }

  const free = totalWorkstations - busyWorkstations;
  if (free > 0) {
    // 有空闲工作站 → 复用
    return {
      decision: "reuse",
      reason: `${free} of ${totalWorkstations} available`,
      entry: { position: { x: 0, y: 0, z: 0 }, type: "" }, // caller fills actual
    };
  }

  // 全部忙
  const queuePerStation = Math.ceil(pendingItems / totalWorkstations);
  const estimatedWaitMs = Math.ceil((queuePerStation / throughputPerWorkstationPerMin) * 60_000);

  if (policy === "reuse_only") {
    return {
      decision: "wait",
      reason: "policy=reuse_only, all workstations busy",
      entry: { position: { x: 0, y: 0, z: 0 }, type: "" },
      estimatedWaitMs,
    };
  }

  // scale_out: 新建一台比等待更快
  const scaleOutThresholdMs = 60_000; // 等待超过 1 分钟 → 值得扩容
  if (policy === "scale_out" && estimatedWaitMs > scaleOutThresholdMs) {
    return {
      decision: "scale_out",
      reason: `pendingItems=${pendingItems} allBusy=${busyWorkstations}/${totalWorkstations} estWaitMs=${estimatedWaitMs} > ${scaleOutThresholdMs}ms`,
      pendingItems,
      availableWorkstations: free,
      busyWorkstations,
      estimatedWaitMs,
    };
  }

  // 等待更划算
  return {
    decision: "wait",
    reason: `estWaitMs=${estimatedWaitMs} <= ${scaleOutThresholdMs}ms threshold`,
    entry: { position: { x: 0, y: 0, z: 0 }, type: "" },
    estimatedWaitMs,
  };
}
