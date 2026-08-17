import {
  recommendRuntimeSizing,
  type CpuTopology,
  type RuntimeSizingRecommendation,
} from "@minecraft-studio/cpu-resource-manager";
import type { SupervisorDeploymentTier } from "@minecraft-studio/protocol";

import type {
  BotSupervisorConfig,
  BotSupervisorRestartConfig,
  ResolvedSupervisorBot,
} from "./supervisor-config.js";

export type BotProcessGroupPlan = Readonly<{
  id: string;
  deploymentTier: SupervisorDeploymentTier;
  bots: readonly ResolvedSupervisorBot[];
}>;

export type BotSupervisorPlan = Readonly<{
  schemaVersion: "1.0";
  effectiveBotsPerProcess: number;
  groups: readonly BotProcessGroupPlan[];
  recommendation: RuntimeSizingRecommendation;
  warnings: readonly string[];
}>;

const deploymentOrder: readonly SupervisorDeploymentTier[] = [
  "production",
  "canary",
  "test",
  "batch",
];

export function createBotSupervisorPlan(
  config: BotSupervisorConfig,
  topology: CpuTopology,
): BotSupervisorPlan {
  const recommendation = recommendRuntimeSizing(topology, {
    desiredBots: config.bots.length,
  });
  const effectiveBotsPerProcess = config.process.autoSize
    ? recommendation.botsPerProcess
    : config.process.botsPerProcess;
  const groups: BotProcessGroupPlan[] = [];

  for (const tier of deploymentOrder) {
    const tierBots = config.bots.filter(
      (bot) => bot.assignment.deploymentTier === tier,
    );
    for (let offset = 0; offset < tierBots.length; offset += effectiveBotsPerProcess) {
      const index = Math.floor(offset / effectiveBotsPerProcess) + 1;
      groups.push(
        Object.freeze({
          id: `bot-group-${tier}-${String(index).padStart(3, "0")}`,
          deploymentTier: tier,
          bots: Object.freeze(tierBots.slice(offset, offset + effectiveBotsPerProcess)),
        }),
      );
    }
  }

  const warnings = [...config.warnings];
  if (recommendation.constrained) {
    warnings.push(...recommendation.reasons.map((reason) => `hardware_${reason}`));
  }
  if (groups.length > recommendation.botProcesses) {
    warnings.push("planned_processes_exceed_hardware_recommendation");
  }

  return Object.freeze({
    schemaVersion: "1.0",
    effectiveBotsPerProcess,
    groups: Object.freeze(groups),
    recommendation,
    warnings: Object.freeze([...new Set(warnings)]),
  });
}

export type RestartDecision = Readonly<{
  allowed: boolean;
  attempt: number;
  delayMs: number | null;
  reason: "restart_scheduled" | "restart_disabled" | "restart_budget_exhausted";
}>;

export class RestartBudget {
  private failures: number[] = [];

  constructor(
    private readonly config: BotSupervisorRestartConfig,
    private readonly random: () => number = Math.random,
  ) {}

  recordFailure(nowMs: number, readyAtMs: number | null): RestartDecision {
    if (!Number.isFinite(nowMs)) throw new TypeError("重启时钟无效。");
    if (
      readyAtMs !== null &&
      nowMs - readyAtMs >= this.config.stableAfterMs
    ) {
      this.failures = [];
    }
    this.failures = this.failures.filter(
      (timestamp) => nowMs - timestamp <= this.config.windowMs,
    );
    if (this.config.maxAttempts === 0) {
      return Object.freeze({
        allowed: false,
        attempt: 0,
        delayMs: null,
        reason: "restart_disabled",
      });
    }
    if (this.failures.length >= this.config.maxAttempts) {
      return Object.freeze({
        allowed: false,
        attempt: this.failures.length,
        delayMs: null,
        reason: "restart_budget_exhausted",
      });
    }

    this.failures.push(nowMs);
    const attempt = this.failures.length;
    const exponential = Math.min(
      this.config.maxDelayMs,
      this.config.baseDelayMs * 2 ** (attempt - 1),
    );
    const normalizedRandom = Math.max(0, Math.min(1, this.random()));
    const jitter = 0.9 + normalizedRandom * 0.2;
    return Object.freeze({
      allowed: true,
      attempt,
      delayMs: Math.max(1, Math.round(exponential * jitter)),
      reason: "restart_scheduled",
    });
  }
}
