import { randomUUID } from "node:crypto";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  skillInvocationV1Schema,
  type SkillExecutionResultV1,
  type SkillInvocationV1,
} from "@minecraft-studio/protocol";

import type { CoordinatorPlanProposal } from "./ai-planner.js";
import type { BotRegistry } from "./bot-registry.js";
import type { SkillCommandAuthorizationContext } from "./runtime-link-server.js";

const RISK_ORDER = ["R0", "R1", "R2", "R3", "R4"] as const;
const DEFAULT_SKILL_RISKS = new Map<string, SkillRiskLevel>([
  ["movement.goto", "R1"],
  ["inventory.equip-armor", "R1"],
  ["collect.block", "R1"],
  ["craft.item", "R1"],
  ["place.block", "R1"],
  ["container.transfer", "R1"],
  ["smelt.item", "R1"],
  ["survival.consume-food", "R1"],
  ["survival.sleep", "R1"],
  ["inventory.compact", "R1"],
  ["movement.recover", "R1"],
  ["combat.pve-melee", "R1"],
  ["combat.pvp-melee", "R3"],
]);

export type SkillRiskLevel = (typeof RISK_ORDER)[number];

export type SkillInvocationGrant = Readonly<{
  decisionId: string;
  actorId: string;
  permissions: ReadonlySet<"skill.invoke">;
  maxRisk: SkillRiskLevel;
  issuedAt: Date;
  expiresAt: Date;
}>;

export type SkillInvocationTransport = Readonly<{
  sendSkillInvocation(
    command: SkillInvocationV1,
    authorizationContext: SkillCommandAuthorizationContext,
    signal: AbortSignal,
  ): Promise<SkillExecutionResultV1>;
}>;

export type SkillInvocationPolicyInput = Readonly<{
  actorId: string;
  botId: string;
  taskId: string;
  skillId: string;
  skillVersion: string;
  riskLevel: SkillRiskLevel;
  maxRisk: SkillRiskLevel;
}>;

export type SkillInvocationPolicy = Readonly<{
  authorize(input: SkillInvocationPolicyInput): boolean;
}>;

export type SkillInvocationAuditStatus =
  | "authorized"
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled";

export type SkillInvocationAuditEntry = Readonly<{
  timestamp: string;
  status: SkillInvocationAuditStatus;
  decisionId: string;
  actorId: string;
  requestId: string;
  invocationId: string;
  traceId: string;
  taskId: string;
  taskVersion: number;
  stateVersion: number;
  botId: string;
  runtimeInstanceId: string;
  skillId: string;
  skillVersion: string;
  riskLevel: SkillRiskLevel;
  outcome: SkillExecutionResultV1["payload"]["outcome"] | null;
  errorCode: string | null;
}>;

export type SkillInvocationAuditSink = Readonly<{
  append(entry: SkillInvocationAuditEntry): void | Promise<void>;
}>;

export class InMemorySkillInvocationAuditSink
  implements SkillInvocationAuditSink
{
  private readonly values: SkillInvocationAuditEntry[] = [];

  append(entry: SkillInvocationAuditEntry): void {
    this.values.push(structuredClone(entry));
  }

  entries(): readonly SkillInvocationAuditEntry[] {
    return structuredClone(this.values);
  }
}

export type SkillInvocationControllerErrorCode =
  | "AUTHORIZATION_REJECTED"
  | "POLICY_DENIED"
  | "BOT_NOT_EXECUTABLE"
  | "PROPOSAL_STALE"
  | "SKILL_NOT_AVAILABLE"
  | "TASK_VERSION_STALE"
  | "BOT_SKILL_BUSY";

export class SkillInvocationControllerError extends Error {
  readonly code: SkillInvocationControllerErrorCode;

  constructor(code: SkillInvocationControllerErrorCode, message: string) {
    super(message);
    this.name = "SkillInvocationControllerError";
    this.code = code;
  }
}

export type SkillInvocationControllerOptions = Readonly<{
  instanceId: string;
  registry: BotRegistry;
  transport: SkillInvocationTransport;
  auditSink: SkillInvocationAuditSink;
  logger: AppLogger;
  policy?: SkillInvocationPolicy;
  skillRisks?: ReadonlyMap<string, SkillRiskLevel>;
  invocationTimeoutMs?: number;
  now?: () => Date;
  randomId?: () => string;
}>;

type ExecutableProposal = Extract<
  CoordinatorPlanProposal,
  { action: "execute_skill" }
>;

type ActiveExecution = Readonly<{
  requestId: string;
  taskVersion: number;
  controller: AbortController;
}>;

export class DefaultSkillInvocationPolicy implements SkillInvocationPolicy {
  authorize(input: SkillInvocationPolicyInput): boolean {
    return riskAtMost(input.riskLevel, input.maxRisk);
  }
}

export class SkillInvocationController {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly policy: SkillInvocationPolicy;
  private readonly skillRisks: ReadonlyMap<string, SkillRiskLevel>;
  private readonly invocationTimeoutMs: number;
  private readonly taskVersions = new Map<string, number>();
  private readonly active = new Map<string, ActiveExecution>();
  private readonly executions = new Map<
    string,
    { fingerprint: string; result: Promise<SkillExecutionResultV1> }
  >();

  constructor(private readonly options: SkillInvocationControllerOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.policy = options.policy ?? new DefaultSkillInvocationPolicy();
    this.skillRisks = options.skillRisks ?? DEFAULT_SKILL_RISKS;
    this.invocationTimeoutMs = boundedInteger(
      options.invocationTimeoutMs ?? 60_000,
      1_000,
      5 * 60_000,
      "invocationTimeoutMs",
    );
  }

  executeProposal(
    proposal: ExecutableProposal,
    grant: SkillInvocationGrant,
    externalSignal?: AbortSignal,
  ): Promise<SkillExecutionResultV1> {
    const fingerprint = JSON.stringify({ proposal, grant: grantFingerprint(grant) });
    const existing = this.executions.get(proposal.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new SkillInvocationControllerError(
          "PROPOSAL_STALE",
          "The AI request ID was already executed with different parameters.",
        );
      }
      return existing.result;
    }

    const result = this.executeOnce(proposal, grant, externalSignal);
    this.executions.set(proposal.requestId, { fingerprint, result });
    void result.finally(() => this.trimExecutions()).catch(() => undefined);
    return result;
  }

  private async executeOnce(
    proposal: ExecutableProposal,
    grant: SkillInvocationGrant,
    externalSignal?: AbortSignal,
  ): Promise<SkillExecutionResultV1> {
    const now = validNow(this.now());
    validateGrant(grant, now);
    const taskId = proposal.taskId ?? proposal.requestId;
    const record = this.options.registry.get(proposal.botId, now);
    if (
      !record ||
      record.connectionState !== "online" ||
      record.currentStatus === null ||
      record.skillCatalog === null ||
      record.currentStatus.safety?.normalTasksPaused === true
    ) {
      throw new SkillInvocationControllerError(
        "BOT_NOT_EXECUTABLE",
        "Bot must have live status and a compatible skill catalog before execution.",
      );
    }
    if (
      record.runtimeInstanceId !== proposal.runtimeInstanceId ||
      record.currentStatus.runtimeInstanceId !== proposal.runtimeInstanceId ||
      record.currentStatus.sequence !== proposal.stateVersion
    ) {
      throw new SkillInvocationControllerError(
        "PROPOSAL_STALE",
        "Bot runtime or state changed after the AI proposal was created.",
      );
    }
    const selected = record.skillCatalog.skills.find(
      (skill) =>
        skill.skillId === proposal.skillId &&
        skill.skillVersion === proposal.skillVersion &&
        skill.selectedVariantId === proposal.selectedVariantId &&
        skill.availability === "available",
    );
    if (!selected) {
      throw new SkillInvocationControllerError(
        "SKILL_NOT_AVAILABLE",
        "The proposed skill is not in the Runtime's current compatible catalog.",
      );
    }

    const previousTaskVersion = this.taskVersions.get(proposal.botId) ?? 0;
    if (proposal.taskVersion < previousTaskVersion) {
      throw new SkillInvocationControllerError(
        "TASK_VERSION_STALE",
        "The proposal belongs to an obsolete task version.",
      );
    }
    const current = this.active.get(proposal.botId);
    if (current && current.requestId !== proposal.requestId) {
      if (proposal.taskVersion <= current.taskVersion) {
        throw new SkillInvocationControllerError(
          "BOT_SKILL_BUSY",
          "The Bot already has an active skill for this task version.",
        );
      }
      current.controller.abort("newer_task_version");
    }

    const riskLevel = this.skillRisks.get(proposal.skillId);
    if (!riskLevel) {
      throw new SkillInvocationControllerError(
        "POLICY_DENIED",
        "No deterministic risk policy exists for the proposed skill.",
      );
    }
    if (!this.policy.authorize({
      actorId: grant.actorId,
      botId: proposal.botId,
      taskId,
      skillId: proposal.skillId,
      skillVersion: proposal.skillVersion,
      riskLevel,
      maxRisk: grant.maxRisk,
    })) {
      throw new SkillInvocationControllerError(
        "POLICY_DENIED",
        "The deterministic policy denied this skill invocation.",
      );
    }

    this.taskVersions.set(proposal.botId, proposal.taskVersion);
    const invocationId = this.randomId();
    const expiresAt = new Date(
      Math.min(grant.expiresAt.getTime(), now.getTime() + this.invocationTimeoutMs),
    );
    const command = skillInvocationV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      traceId: proposal.requestId,
      timestamp: now.toISOString(),
      source: { service: "coordinator", instanceId: this.options.instanceId },
      botId: proposal.botId,
      taskId,
      type: "skill.invoke.v1",
      payload: {
        invocationId,
        skillId: proposal.skillId,
        skillVersion: proposal.skillVersion,
        expectedRuntimeInstanceId: proposal.runtimeInstanceId,
        expectedStateSequence: proposal.stateVersion,
        taskVersion: proposal.taskVersion,
        expiresAt: expiresAt.toISOString(),
        input: structuredClone(proposal.arguments),
        authorization: {
          decisionId: grant.decisionId,
          actorId: grant.actorId,
          issuedAt: grant.issuedAt.toISOString(),
          expiresAt: grant.expiresAt.toISOString(),
        },
      },
    });
    const controller = new AbortController();
    const cancelExternal = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", cancelExternal, { once: true });
    if (externalSignal?.aborted) cancelExternal();
    const timeout = setTimeout(
      () => controller.abort("skill_invocation_timeout"),
      this.invocationTimeoutMs,
    );
    timeout.unref?.();
    this.active.set(proposal.botId, {
      requestId: proposal.requestId,
      taskVersion: proposal.taskVersion,
      controller,
    });

    const baseAudit = {
      decisionId: grant.decisionId,
      actorId: grant.actorId,
      requestId: proposal.requestId,
      invocationId,
      traceId: command.traceId,
      taskId,
      taskVersion: proposal.taskVersion,
      stateVersion: proposal.stateVersion,
      botId: proposal.botId,
      runtimeInstanceId: proposal.runtimeInstanceId,
      skillId: proposal.skillId,
      skillVersion: proposal.skillVersion,
      riskLevel,
    } as const;
    await this.audit({
      ...baseAudit,
      timestamp: now.toISOString(),
      status: "authorized",
      outcome: null,
      errorCode: null,
    });
    this.options.logger.info("coordinator_skill_authorized", {
      traceId: command.traceId,
      taskId,
      botId: proposal.botId,
      skillId: proposal.skillId,
      modelName: proposal.model,
      invocationId,
      decisionId: grant.decisionId,
      riskLevel,
    });

    try {
      const result = await this.options.transport.sendSkillInvocation(
        command,
        {
          decisionId: grant.decisionId,
          actorId: grant.actorId,
          botId: proposal.botId,
          taskId,
          invocationId,
          skillId: proposal.skillId,
          skillVersion: proposal.skillVersion,
          permissions: grant.permissions,
          now,
        },
        controller.signal,
      );
      const errorCode = "errorCode" in result.payload
        ? result.payload.errorCode
        : null;
      await this.audit({
        ...baseAudit,
        timestamp: validNow(this.now()).toISOString(),
        status: result.payload.outcome === "completed" ? "completed" : "rejected",
        outcome: result.payload.outcome,
        errorCode,
      });
      return result;
    } catch (cause) {
      await this.audit({
        ...baseAudit,
        timestamp: validNow(this.now()).toISOString(),
        status: controller.signal.aborted ? "cancelled" : "failed",
        outcome: null,
        errorCode: errorCode(cause),
      });
      throw cause;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", cancelExternal);
      if (this.active.get(proposal.botId)?.requestId === proposal.requestId) {
        this.active.delete(proposal.botId);
      }
    }
  }

  private async audit(entry: SkillInvocationAuditEntry): Promise<void> {
    await this.options.auditSink.append(Object.freeze(entry));
  }

  private trimExecutions(): void {
    while (this.executions.size > 1_024) {
      const oldest = this.executions.keys().next().value as string | undefined;
      if (!oldest) return;
      this.executions.delete(oldest);
    }
  }
}

function validateGrant(grant: SkillInvocationGrant, now: Date): void {
  if (
    !grant.permissions.has("skill.invoke") ||
    !RISK_ORDER.includes(grant.maxRisk) ||
    !Number.isFinite(grant.issuedAt.getTime()) ||
    !Number.isFinite(grant.expiresAt.getTime()) ||
    grant.issuedAt.getTime() > now.getTime() ||
    grant.expiresAt.getTime() <= now.getTime()
  ) {
    throw new SkillInvocationControllerError(
      "AUTHORIZATION_REJECTED",
      "Skill invocation authorization is invalid or expired.",
    );
  }
}

function riskAtMost(actual: SkillRiskLevel, maximum: SkillRiskLevel): boolean {
  return RISK_ORDER.indexOf(actual) <= RISK_ORDER.indexOf(maximum);
}

function grantFingerprint(grant: SkillInvocationGrant): unknown {
  return {
    decisionId: grant.decisionId,
    actorId: grant.actorId,
    permissions: [...grant.permissions].sort(),
    maxRisk: grant.maxRisk,
    issuedAt: grant.issuedAt.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
  };
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Skill invocation clock is invalid.");
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside its safe boundary.`);
  }
  return value;
}

function errorCode(cause: unknown): string {
  return cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : "SKILL_INVOCATION_FAILED";
}
