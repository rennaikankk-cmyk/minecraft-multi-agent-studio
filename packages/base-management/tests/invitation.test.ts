import { describe, expect, it } from "vitest";
import { InvitationStore, parseBaseInvitation, parseInvitationCoordinates } from "../src/invitation.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const evidence = { schemaVersion: "1.0" as const, source: "protocol-player-chat" as const,
  senderUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", playerListUsername: "Alice", signatureVerified: true,
  channel: "private" as const, authMode: "online" as const, worldId: "world", dimension: "overworld", policyRevision: 1 };
const input = { messageId: "m1", inviterIdentity: "Alice", identityEvidence: evidence, serverProfileId: "srv", worldId: "world", dimension: "overworld" };
const parsed = parseBaseInvitation("这是我的基地，过来住吧！x=-12 y=64 z=305", "bot-a")!;

describe("base invitation parser", () => {
  it.each([
    ["这是我的基地，过来住吧！x=-12 y=64 z=305", { x: -12, y: 64, z: 305 }],
    ["This is my base, move here: x=12 z=-8", { x: 12, y: null, z: -8 }],
    ["我的基地在坐标 (-3, 70, 9)，搬到这里", { x: -3, y: 70, z: 9 }],
    ["这是我的基地 -10 60 40 过来住", { x: -10, y: 60, z: 40 }],
    ["我的基地 x: -80, z: 20", { x: -80, y: null, z: 20 }],
  ])("parses %s", (message, coordinates) => expect(parseBaseInvitation(message, "bot-a")?.coordinates).toEqual(coordinates));
  it.each(["where is my base at x=12 z=-8?", "听说 x=12 z=-8 有基地", "不要搬来住 x=1 z=2", "不是我的基地 x=1 z=2",
    "Alice said this is my base x=1 z=2", "\"this is my base x=1 z=2\"", "This is not my base x=1 z=2", "这是我的基地 x=1.5 z=2",
    "这是我的基地 x=1 z=2 x=3 z=4", "这是我的基地 x=30000001 z=2"])("does not migrate for %s", (message) => expect(parseBaseInvitation(message, "b")).toBeNull());
  it("can use a bounded caller-owned coordinate context without replacing malformed coordinates", () => {
    expect(parseBaseInvitation("这是我家", "b", { x: 1, y: 70, z: 3 })?.coordinates).toEqual({ x: 1, y: 70, z: 3 });
    expect(parseBaseInvitation("我的基地 x=1.1 z=2", "b", { x: 1, y: 70, z: 3 })).toBeNull();
    expect(parseInvitationCoordinates("x=-1 z=2")).toEqual({ x: -1, y: null, z: 2 });
  });
});

describe("durable invitation store", () => {
  it("replays one message idempotently and records competing invitations without overwriting the active target", () => {
    const path = join(mkdtempSync(join(tmpdir(), "inv-")), "invitations.json");
    const store = new InvitationStore(path);
    const first = store.accept(parsed, input);
    expect(first.status).toBe("accepted");
    expect(store.accept(parsed, input).invitationId).toBe(first.invitationId);
    const second = store.accept({ ...parsed, coordinates: { x: 4, y: null, z: 5 } }, { ...input, messageId: "m2" });
    expect(second.status).toBe("rejected");
    expect(store.activeForBot("bot-a", input)?.invitationId).toBe(first.invitationId);
    const restored = new InvitationStore(path); restored.load();
    expect(restored.get(first.invitationId)).toEqual(first);
    expect(restored.migration(first.migrationId)).toMatchObject({ taskId: null, targetHomeBaseId: null, previousHomeBaseId: null });
  });
  it("persists a disabled automatic acceptance policy and task links across restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "inv-")), "invitations.json");
    const store = new InvitationStore(path); store.setAutoAccept(false);
    const record = store.accept(parsed, input); expect(record.status).toBe("pending");
    expect(() => store.attachTask(record.migrationId, "11111111-1111-4111-a111-111111111111")).toThrow("MIGRATION_NOT_ACCEPTED");
    store.transition(record.invitationId, "accepted"); store.attachTask(record.migrationId, "11111111-1111-4111-a111-111111111111");
    store.transition(record.invitationId, "travelling");
    const restored = new InvitationStore(path); restored.load();
    expect(restored.autoAccept).toBe(false); expect(restored.migration(record.migrationId)).toMatchObject({ taskId: "11111111-1111-4111-a111-111111111111", phase: "travelling" });
    expect(() => restored.attachTask(record.migrationId, "22222222-2222-4222-a222-222222222222")).toThrow("MIGRATION_TASK_CONFLICT");
    expect(restored.transition(record.invitationId, "settled")).toBeNull(); // no bed/home evidence API exists yet
  });
  it("isolates message ids and active migrations by persistent world", () => {
    const store = new InvitationStore(); const first = store.accept(parsed, input);
    const second = store.accept(parsed, { ...input, worldId: "new-world", identityEvidence: { ...evidence, worldId: "new-world" } });
    expect(second.invitationId).not.toBe(first.invitationId); expect(second.status).toBe("accepted");
  });
  it("allows only the inviting identity to revoke and protects expired/terminal records", () => {
    const store = new InvitationStore(); const record = store.accept(parsed, input, new Date("2026-09-01T00:00:00Z"));
    expect(store.revoke(record.invitationId, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")).toBeNull();
    expect(store.expire(new Date("2026-09-03T00:00:00Z"))).toBe(1);
    expect(store.transition(record.invitationId, "accepted")).toBeNull();
  });
  it("preserves corrupt data and rolls back in-memory mutation when persistence fails", () => {
    const path = join(mkdtempSync(join(tmpdir(), "inv-")), "invitations.json");
    writeFileSync(path, "corrupt"); const store = new InvitationStore(path);
    expect(() => store.load()).toThrow("INVITATION_STATE_INVALID"); expect(readFileSync(path, "utf8")).toBe("corrupt");
    const unwritable = new InvitationStore(join(path, "child"));
    expect(() => unwritable.accept(parsed, input)).toThrow(); expect(unwritable.list()).toHaveLength(0);
  });
  it("prevents schema mismatches and snapshot callers from changing authoritative state", () => {
    const store = new InvitationStore();
    expect(() => store.accept(parsed, { ...input, worldId: "other-world" })).toThrow("INVITATION_IDENTITY_SCOPE_MISMATCH");
    const record = store.accept(parsed, input); record.coordinates.x = 888;
    expect(store.get(record.invitationId)?.coordinates.x).toBe(-12);
  });
});
