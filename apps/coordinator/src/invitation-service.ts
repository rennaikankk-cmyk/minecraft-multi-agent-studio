import { randomUUID } from "node:crypto";
import { InvitationStore, type BaseInvitation, type InvitationScope } from "@minecraft-studio/base-management";
import type { BotRegistry, BotRegistryRecord } from "./bot-registry.js";
import type { CoordinatorLocalPlanner, LocalPlanResult } from "./local-planner.js";

const SURVEY_RADIUS = 24;
const MAX_TRAVEL_DISTANCE = 64;
export type InvitationMigrationResult = Readonly<{ invitation: BaseInvitation; travel: LocalPlanResult | null; survey: LocalPlanResult | null }>;
export type InvitationMigrationServiceOptions = Readonly<{
  store: InvitationStore;
  planner: Pick<CoordinatorLocalPlanner, "dispatchDomainSkill">;
  registry: Pick<BotRegistry, "get">;
  now?: () => Date;
  randomId?: () => string;
  /** Called after survey to perform residence verification/binding. The
   * residence module owns bed/sign evidence and current-home membership. */
  onSurvey?: (invitation: BaseInvitation, result: LocalPlanResult) => Promise<void>;
}>;

function scope(record: BotRegistryRecord): InvitationScope {
  return { serverProfileId: record.serverProfileId, worldId: record.currentStatus?.personalContext?.worldId ?? null,
    dimension: record.currentStatus?.position.dimension ?? "" };
}
function migrationRequest(invitation: BaseInvitation, taskId: string, now: Date, timeoutMs: number) {
  return { requestId: randomUUID(), traceId: randomUUID(), taskId, botId: invitation.targetBotId,
    // Opaque reference only. Coordinates remain in validated skill input.
    operatorGoal: `base-migration:${invitation.migrationId}`, timeoutMs, ...(invitation.status === "travelling" ? {} : {}) };
}
function distance(record: BotRegistryRecord, invitation: BaseInvitation): number | null {
  const position = record.currentStatus?.position; if (!position) return null;
  if (position.dimension !== invitation.dimension) return null;
  const y = invitation.coordinates.y ?? Math.floor(position.y);
  return Math.hypot(invitation.coordinates.x - position.x, y - position.y, invitation.coordinates.z - position.z);
}

/** Executes migration work through the existing planner/task FSM. This service
 * stores business checkpoints only; task execution, retries and leases remain
 * the planner/task-system responsibility. */
export class InvitationMigrationService {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  constructor(private readonly options: InvitationMigrationServiceOptions) {
    this.now = options.now ?? (() => new Date()); this.randomId = options.randomId ?? randomUUID;
  }
  async execute(invitationId: string): Promise<InvitationMigrationResult> {
    const invitation = this.options.store.get(invitationId); if (!invitation) throw new Error("INVITATION_NOT_FOUND");
    if (invitation.status !== "accepted" && invitation.status !== "travelling") throw new Error("INVITATION_NOT_ACCEPTED");
    const record = this.options.registry.get(invitation.targetBotId, this.now());
    if (!record || record.connectionState !== "online" || !record.currentStatus) {
      const blocked = this.options.store.transition(invitationId, "cancelled", "bot_offline", this.now());
      throw new Error(blocked ? "MIGRATION_BOT_OFFLINE" : "MIGRATION_STATE_CONFLICT");
    }
    const actualScope = scope(record);
    if (actualScope.serverProfileId !== invitation.serverProfileId || actualScope.worldId !== invitation.worldId || actualScope.dimension !== invitation.dimension) {
      this.options.store.transition(invitationId, "cancelled", "world_or_dimension_mismatch", this.now());
      throw new Error("MIGRATION_SCOPE_MISMATCH");
    }
    const travelDistance = distance(record, invitation);
    if (travelDistance === null || travelDistance > MAX_TRAVEL_DISTANCE) {
      this.options.store.transition(invitationId, "accepted", "awaiting_bounded_travel_segment", this.now());
      throw new Error("MIGRATION_TRAVEL_SEGMENT_REQUIRED");
    }
    const migration = this.options.store.migration(invitation.migrationId); if (!migration) throw new Error("MIGRATION_NOT_FOUND");
    const taskId = migration.taskId ?? this.randomId();
    if (!migration.taskId) this.options.store.attachTask(invitation.migrationId, taskId);
    if (invitation.status === "accepted") this.options.store.transition(invitationId, "travelling", null, this.now());
    const targetY = invitation.coordinates.y ?? Math.floor(record.currentStatus.position.y);
    const travel = await this.options.planner.dispatchDomainSkill(migrationRequest(invitation, taskId, this.now(), 30_000), {
      skillId: "movement.goto", input: { target: { x: invitation.coordinates.x, y: targetY, z: invitation.coordinates.z,
        dimension: invitation.dimension, serverProfileId: invitation.serverProfileId }, radius: 3 },
    });
    if (travel.action !== "skill_result") throw new Error("MIGRATION_TRAVEL_NOT_REACHED");
    const surveyTaskId = this.randomId();
    const survey = await this.options.planner.dispatchDomainSkill(migrationRequest(invitation, surveyTaskId, this.now(), 15_000), {
      skillId: "world.scan", input: { blockName: "crafting_table", maxCount: 32, maxDistance: SURVEY_RADIUS,
        dimension: invitation.dimension, serverProfileId: invitation.serverProfileId },
    });
    if (this.options.onSurvey) await this.options.onSurvey(invitation, survey);
    return { invitation: this.options.store.get(invitationId) ?? invitation, travel, survey };
  }
}
