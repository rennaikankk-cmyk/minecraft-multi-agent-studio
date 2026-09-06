// spark-strategy-v1/validator.ts —— 建议静态/快照验证器（纯函数）。
//
// 一期指令 §5：验证通过只表示建议满足当前快照约束，**不表示任务会成功**、
// 不表示可立即下发动作（任务仍活跃/阶段门未满足会在此拦下）。输出三态：
// acceptable（可继续评估）/ needs-reobservation（需重新观测或等待）/
// rejected（拒绝），全部带原因码与证据引用。

import { factVersion, type TeamFactsInput } from "./facts.js";
import type { TeamProposal } from "./proposal.js";

export type ValidatorReasonCode =
  | "SCOPE_MISMATCH"
  | "STALE_FACTS"
  | "EXPIRED_PROPOSAL"
  | "UNKNOWN_BOT"
  | "BOT_OFFLINE"
  | "UNSUPPORTED_CAPABILITY"
  | "UNSUPPORTED_GOAL_TEMPLATE"
  | "DUPLICATE_BOT_ASSIGNMENT"
  | "RESOURCE_DOUBLE_CLAIM"
  | "RESOURCE_CONFLICTS_RESERVATION"
  | "DEPENDENCY_CYCLE"
  | "DEPENDENCY_UNKNOWN_ID"
  | "PHASE_GATE_NOT_SATISFIED"
  | "PHASE_GATE_UNKNOWN"
  | "CONFLICTS_ACTIVE_TASK"
  | "UNKNOWN_FACT_SUCCESS_CLAIM"
  | "UNKNOWN_RESOURCE_REFERENCE"
  | "NO_OBSERVABLE_SUCCESS_SIGNAL"
  | "UNBOUNDED_RETRY";

export type ValidatorReason = {
  code: ValidatorReasonCode;
  message: string;
  /** 证据引用（assignmentId / 事实字段）。 */
  evidence?: string;
};

export type ValidationResult = {
  verdict: "acceptable" | "needs-reobservation" | "rejected";
  reasons: ValidatorReason[];
  /** 检查面（报告/测试断言用）。 */
  checks: Record<string, boolean>;
};

export type ValidatorOptions = {
  nowMs?: number;
  /** 确定性 goal 模板白名单（默认全部五个模板受支持）。 */
  supportedGoalTemplates?: ReadonlySet<string>;
};

const DEFAULT_TEMPLATES = new Set(["acquisition", "blueprint", "movement", "food", "scan"]);

/** 依赖环检测（DFS 三色）。 */
function findDependencyCycle(
  nodes: ReadonlySet<string>,
  edges: ReadonlyArray<{ afterId: string; beforeId: string }>,
): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) adjacency.set(edge.afterId, [...(adjacency.get(edge.afterId) ?? []), edge.beforeId]);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    const current = state.get(node) ?? 0;
    if (current === 1) {
      const cycleStart = stack.indexOf(node);
      return [...stack.slice(cycleStart === -1 ? 0 : cycleStart), node];
    }
    if (current === 2) return null;
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of nodes) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

export function validateProposal(
  proposal: TeamProposal,
  facts: TeamFactsInput,
  options: ValidatorOptions = {},
): ValidationResult {
  const nowMs = options.nowMs ?? Date.now();
  const templates = options.supportedGoalTemplates ?? DEFAULT_TEMPLATES;
  const reasons: ValidatorReason[] = [];
  const checks: Record<string, boolean> = {};

  const reject = (code: ValidatorReasonCode, message: string, evidence?: string) =>
    reasons.push({ code, message, ...(evidence !== undefined ? { evidence } : {}) });

  // 1) 作用域一致。
  checks.scopeMatch =
    proposal.scope.serverProfileId === facts.scope.serverProfileId &&
    proposal.scope.dimension === facts.scope.dimension;
  if (!checks.scopeMatch) {
    reject(
      "SCOPE_MISMATCH",
      `proposal scope ${proposal.scope.serverProfileId}/${proposal.scope.dimension} != facts scope ${facts.scope.serverProfileId}/${facts.scope.dimension}`,
    );
  }

  // 2) 事实版本与时效（版本由事实输入确定性计算）。
  const expectedVersion = factVersion(facts);
  checks.factVersionMatch = proposal.factVersion === expectedVersion;
  if (!checks.factVersionMatch) {
    reject("STALE_FACTS", `proposal factVersion=${proposal.factVersion} != current=${expectedVersion}`);
  }
  checks.notExpired = proposal.validUntilMs > nowMs;
  if (!checks.notExpired) {
    reject("EXPIRED_PROPOSAL", `validUntilMs=${proposal.validUntilMs} <= now=${nowMs}`);
  }

  const botById = new Map(facts.bots.map((bot) => [bot.botId, bot]));
  const gateByName = new Map(facts.constraints.phaseGates.map((gate) => [gate.gate, gate]));
  const supportedSkills = new Set(
    facts.constraints.capabilities.filter((c) => c.supported).map((c) => c.skillId),
  );

  // 3) Bot 引用与在线。
  checks.botsKnown = proposal.assignments.every((a) => botById.has(a.botId));
  // 4) 每个动作型 assignment 有可观察成功信号 + 有界重试。
  checks.observableSignals = proposal.assignments
    .filter((a) => a.action.kind === "skill" || a.action.kind === "deterministicGoal")
    .every((a) => a.successSignals.length > 0);
  checks.boundedRetry = proposal.assignments
    .filter((a) => a.action.kind === "skill" || a.action.kind === "deterministicGoal")
    .every((a) => a.maxAttempts !== undefined && a.maxAttempts >= 1);

  // 5) 互斥：同一 bot 至多一条动作型 assignment。
  const actionAssignments = proposal.assignments.filter(
    (a) => a.action.kind === "skill" || a.action.kind === "deterministicGoal",
  );
  const botCounts = new Map<string, number>();
  for (const assignment of actionAssignments) {
    botCounts.set(assignment.botId, (botCounts.get(assignment.botId) ?? 0) + 1);
  }
  checks.mutualExclusion = [...botCounts.values()].every((count) => count <= 1);

  // 6) 资源双占与预留冲突。
  const resourceOwners = new Map<string, string[]>();
  for (const assignment of actionAssignments) {
    for (const resource of assignment.resources) {
      resourceOwners.set(resource, [...(resourceOwners.get(resource) ?? []), assignment.assignmentId]);
    }
  }
  checks.noResourceDoubleClaim = [...resourceOwners.values()].every((owners) => owners.length <= 1);
  if (!checks.noResourceDoubleClaim) {
    for (const [resource, owners] of resourceOwners) {
      if (owners.length > 1) {
        reject("RESOURCE_DOUBLE_CLAIM", `resource claimed by ${owners.length} assignments`, resource);
      }
    }
  }
  const reservedByOthers = new Map(
    facts.team.reservedResources.map((r) => [r.resource, r.heldByBotId]),
  );
  const reservationConflict = actionAssignments.find((assignment) =>
    assignment.resources.some((resource) => {
      const holder = reservedByOthers.get(resource);
      return holder !== undefined && holder !== assignment.botId;
    }),
  );
  checks.noReservationConflict = reservationConflict === undefined;
  if (reservationConflict !== undefined) {
    reject(
      "RESOURCE_CONFLICTS_RESERVATION",
      `assignment claims a resource reserved by another bot`,
      `${reservationConflict.assignmentId}`,
    );
  }

  // 7) 依赖：引用存在 + 无环。
  const ids = new Set(proposal.assignments.map((a) => a.assignmentId));
  checks.dependenciesKnown = proposal.dependencies.every(
    (d) => ids.has(d.afterId) && ids.has(d.beforeId),
  );
  const cycle = findDependencyCycle(ids, proposal.dependencies);
  checks.noDependencyCycle = cycle === null;

  // 8) 逐 assignment 检查。
  const facilitiesKnown = facts.team.facilities !== "unknown" ? facts.team.facilities : null;
  const facilityIds = new Set(facilitiesKnown?.map((f) => f.facilityId) ?? []);
  let seenDuplicate = false;
  let seenOffline = false;
  let seenUnsupported = false;
  let seenGateIssue = false;
  let seenActiveConflict = false;
  let seenUnknownRef = false;
  for (const assignment of proposal.assignments) {
    const bot = botById.get(assignment.botId);
    if (bot === undefined) {
      reject("UNKNOWN_BOT", `assignment references unknown bot`, assignment.assignmentId);
      continue;
    }
    if (!bot.online) {
      seenOffline = true;
      reject("BOT_OFFLINE", `bot is offline`, `${assignment.assignmentId}:${assignment.botId}`);
    }
    // 活跃任务冲突：不可抢占 bot 已有任务 → 不得改派（生存抢占语义不动）。
    if (
      assignment.action.kind !== "noop" &&
      assignment.action.kind !== "wait" &&
      bot.currentTask !== null &&
      bot.currentTask !== "unknown" &&
      facts.constraints.nonPreemptibleBots.includes(assignment.botId)
    ) {
      seenActiveConflict = true;
      reject(
        "CONFLICTS_ACTIVE_TASK",
        `bot has active task "${bot.currentTask.goalText}" and is non-preemptible`,
        `${assignment.assignmentId}:${assignment.botId}`,
      );
    }
    // 能力存在性。
    if (assignment.action.kind === "skill") {
      if (!supportedSkills.has(assignment.action.skillId)) {
        seenUnsupported = true;
        reject(
          "UNSUPPORTED_CAPABILITY",
          `skillId not in supported capability catalog`,
          `${assignment.assignmentId}:${assignment.action.skillId}`,
        );
      }
    } else if (assignment.action.kind === "deterministicGoal") {
      if (!templates.has(assignment.action.template)) {
        seenUnsupported = true;
        reject(
          "UNSUPPORTED_GOAL_TEMPLATE",
          `goal template unsupported`,
          `${assignment.assignmentId}:${assignment.action.template}`,
        );
      }
    }
    // 阶段门。
    for (const gateName of assignment.requiredGates) {
      const gate = gateByName.get(gateName);
      if (gate === undefined || gate.satisfied === "unknown") {
        seenGateIssue = true;
        reject(
          gate === undefined ? "PHASE_GATE_NOT_SATISFIED" : "PHASE_GATE_UNKNOWN",
          gate === undefined ? `required gate not declared in facts` : `gate state unknown`,
          `${assignment.assignmentId}:${gateName}`,
        );
      } else if (gate.satisfied === false) {
        seenGateIssue = true;
        reject("PHASE_GATE_NOT_SATISFIED", `gate not satisfied`, `${assignment.assignmentId}:${gateName}`);
      }
    }
    // 资源/设施引用：facilityId 是不透明完整 id（含前缀）。设施已知（含
    // 空表）而 facility: 引用不在表内 → 未知引用；设施未知 → 需重观测。
    for (const resource of assignment.resources) {
      if (!resource.startsWith("facility:")) continue;
      if (facilitiesKnown === null) {
        seenUnknownRef = true;
        reject(
          "UNKNOWN_RESOURCE_REFERENCE",
          `facilities unknown; facility reference cannot be verified`,
          `${assignment.assignmentId}:${resource}`,
        );
      } else if (!facilityIds.has(resource)) {
        seenUnknownRef = true;
        reject(
          "UNKNOWN_RESOURCE_REFERENCE",
          `references facility absent from known facilities`,
          `${assignment.assignmentId}:${resource}`,
        );
      }
    }
  }
  if (!seenOffline) checks.botsKnown = checks.botsKnown && reasons.every((r) => r.code !== "UNKNOWN_BOT");
  checks.noUnsupportedCapability = !seenUnsupported;
  checks.noPhaseGateIssue = !seenGateIssue;
  checks.noActiveTaskConflict = !seenActiveConflict;
  checks.noUnknownFactReference = !seenUnknownRef;

  // 9) 重复 assignment（同 id / 同 bot 动作型重复）证据。
  const idCounts = new Map<string, number>();
  for (const assignment of proposal.assignments) {
    idCounts.set(assignment.assignmentId, (idCounts.get(assignment.assignmentId) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      seenDuplicate = true;
      reject("DUPLICATE_BOT_ASSIGNMENT", `assignmentId used ${count} times`, id);
    }
  }
  for (const [botId, count] of botCounts) {
    if (count > 1) {
      seenDuplicate = true;
      reject("DUPLICATE_BOT_ASSIGNMENT", `bot has ${count} action assignments`, botId);
    }
  }
  checks.mutualExclusion = checks.mutualExclusion && !seenDuplicate;

  // 10) 依赖 ID 未知补充证据。
  for (const dependency of proposal.dependencies) {
    if (!ids.has(dependency.afterId) || !ids.has(dependency.beforeId)) {
      reject("DEPENDENCY_UNKNOWN_ID", `dependency references unknown assignmentId`, `${dependency.afterId}->${dependency.beforeId}`);
    }
  }
  if (cycle !== null) {
    reject("DEPENDENCY_CYCLE", `dependency cycle: ${cycle.join(" -> ")}`);
  }

  // 汇总：静态硬错误（能力/结构/作用域/时效）→ rejected；需要更新事实
  // 才能安全的（离线 bot/未知门/未知设施引用）→ needs-reobservation。
  const hardCodes: ReadonlySet<ValidatorReasonCode> = new Set([
    "SCOPE_MISMATCH",
    "STALE_FACTS",
    "EXPIRED_PROPOSAL",
    "UNKNOWN_BOT",
    "UNSUPPORTED_CAPABILITY",
    "UNSUPPORTED_GOAL_TEMPLATE",
    "DUPLICATE_BOT_ASSIGNMENT",
    "RESOURCE_DOUBLE_CLAIM",
    "RESOURCE_CONFLICTS_RESERVATION",
    "DEPENDENCY_CYCLE",
    "DEPENDENCY_UNKNOWN_ID",
    "PHASE_GATE_NOT_SATISFIED",
    "CONFLICTS_ACTIVE_TASK",
    "UNKNOWN_FACT_SUCCESS_CLAIM",
    "NO_OBSERVABLE_SUCCESS_SIGNAL",
    "UNBOUNDED_RETRY",
  ]);
  // 成功信号/重试界检查（动作型缺信号/缺上限=拒绝）。
  for (const assignment of actionAssignments) {
    if (assignment.successSignals.length === 0) {
      reject("NO_OBSERVABLE_SUCCESS_SIGNAL", `action assignment lacks observable success signals`, assignment.assignmentId);
    }
    if (assignment.maxAttempts === undefined) {
      reject("UNBOUNDED_RETRY", `action assignment lacks maxAttempts bound`, assignment.assignmentId);
    }
  }
  checks.observableSignals = actionAssignments.every((a) => a.successSignals.length > 0);
  checks.boundedRetry = actionAssignments.every((a) => a.maxAttempts !== undefined && a.maxAttempts >= 1);

  const hardFailures = reasons.filter((r) => hardCodes.has(r.code));
  const softFailures = reasons.filter((r) => !hardCodes.has(r.code));
  const verdict: ValidationResult["verdict"] =
    hardFailures.length > 0 ? "rejected" : softFailures.length > 0 ? "needs-reobservation" : "acceptable";

  return { verdict, reasons, checks };
}
