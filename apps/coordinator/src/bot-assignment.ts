import { randomUUID } from "node:crypto";

import {
  identifierSchema,
  skillIdentifierSchema,
  skillVersionSchema,
} from "@minecraft-studio/protocol";
import type { BotRegistry, BotRegistryRecord } from "./bot-registry.js";
import { z } from "zod";

const MAX_REQUIRED_SKILLS = 64;
const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 10 * 60_000;
const DEFAULT_LEASE_TTL_MS = 30_000;
const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);
const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

const assignmentSkillRequirementSchema = z
  .object({
    skillId: skillIdentifierSchema,
    // A null version means any available version from the current catalog.
    skillVersion: skillVersionSchema.nullable(),
  })
  .strict();

export const botAssignmentRequestSchema = z
  .object({
    taskId: identifierSchema,
    serverProfileId: identifierSchema,
    dimension: dimensionSchema.nullable().default(null),
    requiredSkills: z
      .array(assignmentSkillRequirementSchema)
      .max(MAX_REQUIRED_SKILLS)
      .superRefine((requirements, context) => {
        const seen = new Set<string>();
        for (const [index, requirement] of requirements.entries()) {
          const key = `${requirement.skillId}@${requirement.skillVersion ?? "*"}`;
          if (seen.has(key)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "Required Skills must be unique.",
            });
          }
          seen.add(key);
        }
      }),
    preferredBotId: identifierSchema.nullable().default(null),
    leaseTtlMs: z
      .number()
      .int()
      .min(MIN_LEASE_TTL_MS)
      .max(MAX_LEASE_TTL_MS)
      .optional(),
  })
  .strict();

const assignmentScoreBreakdownSchema = z
  .object({
    health: z.number().int().min(0).max(400),
    food: z.number().int().min(0).max(250),
    armor: z.number().int().min(0).max(200),
    latency: z.number().int().min(0).max(150),
  })
  .strict();

export const botAssignmentLeaseSchema = z
  .object({
    leaseId: z.string().uuid(),
    taskId: identifierSchema,
    botId: identifierSchema,
    runtimeInstanceId: identifierSchema,
    serverProfileId: identifierSchema,
    dimension: dimensionSchema.nullable(),
    requiredSkills: z.array(assignmentSkillRequirementSchema).max(MAX_REQUIRED_SKILLS),
    acquiredAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    score: z.number().int().min(0).max(1_000),
    scoreBreakdown: assignmentScoreBreakdownSchema,
  })
  .strict();

export type BotAssignmentSkillRequirement = z.infer<
  typeof assignmentSkillRequirementSchema
>;
export type BotAssignmentRequest = z.infer<typeof botAssignmentRequestSchema>;
export type BotAssignmentScoreBreakdown = z.infer<
  typeof assignmentScoreBreakdownSchema
>;
export type BotAssignmentLease = z.infer<typeof botAssignmentLeaseSchema>;

export type BotAssignmentCandidate = Readonly<{
  botId: string;
  runtimeInstanceId: string;
  serverProfileId: string;
  score: number;
  scoreBreakdown: BotAssignmentScoreBreakdown;
}>;

export type BotAssignmentReconcileResult = Readonly<{
  expiredLeaseIds: readonly string[];
  releasedLeaseIds: readonly string[];
}>;

export type BotAssignmentEvent = Readonly<{
  type: "acquired" | "renewed" | "released" | "expired" | "unavailable";
  leaseId: string;
  taskId: string;
  botId: string;
  runtimeInstanceId: string;
}>;

export type BotAssignmentErrorCode =
  | "ASSIGNMENT_REQUEST_INVALID"
  | "ASSIGNMENT_TASK_CONFLICT"
  | "ASSIGNMENT_NO_ELIGIBLE_BOT"
  | "ASSIGNMENT_PREFERRED_BOT_UNAVAILABLE"
  | "ASSIGNMENT_PREFERRED_BOT_BUSY"
  | "ASSIGNMENT_LEASE_NOT_FOUND"
  | "ASSIGNMENT_LEASE_EXPIRED"
  | "ASSIGNMENT_LEASE_UNAVAILABLE";

export class BotAssignmentError extends Error {
  readonly code: BotAssignmentErrorCode;

  constructor(code: BotAssignmentErrorCode, message: string) {
    super(message);
    this.name = "BotAssignmentError";
    this.code = code;
  }
}

export type BotAssignmentServiceOptions = Readonly<{
  registry: Pick<BotRegistry, "list" | "get">;
  now?: () => Date;
  randomId?: () => string;
  defaultLeaseTtlMs?: number;
  onEvent?: (event: BotAssignmentEvent) => void;
}>;

type NormalizedRequest = Omit<BotAssignmentRequest, "requiredSkills" | "leaseTtlMs"> & {
  requiredSkills: readonly BotAssignmentSkillRequirement[];
  leaseTtlMs: number;
};

type InternalLease = BotAssignmentLease & {
  fingerprint: string;
};

/**
 * In-process assignment boundary for Coordinator. It is deliberately
 * deterministic and fail-closed; a durable task lease remains the authority
 * for work that must survive a Coordinator restart.
 */
export class BotAssignmentService {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly defaultLeaseTtlMs: number;
  private readonly leasesById = new Map<string, InternalLease>();
  private readonly leaseIdByTask = new Map<string, string>();
  private readonly leaseIdByBot = new Map<string, string>();

  constructor(private readonly options: BotAssignmentServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.defaultLeaseTtlMs = boundedInteger(
      options.defaultLeaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      MIN_LEASE_TTL_MS,
      MAX_LEASE_TTL_MS,
      "defaultLeaseTtlMs",
    );
  }

  rank(input: unknown, at = this.now()): readonly BotAssignmentCandidate[] {
    const request = this.parseRequest(input);
    const now = validDate(at);
    this.reconcile(now);
    return this.rankRequest(request, now).map((candidate) => ({ ...candidate }));
  }

  acquire(input: unknown, at = this.now()): BotAssignmentLease {
    const request = this.parseRequest(input);
    const now = validDate(at);
    this.reconcile(now);

    const existingId = this.leaseIdByTask.get(request.taskId);
    if (existingId) {
      const existing = this.leasesById.get(existingId);
      if (!existing) {
        this.leaseIdByTask.delete(request.taskId);
      } else if (existing.fingerprint === fingerprint(request)) {
        return cloneLease(existing);
      } else {
        throw new BotAssignmentError(
          "ASSIGNMENT_TASK_CONFLICT",
          "The task already has an assignment with different constraints.",
        );
      }
    }

    const candidates = this.rankRequest(request, now);
    if (candidates.length === 0) {
      if (request.preferredBotId) {
        const preferred = this.options.registry.get(request.preferredBotId, now);
        if (this.leaseIdByBot.has(request.preferredBotId)) {
          throw new BotAssignmentError(
            "ASSIGNMENT_PREFERRED_BOT_BUSY",
            "The preferred Bot already owns an active assignment.",
          );
        }
        if (!preferred || !this.isEligible(preferred, request)) {
          throw new BotAssignmentError(
            "ASSIGNMENT_PREFERRED_BOT_UNAVAILABLE",
            "The preferred Bot is not eligible for this assignment.",
          );
        }
      }
      throw new BotAssignmentError(
        "ASSIGNMENT_NO_ELIGIBLE_BOT",
        "No eligible Bot is available for this assignment.",
      );
    }

    const selected = candidates[0]!;
    const expiresAt = new Date(
      now.getTime() + request.leaseTtlMs,
    );
    const lease = botAssignmentLeaseSchema.parse({
      leaseId: this.randomId(),
      taskId: request.taskId,
      botId: selected.botId,
      runtimeInstanceId: selected.runtimeInstanceId,
      serverProfileId: selected.serverProfileId,
      dimension: request.dimension,
      requiredSkills: request.requiredSkills,
      acquiredAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      score: selected.score,
      scoreBreakdown: selected.scoreBreakdown,
    });
    const internal: InternalLease = {
      ...lease,
      fingerprint: fingerprint(request),
    };
    this.leasesById.set(lease.leaseId, internal);
    this.leaseIdByTask.set(lease.taskId, lease.leaseId);
    this.leaseIdByBot.set(lease.botId, lease.leaseId);
    this.emit({ type: "acquired", lease });
    return cloneLease(lease);
  }

  renew(
    leaseId: string,
    leaseTtlMs = this.defaultLeaseTtlMs,
    at = this.now(),
  ): BotAssignmentLease {
    const now = validDate(at);
    const lease = this.leasesById.get(leaseId);
    if (!lease) {
      throw new BotAssignmentError(
        "ASSIGNMENT_LEASE_NOT_FOUND",
        "The assignment lease does not exist.",
      );
    }
    if (Date.parse(lease.expiresAt) <= now.getTime()) {
      this.removeLease(lease, "expired");
      throw new BotAssignmentError(
        "ASSIGNMENT_LEASE_EXPIRED",
        "The assignment lease has expired.",
      );
    }
    let parsedTtl: number;
    try {
      parsedTtl = boundedInteger(
        leaseTtlMs,
        MIN_LEASE_TTL_MS,
        MAX_LEASE_TTL_MS,
        "leaseTtlMs",
      );
    } catch {
      throw new BotAssignmentError(
        "ASSIGNMENT_REQUEST_INVALID",
        "Assignment lease duration failed bounded validation.",
      );
    }
    const request = this.requestFromLease(lease, parsedTtl);
    const record = this.options.registry.get(lease.botId, now);
    if (!record || record.runtimeInstanceId !== lease.runtimeInstanceId || !this.isEligible(record, request)) {
      this.removeLease(lease, "unavailable");
      throw new BotAssignmentError(
        "ASSIGNMENT_LEASE_UNAVAILABLE",
        "The assigned Bot is no longer eligible for the lease.",
      );
    }
    const updated = botAssignmentLeaseSchema.parse({
      ...lease,
      expiresAt: new Date(now.getTime() + parsedTtl).toISOString(),
    });
    const internal: InternalLease = { ...updated, fingerprint: lease.fingerprint };
    this.leasesById.set(leaseId, internal);
    this.emit({ type: "renewed", lease: updated });
    return cloneLease(updated);
  }

  release(leaseId: string): boolean {
    const lease = this.leasesById.get(leaseId);
    if (!lease) return false;
    this.removeLease(lease, "released");
    return true;
  }

  get(leaseId: string, at = this.now()): BotAssignmentLease | null {
    const now = validDate(at);
    this.reconcile(now);
    const lease = this.leasesById.get(leaseId);
    return lease ? cloneLease(lease) : null;
  }

  list(at = this.now()): readonly BotAssignmentLease[] {
    const now = validDate(at);
    this.reconcile(now);
    return [...this.leasesById.values()]
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
      .map(cloneLease);
  }

  /** Observe retained leases without expiry, reconciliation, or release side effects. */
  inspect(): readonly BotAssignmentLease[] {
    return [...this.leasesById.values()].map(cloneLease);
  }

  reconcile(at = this.now()): BotAssignmentReconcileResult {
    const now = validDate(at);
    const expiredLeaseIds: string[] = [];
    const releasedLeaseIds: string[] = [];
    for (const lease of [...this.leasesById.values()]) {
      if (Date.parse(lease.expiresAt) <= now.getTime()) {
        expiredLeaseIds.push(lease.leaseId);
        this.removeLease(lease, "expired");
        continue;
      }
      const request = this.requestFromLease(lease, MIN_LEASE_TTL_MS);
      const record = this.options.registry.get(lease.botId, now);
      if (
        !record ||
        record.runtimeInstanceId !== lease.runtimeInstanceId ||
        !this.isEligible(record, request)
      ) {
        releasedLeaseIds.push(lease.leaseId);
        this.removeLease(lease, "unavailable");
      }
    }
    return { expiredLeaseIds, releasedLeaseIds };
  }

  private parseRequest(input: unknown): NormalizedRequest {
    const parsed = botAssignmentRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new BotAssignmentError(
        "ASSIGNMENT_REQUEST_INVALID",
        "Assignment request failed bounded validation.",
      );
    }
    return {
      ...parsed.data,
      leaseTtlMs: parsed.data.leaseTtlMs ?? this.defaultLeaseTtlMs,
      requiredSkills: [...parsed.data.requiredSkills].sort(compareRequirements),
    };
  }

  private rankRequest(
    request: NormalizedRequest,
    at: Date,
  ): readonly BotAssignmentCandidate[] {
    const records = this.options.registry.list(at);
    return records
      .filter(
        (record) =>
          !this.leaseIdByBot.has(record.botId) &&
          this.isEligible(record, request),
      )
      .map((record) => {
        const scoreBreakdown = scoreRecord(record);
        return {
          botId: record.botId,
          runtimeInstanceId: record.runtimeInstanceId,
          serverProfileId: record.serverProfileId,
          score: scoreBreakdown.health + scoreBreakdown.food + scoreBreakdown.armor + scoreBreakdown.latency,
          scoreBreakdown,
        };
      })
      .sort(compareCandidates);
  }

  private isEligible(
    record: BotRegistryRecord,
    request: Pick<
      NormalizedRequest,
      "taskId" | "serverProfileId" | "dimension" | "requiredSkills" | "preferredBotId"
    >,
  ): boolean {
    if (request.preferredBotId && record.botId !== request.preferredBotId) return false;
    if (record.serverProfileId !== request.serverProfileId || record.connectionState !== "online") return false;
    const status = record.currentStatus;
    if (!status || !status.safety || status.safety.mode !== "monitoring" || status.safety.normalTasksPaused || status.safety.activeRisks.length > 0) return false;
    if (request.dimension !== null && status.position.dimension !== request.dimension) return false;
    // Mineflayer may not expose the max_health attribute even after the Bot is
    // fully online. A positive observed current value is still a usable
    // liveness signal; an unknown maximum only lowers the ranking score.
    if (status.health.current <= 0) return false;
    if (status.currentTask && status.currentTask.taskId !== request.taskId && !TERMINAL_TASK_STATUSES.has(status.currentTask.status)) return false;
    const catalog = record.skillCatalog;
    if (!catalog) return false;
    return request.requiredSkills.every((requirement) =>
      catalog.skills.some(
        (skill) =>
          skill.skillId === requirement.skillId &&
          skill.availability === "available" &&
          (requirement.skillVersion === null || skill.skillVersion === requirement.skillVersion),
      ),
    );
  }

  private requestFromLease(lease: BotAssignmentLease, leaseTtlMs: number): NormalizedRequest {
    return {
      taskId: lease.taskId,
      serverProfileId: lease.serverProfileId,
      dimension: lease.dimension,
      requiredSkills: lease.requiredSkills,
      preferredBotId: lease.botId,
      leaseTtlMs,
    };
  }

  private removeLease(
    lease: InternalLease,
    eventType: Extract<
      BotAssignmentEvent["type"],
      "released" | "expired" | "unavailable"
    >,
  ): void {
    this.leasesById.delete(lease.leaseId);
    if (this.leaseIdByTask.get(lease.taskId) === lease.leaseId) this.leaseIdByTask.delete(lease.taskId);
    if (this.leaseIdByBot.get(lease.botId) === lease.leaseId) this.leaseIdByBot.delete(lease.botId);
    this.emit({ type: eventType, lease });
  }

  private emit(input: {
    type: BotAssignmentEvent["type"];
    lease: BotAssignmentLease;
  }): void {
    const listener = this.options.onEvent;
    if (!listener) return;
    try {
      listener({
        type: input.type,
        leaseId: input.lease.leaseId,
        taskId: input.lease.taskId,
        botId: input.lease.botId,
        runtimeInstanceId: input.lease.runtimeInstanceId,
      });
    } catch {
      // Assignment state remains authoritative when observability is unavailable.
    }
  }
}

function compareRequirements(
  left: BotAssignmentSkillRequirement,
  right: BotAssignmentSkillRequirement,
): number {
  return `${left.skillId}@${left.skillVersion ?? "*"}`.localeCompare(
    `${right.skillId}@${right.skillVersion ?? "*"}`,
  );
}

function compareCandidates(
  left: BotAssignmentCandidate,
  right: BotAssignmentCandidate,
): number {
  return right.score - left.score || left.botId.localeCompare(right.botId) || left.runtimeInstanceId.localeCompare(right.runtimeInstanceId);
}

function scoreRecord(record: BotRegistryRecord): BotAssignmentScoreBreakdown {
  const status = record.currentStatus!;
  const maximumHealth = status.health.maximum;
  const health = maximumHealth === null
    ? 0
    : Math.round((status.health.current / maximumHealth) * 400);
  const food = Math.round((status.food.level / 20) * 250);
  const armor = status.armorPoints === null
    ? 0
    : Math.round((status.armorPoints / 20) * 200);
  const latency = status.latencyMs === null
    ? 0
    : Math.max(0, 150 - Math.min(status.latencyMs, 150));
  return { health, food, armor, latency };
}

function fingerprint(request: NormalizedRequest): string {
  return JSON.stringify({
    taskId: request.taskId,
    serverProfileId: request.serverProfileId,
    dimension: request.dimension,
    requiredSkills: request.requiredSkills,
    preferredBotId: request.preferredBotId,
  });
}

function cloneLease(lease: BotAssignmentLease): BotAssignmentLease {
  // Keep internal reconciliation metadata out of the public lease contract.
  return structuredClone({
    leaseId: lease.leaseId,
    taskId: lease.taskId,
    botId: lease.botId,
    runtimeInstanceId: lease.runtimeInstanceId,
    serverProfileId: lease.serverProfileId,
    dimension: lease.dimension,
    requiredSkills: lease.requiredSkills,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    score: lease.score,
    scoreBreakdown: lease.scoreBreakdown,
  });
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new BotAssignmentError("ASSIGNMENT_REQUEST_INVALID", "Assignment clock value is invalid.");
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside the allowed range.`);
  }
  return value;
}
