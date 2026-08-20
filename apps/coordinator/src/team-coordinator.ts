import type { BotRegistry, BotRegistryRecord } from "./bot-registry.js";

export const TEAM_ROLES = [
  "scout",
  "raider",
  "defender",
  "combat",
  "infrastructure",
  "logistics",
] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

export type TeamObjectiveInput = Readonly<{
  objectiveId: string;
  serverProfileId: string;
  title: string;
  maxBots: number;
  preferredRoles?: readonly TeamRole[];
}>;

export type TeamObjective = Readonly<{
  objectiveId: string;
  serverProfileId: string;
  title: string;
  maxBots: number;
  preferredRoles: readonly TeamRole[];
  status: "active" | "completed" | "cancelled";
  revision: number;
  assignedBotIds: readonly string[];
}>;

export type TeamResourceClaim =
  | Readonly<{
      kind: "named";
      key: string;
    }>
  | Readonly<{
      kind: "area";
      dimension: string;
      x: number;
      y: number;
      z: number;
      radius: number;
    }>;

export type TeamTaskAssignmentInput = Readonly<{
  taskId: string;
  objectiveId: string;
  requiredSkills: readonly string[];
  preferredRoles?: readonly TeamRole[];
  claims?: readonly TeamResourceClaim[];
  leaseMs: number;
}>;

export type TeamTaskAssignment = Readonly<{
  taskId: string;
  objectiveId: string;
  serverProfileId: string;
  botId: string;
  role: TeamRole | null;
  requiredSkills: readonly string[];
  claims: readonly TeamResourceClaim[];
  assignedAt: string;
  leaseExpiresAt: string;
}>;

export type TeamCoordinatorSnapshot = Readonly<{
  objectives: readonly TeamObjective[];
  assignments: readonly TeamTaskAssignment[];
  roles: Readonly<Record<string, TeamRole>>;
}>;

export type TeamCoordinatorErrorCode =
  | "TEAM_INPUT_INVALID"
  | "TEAM_OBJECTIVE_NOT_FOUND"
  | "TEAM_OBJECTIVE_INACTIVE"
  | "TEAM_OBJECTIVE_CAPACITY"
  | "TEAM_TASK_CONFLICT"
  | "TEAM_RESOURCE_CONFLICT"
  | "TEAM_BOT_NOT_FOUND"
  | "TEAM_BOT_SERVER_MISMATCH"
  | "TEAM_NO_ELIGIBLE_BOT";

export class TeamCoordinatorError extends Error {
  readonly code: TeamCoordinatorErrorCode;

  constructor(code: TeamCoordinatorErrorCode, message: string) {
    super(message);
    this.name = "TeamCoordinatorError";
    this.code = code;
  }
}

type StoredObjective = {
  objectiveId: string;
  serverProfileId: string;
  title: string;
  maxBots: number;
  preferredRoles: TeamRole[];
  status: "active" | "completed" | "cancelled";
  revision: number;
};

export type TeamCoordinatorOptions = Readonly<{
  registry: BotRegistry;
  now?: () => Date;
  maxObjectives?: number;
  maxAssignments?: number;
}>;

/**
 * Deterministic multi-Bot allocator. It never calls a model and never executes
 * a skill; it only chooses one live compatible Bot and atomically leases the
 * Bot plus declared resources to prevent duplicate work.
 */
export class TeamCoordinator {
  private readonly objectives = new Map<string, StoredObjective>();
  private readonly assignments = new Map<string, TeamTaskAssignment>();
  private readonly taskFingerprints = new Map<string, string>();
  private readonly roles = new Map<string, TeamRole>();
  private readonly now: () => Date;
  private readonly maxObjectives: number;
  private readonly maxAssignments: number;

  constructor(private readonly options: TeamCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxObjectives = boundedInteger(options.maxObjectives ?? 1_000, 1, 10_000, "maxObjectives");
    this.maxAssignments = boundedInteger(options.maxAssignments ?? 10_000, 1, 100_000, "maxAssignments");
  }

  setRole(botId: string, role: TeamRole): void {
    validIdentifier(botId, "botId");
    if (!TEAM_ROLES.includes(role)) throw invalid("Unknown team role.");
    if (!this.options.registry.get(botId, this.now())) {
      throw new TeamCoordinatorError("TEAM_BOT_NOT_FOUND", "Cannot set a role for an unknown Bot.");
    }
    this.roles.set(botId, role);
  }

  createObjective(input: TeamObjectiveInput): TeamObjective {
    this.sweepExpired();
    const normalized = validateObjective(input);
    const existing = this.objectives.get(normalized.objectiveId);
    if (existing) {
      const current = this.objectiveSnapshot(existing);
      if (objectiveFingerprint(current) !== objectiveFingerprint({
        ...normalized,
        status: "active",
        revision: 1,
        assignedBotIds: [],
      })) {
        throw new TeamCoordinatorError(
          "TEAM_TASK_CONFLICT",
          "Objective ID was already used with different parameters.",
        );
      }
      return current;
    }
    if (this.objectives.size >= this.maxObjectives) {
      throw new TeamCoordinatorError("TEAM_OBJECTIVE_CAPACITY", "Objective capacity was reached.");
    }
    const stored: StoredObjective = {
      ...normalized,
      preferredRoles: [...normalized.preferredRoles],
      status: "active",
      revision: 1,
    };
    this.objectives.set(stored.objectiveId, stored);
    return this.objectiveSnapshot(stored);
  }

  closeObjective(
    objectiveId: string,
    status: "completed" | "cancelled",
  ): TeamObjective {
    validIdentifier(objectiveId, "objectiveId");
    const objective = this.objectives.get(objectiveId);
    if (!objective) throw new TeamCoordinatorError("TEAM_OBJECTIVE_NOT_FOUND", "Objective was not found.");
    if (objective.status !== status) {
      objective.status = status;
      objective.revision += 1;
    }
    for (const [taskId, assignment] of this.assignments) {
      if (assignment.objectiveId === objectiveId) this.assignments.delete(taskId);
    }
    return this.objectiveSnapshot(objective);
  }

  assignTask(input: TeamTaskAssignmentInput): TeamTaskAssignment {
    const now = validNow(this.now());
    this.sweepExpired(now);
    const normalized = validateAssignment(input);
    const fingerprint = assignmentInputFingerprint(normalized);
    const recordedFingerprint = this.taskFingerprints.get(normalized.taskId);
    if (recordedFingerprint && recordedFingerprint !== fingerprint) {
      throw new TeamCoordinatorError("TEAM_TASK_CONFLICT", "Task ID was already assigned differently.");
    }
    const objective = this.objectives.get(normalized.objectiveId);
    if (!objective) throw new TeamCoordinatorError("TEAM_OBJECTIVE_NOT_FOUND", "Objective was not found.");
    if (objective.status !== "active") {
      throw new TeamCoordinatorError("TEAM_OBJECTIVE_INACTIVE", "Objective is not active.");
    }
    const existing = this.assignments.get(normalized.taskId);
    if (existing) {
      return structuredClone(existing);
    }
    if (this.assignments.size >= this.maxAssignments) {
      throw new TeamCoordinatorError("TEAM_OBJECTIVE_CAPACITY", "Assignment capacity was reached.");
    }

    this.assertClaimsAvailable(objective.serverProfileId, normalized.claims);
    const objectiveBotIds = new Set(
      [...this.assignments.values()]
        .filter((assignment) => assignment.objectiveId === objective.objectiveId)
        .map(({ botId }) => botId),
    );
    const busyBotIds = new Set([...this.assignments.values()].map(({ botId }) => botId));
    const roleOrder = normalized.preferredRoles.length > 0
      ? normalized.preferredRoles
      : objective.preferredRoles;
    const candidates = this.options.registry.list(now)
      .filter((record) => this.isEligible(record, objective.serverProfileId, normalized.requiredSkills))
      .filter((record) => !busyBotIds.has(record.botId))
      .filter((record) => objectiveBotIds.has(record.botId) || objectiveBotIds.size < objective.maxBots)
      .sort((left, right) =>
        roleRank(this.roles.get(left.botId), roleOrder) - roleRank(this.roles.get(right.botId), roleOrder) ||
        (right.currentStatus?.health.current ?? 0) - (left.currentStatus?.health.current ?? 0) ||
        (right.currentStatus?.food.level ?? 0) - (left.currentStatus?.food.level ?? 0) ||
        left.botId.localeCompare(right.botId)
      );
    const selected = candidates[0];
    if (!selected) {
      throw new TeamCoordinatorError("TEAM_NO_ELIGIBLE_BOT", "No live compatible unleased Bot is available.");
    }

    const assignment: TeamTaskAssignment = Object.freeze({
      taskId: normalized.taskId,
      objectiveId: objective.objectiveId,
      serverProfileId: objective.serverProfileId,
      botId: selected.botId,
      role: this.roles.get(selected.botId) ?? null,
      requiredSkills: Object.freeze([...normalized.requiredSkills]),
      claims: Object.freeze(normalized.claims.map((claim) => Object.freeze({ ...claim }))),
      assignedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + normalized.leaseMs).toISOString(),
    });
    this.assignments.set(assignment.taskId, assignment);
    this.taskFingerprints.set(assignment.taskId, fingerprint);
    objective.revision += 1;
    return structuredClone(assignment);
  }

  releaseTask(taskId: string): boolean {
    validIdentifier(taskId, "taskId");
    const assignment = this.assignments.get(taskId);
    if (!assignment) return false;
    this.assignments.delete(taskId);
    const objective = this.objectives.get(assignment.objectiveId);
    if (objective) objective.revision += 1;
    return true;
  }

  sweepExpired(at = this.now()): number {
    const atMs = validNow(at).getTime();
    let removed = 0;
    for (const [taskId, assignment] of this.assignments) {
      if (Date.parse(assignment.leaseExpiresAt) <= atMs) {
        this.assignments.delete(taskId);
        this.objectives.get(assignment.objectiveId)!.revision += 1;
        removed += 1;
      }
    }
    return removed;
  }

  teamStateForBot(botId: string): readonly string[] {
    const now = validNow(this.now());
    this.sweepExpired(now);
    const bot = this.options.registry.get(botId, now);
    if (!bot) return [];
    const records = this.options.registry.list(now)
      .filter(({ serverProfileId }) => serverProfileId === bot.serverProfileId);
    const lines = [
      `team online=${records.filter(({ connectionState }) => connectionState === "online").length}/${records.length} server=${bot.serverProfileId}`,
      ...records.slice(0, 10).map((record) => {
        const assignment = [...this.assignments.values()].find(({ botId: assigned }) => assigned === record.botId);
        return `bot=${record.botId} role=${this.roles.get(record.botId) ?? "unassigned"} state=${record.connectionState} task=${assignment?.taskId ?? "idle"}`;
      }),
      ...[...this.objectives.values()]
        .filter(({ serverProfileId, status }) => serverProfileId === bot.serverProfileId && status === "active")
        .slice(0, 10)
        .map((objective) => `objective=${objective.objectiveId} title=${objective.title.slice(0, 80)}`),
    ];
    return Object.freeze(lines);
  }

  snapshot(): TeamCoordinatorSnapshot {
    this.sweepExpired();
    return Object.freeze({
      objectives: Object.freeze(
        [...this.objectives.values()]
          .map((objective) => this.objectiveSnapshot(objective))
          .sort((left, right) => left.objectiveId.localeCompare(right.objectiveId)),
      ),
      assignments: Object.freeze(
        [...this.assignments.values()]
          .map((assignment) => structuredClone(assignment))
          .sort((left, right) => left.taskId.localeCompare(right.taskId)),
      ),
      roles: Object.freeze(Object.fromEntries([...this.roles].sort(([left], [right]) => left.localeCompare(right)))),
    });
  }

  private isEligible(
    record: BotRegistryRecord,
    serverProfileId: string,
    requiredSkills: readonly string[],
  ): boolean {
    if (
      record.serverProfileId !== serverProfileId ||
      record.connectionState !== "online" ||
      !record.currentStatus ||
      record.currentStatus.safety?.normalTasksPaused === true ||
      !record.skillCatalog
    ) {
      return false;
    }
    return requiredSkills.every((skillId) =>
      record.skillCatalog!.skills.some((skill) =>
        skill.skillId === skillId &&
        skill.availability === "available" &&
        skill.selectedVariantId !== null
      )
    );
  }

  private assertClaimsAvailable(
    serverProfileId: string,
    requested: readonly TeamResourceClaim[],
  ): void {
    for (const existing of this.assignments.values()) {
      if (existing.serverProfileId !== serverProfileId) continue;
      if (existing.claims.some((left) => requested.some((right) => claimsConflict(left, right)))) {
        throw new TeamCoordinatorError(
          "TEAM_RESOURCE_CONFLICT",
          `Task conflicts with active resource lease ${existing.taskId}.`,
        );
      }
    }
  }

  private objectiveSnapshot(objective: StoredObjective): TeamObjective {
    const assignedBotIds = [...new Set(
      [...this.assignments.values()]
        .filter(({ objectiveId }) => objectiveId === objective.objectiveId)
        .map(({ botId }) => botId),
    )].sort();
    return Object.freeze({
      ...objective,
      preferredRoles: Object.freeze([...objective.preferredRoles]),
      assignedBotIds: Object.freeze(assignedBotIds),
    });
  }
}

function validateObjective(input: TeamObjectiveInput) {
  if (!input || typeof input !== "object") throw invalid("Objective is required.");
  validIdentifier(input.objectiveId, "objectiveId");
  validIdentifier(input.serverProfileId, "serverProfileId");
  const title = boundedText(input.title, 1, 256, "title");
  const maxBots = boundedInteger(input.maxBots, 1, 10, "maxBots");
  const preferredRoles = uniqueRoles(input.preferredRoles ?? []);
  return { objectiveId: input.objectiveId, serverProfileId: input.serverProfileId, title, maxBots, preferredRoles };
}

function validateAssignment(input: TeamTaskAssignmentInput) {
  if (!input || typeof input !== "object") throw invalid("Assignment is required.");
  validIdentifier(input.taskId, "taskId");
  validIdentifier(input.objectiveId, "objectiveId");
  if (!Array.isArray(input.requiredSkills) || input.requiredSkills.length < 1 || input.requiredSkills.length > 16) {
    throw invalid("requiredSkills must contain between 1 and 16 entries.");
  }
  const requiredSkills = input.requiredSkills.map((skill) => validSkillId(skill));
  if (new Set(requiredSkills).size !== requiredSkills.length) throw invalid("requiredSkills must be unique.");
  const preferredRoles = uniqueRoles(input.preferredRoles ?? []);
  if (!Array.isArray(input.claims ?? [] ) || (input.claims?.length ?? 0) > 16) {
    throw invalid("claims must contain at most 16 entries.");
  }
  const claims = (input.claims ?? []).map(validateClaim);
  const leaseMs = boundedInteger(input.leaseMs, 1_000, 5 * 60_000, "leaseMs");
  return { taskId: input.taskId, objectiveId: input.objectiveId, requiredSkills, preferredRoles, claims, leaseMs };
}

function validateClaim(claim: TeamResourceClaim): TeamResourceClaim {
  if (!claim || typeof claim !== "object") throw invalid("Resource claim is invalid.");
  if (claim.kind === "named") {
    return Object.freeze({ kind: "named", key: boundedText(claim.key, 1, 128, "claim.key") });
  }
  if (claim.kind !== "area") throw invalid("Resource claim kind is invalid.");
  return Object.freeze({
    kind: "area",
    dimension: validDimension(claim.dimension),
    x: boundedFinite(claim.x, -30_000_000, 30_000_000, "claim.x"),
    y: boundedFinite(claim.y, -2_048, 2_048, "claim.y"),
    z: boundedFinite(claim.z, -30_000_000, 30_000_000, "claim.z"),
    radius: boundedFinite(claim.radius, 0.5, 128, "claim.radius"),
  });
}

function claimsConflict(left: TeamResourceClaim, right: TeamResourceClaim): boolean {
  if (left.kind === "named" || right.kind === "named") {
    return left.kind === "named" && right.kind === "named" && left.key === right.key;
  }
  return left.dimension === right.dimension &&
    Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) < left.radius + right.radius;
}

function roleRank(role: TeamRole | undefined, order: readonly TeamRole[]): number {
  if (!role) return order.length + 1;
  const index = order.indexOf(role);
  return index < 0 ? order.length : index;
}

function uniqueRoles(roles: readonly TeamRole[]): TeamRole[] {
  if (!Array.isArray(roles) || roles.length > TEAM_ROLES.length || roles.some((role) => !TEAM_ROLES.includes(role))) {
    throw invalid("Team roles are invalid.");
  }
  if (new Set(roles).size !== roles.length) throw invalid("Team roles must be unique.");
  return [...roles];
}

function validIdentifier(value: string, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw invalid(`${name} is invalid.`);
  }
  return value;
}

function validSkillId(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/u.test(value)) {
    throw invalid("Skill ID is invalid.");
  }
  return value;
}

function validDimension(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u.test(value)) {
    throw invalid("Dimension is invalid.");
  }
  return value;
}

function boundedText(value: string, min: number, max: number, name: string): string {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    throw invalid(`${name} is invalid.`);
  }
  return value.trim();
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${name} is invalid.`);
  return value;
}

function boundedFinite(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw invalid(`${name} is invalid.`);
  return value;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw invalid("Clock is invalid.");
  return value;
}

function invalid(message: string): TeamCoordinatorError {
  return new TeamCoordinatorError("TEAM_INPUT_INVALID", message);
}

function objectiveFingerprint(objective: TeamObjective): string {
  return JSON.stringify({
    objectiveId: objective.objectiveId,
    serverProfileId: objective.serverProfileId,
    title: objective.title,
    maxBots: objective.maxBots,
    preferredRoles: objective.preferredRoles,
  });
}

function assignmentInputFingerprint(assignment: TeamTaskAssignmentInput): string {
  return JSON.stringify({
    taskId: assignment.taskId,
    objectiveId: assignment.objectiveId,
    requiredSkills: assignment.requiredSkills,
    preferredRoles: assignment.preferredRoles ?? [],
    claims: assignment.claims,
    leaseMs: assignment.leaseMs,
  });
}
