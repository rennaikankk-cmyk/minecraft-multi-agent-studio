import { describe, expect, it, vi } from "vitest";
import { InvitationStore, parseBaseInvitation } from "@minecraft-studio/base-management";
import { InvitationMigrationService } from "../src/invitation-service.js";

const evidence = { schemaVersion: "1.0" as const, source: "protocol-player-chat" as const, senderUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", playerListUsername: "Alice", signatureVerified: true, channel: "private" as const, authMode: "online" as const, worldId: "world", dimension: "overworld", policyRevision: 1 };
const bot = { botId: "bot-a", serverProfileId: "srv", connectionState: "online", currentStatus: { position: { x: 0, y: 64, z: 0, dimension: "overworld" }, personalContext: { worldId: "world" } } } as any;
const input = { messageId: "m1", inviterIdentity: "Alice", identityEvidence: evidence, serverProfileId: "srv", worldId: "world", dimension: "overworld" };
const result = { action: "skill_result", reasonCode: "ok", invocation: {}, result: {}, ai: null } as any;

describe("InvitationMigrationService", () => {
  it("dispatches bounded movement then read-only survey with opaque goals", async () => {
    const store = new InvitationStore(); const invitation = store.accept(parseBaseInvitation("这是我的基地 x=10 y=64 z=8", "bot-a")!, input);
    const calls: any[] = []; const planner = { dispatchDomainSkill: vi.fn(async (request: any, skill: any) => { calls.push({ request, skill }); return result; }) };
    let surveyed = false; const service = new InvitationMigrationService({ store, planner, registry: { get: () => bot }, onSurvey: async () => { surveyed = true; } });
    const output = await service.execute(invitation.invitationId);
    expect(output.travel.action).toBe("skill_result"); expect(output.survey.action).toBe("skill_result"); expect(surveyed).toBe(true);
    expect(calls).toHaveLength(2); expect(calls[0].request.operatorGoal).toMatch(/^base-migration:mig-[0-9a-f]+$/); expect(calls[0].request.operatorGoal).not.toContain("x=10");
    expect(calls[0].skill).toMatchObject({ skillId: "movement.goto", input: { target: { x: 10, y: 64, z: 8 } } }); expect(calls[1].skill.skillId).toBe("world.scan");
  });
  it("blocks cross-world, offline and over-distance execution without planner calls", async () => {
    const cases: Array<[string, any, string]> = [
      ["world mismatch", { ...bot, currentStatus: { ...bot.currentStatus, personalContext: { worldId: "new" } } }, "MIGRATION_SCOPE_MISMATCH"],
      ["offline", { ...bot, connectionState: "offline" }, "MIGRATION_BOT_OFFLINE"],
      ["far", { ...bot, currentStatus: { ...bot.currentStatus, position: { ...bot.currentStatus.position, x: 200 } } }, "MIGRATION_TRAVEL_SEGMENT_REQUIRED"],
    ];
    for (const [, record, error] of cases) {
      const store = new InvitationStore(); const invitation = store.accept(parseBaseInvitation("这是我的基地 x=10 y=64 z=8", "bot-a")!, input); const planner = { dispatchDomainSkill: vi.fn() };
      await expect(new InvitationMigrationService({ store, planner, registry: { get: () => record } }).execute(invitation.invitationId)).rejects.toThrow(error); expect(planner.dispatchDomainSkill).not.toHaveBeenCalled();
    }
  });
  it("requires task-system association before travelling and resumes after restart", async () => {
    const store = new InvitationStore(); const invitation = store.accept(parseBaseInvitation("这是我的基地 x=1 z=2", "bot-a")!, input); const planner = { dispatchDomainSkill: vi.fn(async () => result) };
    await new InvitationMigrationService({ store, planner, registry: { get: () => bot } }).execute(invitation.invitationId);
    const migration = store.migration(invitation.migrationId)!; expect(migration.taskId).toMatch(/^[0-9a-f-]{36}$/); expect(store.get(invitation.invitationId)?.status).toBe("travelling");
  });
});
