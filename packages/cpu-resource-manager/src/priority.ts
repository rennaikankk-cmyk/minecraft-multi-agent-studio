import {
  BotState,
  CpuPriority,
  DeploymentTier,
  type WorkloadKind,
} from "./types.js";

export const defaultBotStatePriorities: Readonly<Record<BotState, CpuPriority>> = Object.freeze({
  [BotState.IDLE]: CpuPriority.BACKGROUND,
  [BotState.CHAT]: CpuPriority.LOW,
  [BotState.TRAVEL]: CpuPriority.NORMAL,
  [BotState.MINING]: CpuPriority.NORMAL,
  [BotState.BUILDING]: CpuPriority.HIGH,
  [BotState.PATHFINDING]: CpuPriority.HIGH,
  [BotState.COMBAT]: CpuPriority.REALTIME,
  [BotState.CRYSTAL_PVP]: CpuPriority.CRITICAL,
  [BotState.ESCAPE]: CpuPriority.CRITICAL,
  [BotState.RECOVERY]: CpuPriority.HIGH,
  [BotState.TESTING]: CpuPriority.LOW,
});

const PRIORITY_RANK: Readonly<Record<CpuPriority, number>> = Object.freeze({
  [CpuPriority.BACKGROUND]: 0,
  [CpuPriority.LOW]: 1,
  [CpuPriority.NORMAL]: 2,
  [CpuPriority.HIGH]: 3,
  [CpuPriority.REALTIME]: 4,
  [CpuPriority.CRITICAL]: 5,
});

const TIER_RANK: Readonly<Record<DeploymentTier, number>> = Object.freeze({
  [DeploymentTier.BATCH]: 0,
  [DeploymentTier.TEST]: 1,
  [DeploymentTier.CANARY]: 2,
  [DeploymentTier.PRODUCTION]: 3,
});

const DEFAULT_KIND_PRIORITY: Readonly<Record<WorkloadKind, CpuPriority>> =
  Object.freeze({
    "minecraft-bot": CpuPriority.NORMAL,
    pathfinder: CpuPriority.HIGH,
    combat: CpuPriority.REALTIME,
    coordinator: CpuPriority.NORMAL,
    database: CpuPriority.LOW,
    redis: CpuPriority.LOW,
    bullmq: CpuPriority.LOW,
    web: CpuPriority.LOW,
    logging: CpuPriority.BACKGROUND,
    monitoring: CpuPriority.BACKGROUND,
    rag: CpuPriority.BACKGROUND,
    "skill-test": CpuPriority.LOW,
    batch: CpuPriority.BACKGROUND,
    generic: CpuPriority.NORMAL,
  });

export function cpuPriorityForBotState(
  state: BotState,
  priorities: Readonly<Record<BotState, CpuPriority>> = defaultBotStatePriorities,
): CpuPriority {
  return priorities[state];
}

export function defaultCpuPriorityForWorkload(
  kind: WorkloadKind,
): CpuPriority {
  return DEFAULT_KIND_PRIORITY[kind];
}

export function cpuPriorityRank(priority: CpuPriority): number {
  return PRIORITY_RANK[priority];
}

export function deploymentTierRank(tier: DeploymentTier): number {
  return TIER_RANK[tier];
}

export function compareWorkloadImportance(
  left: Readonly<{ deploymentTier: DeploymentTier; priority: CpuPriority }>,
  right: Readonly<{ deploymentTier: DeploymentTier; priority: CpuPriority }>,
): number {
  const tierDifference =
    deploymentTierRank(left.deploymentTier) -
    deploymentTierRank(right.deploymentTier);
  return tierDifference !== 0
    ? tierDifference
    : cpuPriorityRank(left.priority) - cpuPriorityRank(right.priority);
}
