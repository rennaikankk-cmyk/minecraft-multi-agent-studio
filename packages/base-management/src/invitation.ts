import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chatIdentityEvidenceSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

const id = z.string().min(1).max(128);
const coordinatesSchema = z.object({ x: z.number().int().min(-30_000_000).max(30_000_000), y: z.number().int().min(-4096).max(4096).nullable(), z: z.number().int().min(-30_000_000).max(30_000_000) }).strict();
export type InvitationCoordinates = z.infer<typeof coordinatesSchema>;
export const invitationScopeSchema = z.object({ serverProfileId: id, worldId: id.nullable(), dimension: id }).strict();
export type InvitationScope = z.infer<typeof invitationScopeSchema>;
export const baseInvitationSchema = invitationScopeSchema.extend({
  schemaVersion: z.literal("1.0"), invitationId: id, messageId: id,
  inviterIdentity: id, identityEvidence: chatIdentityEvidenceSchema,
  ownershipBasis: z.literal("trusted-player-declaration"),
  targetBotId: id, coordinates: coordinatesSchema,
  status: z.enum(["pending", "accepted", "travelling", "settled", "expired", "revoked", "cancelled", "rejected"]),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  migrationId: id, statusReason: z.string().max(256).nullable(),
}).strict();
export type BaseInvitation = z.infer<typeof baseInvitationSchema>;
export type InvitationStatus = BaseInvitation["status"];
export type BaseInvitationSummary = Pick<BaseInvitation, "invitationId" | "targetBotId" | "status" | "createdAt" | "updatedAt" | "expiresAt" | "migrationId" | "statusReason">;
/** Safe for status logs and ordinary list responses. Detailed evidence and
 * positions require an independently authorized backend read. */
export function invitationSummary(record: BaseInvitation): BaseInvitationSummary {
  const { invitationId, targetBotId, status, createdAt, updatedAt, expiresAt, migrationId, statusReason } = record;
  return { invitationId, targetBotId, status, createdAt, updatedAt, expiresAt, migrationId, statusReason };
}
export const baseMigrationRecordSchema = invitationScopeSchema.extend({
  schemaVersion: z.literal("1.0"), migrationId: id, invitationId: id, botId: id,
  // Business checkpoints only; execution and retries belong to task-system.
  phase: z.enum(["awaiting_acceptance", "preparing", "travelling", "surveying", "binding", "settled", "cancelled", "blocked"]),
  target: coordinatesSchema, taskId: z.string().uuid().nullable(), operationId: z.string().uuid(),
  targetHomeBaseId: id.nullable(), previousHomeBaseId: id.nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), reason: z.string().max(256).nullable(),
}).strict();
export type BaseMigrationRecord = z.infer<typeof baseMigrationRecordSchema>;
const durableSnapshotSchema = z.object({
  schemaVersion: z.literal("1.0"), invitations: z.array(baseInvitationSchema).max(4096),
  migrations: z.array(baseMigrationRecordSchema).max(4096), autoAccept: z.boolean(), savedAt: z.iso.datetime(),
}).strict();
export type InvitationStoreSnapshot = z.infer<typeof durableSnapshotSchema>;
export type ParsedInvitation = Readonly<{ coordinates: InvitationCoordinates; confidence: "deterministic"; intent: "move-in"; targetBotId: string }>;

const invitationIntent = /(?:这(?:个坐标|里)?是我(?:的|家)?(?:基地|家)|我的(?:基地|家)|过来住|搬来住|搬到这里|搬过来|以后当家|设为家|住这里|come\s+(?:and\s+)?live\s+here|this\s+is\s+my\s+(?:base|home)|move\s+(?:here|in)|make\s+this\s+your\s+home)/iu;
const unsafeContext = /[?？“”"'`「」『』]|^\s*>|(?:不要|不是|别|禁止|没有|哪里|怎么走|路线|听说|有人说|据说|问问|询问)|\b(?:not|never|don't|do\s+not|said|says|quote|where|route|directions)\b/iu;
function normalize(message: string): string { return message.trim().replace(/[，、]/gu, ",").replace(/：/gu, ":"); }

/** Coordinates are parsed locally; no model or server switch can be requested by this grammar. */
export function parseInvitationCoordinates(message: string): InvitationCoordinates | null {
  const text = normalize(message);
  if (text.length > 512) return null;
  const axes = [...text.matchAll(/(?:^|[^A-Za-z0-9_])([xyz])\s*(?:[:=]\s*|\s+)(-?\d{1,9})(?![\d.])/giu)];
  if (axes.length > 0) {
    const values: Record<string, number> = {};
    for (const match of axes) { const axis = match[1]!.toLowerCase(); if (axis in values) return null; values[axis] = Number(match[2]); }
    const parsed = coordinatesSchema.safeParse({ x: values.x, y: values.y ?? null, z: values.z });
    return parsed.success ? parsed.data : null;
  }
  // Exactly one unlabelled pair/triple, optionally prefixed by 坐标. Unrelated
  // integers are not silently dropped; malformed/fractional coordinates fail.
  const numbers = [...text.matchAll(/-?\d+(?:\.\d+)?/gu)].map((m) => m[0]);
  if (numbers.length !== 2 && numbers.length !== 3) return null;
  const match = /(?:^|[^\d.-])(-?\d{1,9})\s*[,\s]\s*(-?\d{1,9})(?:\s*[,\s]\s*(-?\d{1,9}))?(?![\d.])/u.exec(text);
  if (!match || numbers.some((value) => value.includes("."))) return null;
  const parsed = coordinatesSchema.safeParse({ x: Number(match[1]), y: match[3] ? Number(match[2]) : null, z: Number(match[3] ?? match[2]) });
  return parsed.success ? parsed.data : null;
}

export function hasInvitationIntent(message: string): boolean { return message.length <= 512 && invitationIntent.test(message) && !unsafeContext.test(message); }
export function canRememberInvitationCoordinates(message: string): boolean { return message.length <= 512 && !unsafeContext.test(message); }
export function containsPrivateCoordinates(message: string): boolean {
  return /(?:^|[^A-Za-z0-9_])[xyz]\s*(?:[:=]\s*|\s+)-?\d|坐标\s*[:：(（]?\s*-?\d|[-(（\s]\d{1,9}\s*[,，]\s*-?\d/iu.test(message) || parseInvitationCoordinates(message) !== null;
}
export function parseBaseInvitation(message: string, targetBotId: string, priorCoordinates?: InvitationCoordinates): ParsedInvitation | null {
  if (!targetBotId || !hasInvitationIntent(message)) return null;
  const coordinates = parseInvitationCoordinates(message) ?? (containsPrivateCoordinates(message) ? null : priorCoordinates);
  return coordinates ? { coordinates, confidence: "deterministic", intent: "move-in", targetBotId } : null;
}

const activeStatuses = new Set<InvitationStatus>(["pending", "accepted", "travelling"]);
const transitions: Readonly<Record<InvitationStatus, readonly InvitationStatus[]>> = {
  pending: ["accepted", "revoked", "cancelled", "expired", "rejected"], accepted: ["travelling", "revoked", "cancelled", "expired"],
  travelling: ["revoked", "cancelled", "expired"], settled: [], expired: [], revoked: [], cancelled: [], rejected: [],
};
function digest(input: unknown): string { return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24); }
function operationUuid(input: string): string {
  const hex = createHash("sha256").update(input).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function sameScope(a: InvitationScope, b: InvitationScope): boolean { return a.serverProfileId === b.serverProfileId && a.worldId === b.worldId && a.dimension === b.dimension; }
function copy<T>(value: T): T { return structuredClone(value); }

/** File backend: one coordinator writer, fsync before atomic rename. Process
 * recovery is supported; parent-directory durability on power loss is OS-dependent. */
export class InvitationStore {
  private records = new Map<string, BaseInvitation>();
  private migrations = new Map<string, BaseMigrationRecord>();
  private automaticAcceptance = true;
  constructor(private readonly filePath?: string) {}
  load(): void {
    if (!this.filePath) return;
    let raw: string;
    try { if (statSync(this.filePath).size > 8 * 1024 * 1024) throw new Error("INVITATION_STATE_TOO_LARGE"); raw = readFileSync(this.filePath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("INVITATION_STATE_READ_FAILED", { cause: error }); }
    try {
      const parsed = durableSnapshotSchema.parse(JSON.parse(raw));
      const records = new Map(parsed.invitations.map((r) => [r.invitationId, r]));
      const migrations = new Map(parsed.migrations.map((r) => [r.migrationId, r]));
      if (records.size !== parsed.invitations.length || migrations.size !== parsed.migrations.length) throw new Error("DUPLICATE_ID");
      const activeKeys = new Set<string>();
      for (const record of records.values()) {
        const migration = migrations.get(record.migrationId);
        if (!migration || migration.invitationId !== record.invitationId || migration.botId !== record.targetBotId || !sameScope(record, migration) ||
            JSON.stringify(record.coordinates) !== JSON.stringify(migration.target)) throw new Error("BROKEN_MIGRATION_REFERENCE");
        if (record.identityEvidence.worldId !== record.worldId || record.identityEvidence.dimension !== record.dimension || record.identityEvidence.playerListUsername !== record.inviterIdentity) throw new Error("INVITATION_IDENTITY_SCOPE_MISMATCH");
        if (activeStatuses.has(record.status)) {
          const key = JSON.stringify([record.serverProfileId, record.worldId, record.dimension, record.targetBotId]);
          if (activeKeys.has(key)) throw new Error("MULTIPLE_ACTIVE_MIGRATIONS"); activeKeys.add(key);
        }
      }
      for (const migration of migrations.values()) if (!records.has(migration.invitationId)) throw new Error("ORPHAN_MIGRATION");
      this.records = records; this.migrations = migrations; this.automaticAcceptance = parsed.autoAccept;
    } catch (error) { throw new Error("INVITATION_STATE_INVALID", { cause: error }); }
  }
  save(): void {
    const snapshot = durableSnapshotSchema.parse(this.serialize());
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomUUID()}.tmp`; const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(snapshot), "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.filePath);
  }
  private commit(action: () => void): void {
    const before = this.serialize();
    try { action(); this.save(); }
    catch (error) { this.records = new Map(before.invitations.map((r) => [r.invitationId, r])); this.migrations = new Map(before.migrations.map((r) => [r.migrationId, r])); this.automaticAcceptance = before.autoAccept; throw error; }
  }
  serialize(): InvitationStoreSnapshot { return copy({ schemaVersion: "1.0", invitations: [...this.records.values()], migrations: [...this.migrations.values()], autoAccept: this.automaticAcceptance, savedAt: new Date().toISOString() }); }
  get autoAccept(): boolean { return this.automaticAcceptance; }
  setAutoAccept(enabled: boolean): void { this.commit(() => { this.automaticAcceptance = enabled; }); }
  get(id: string): BaseInvitation | null { return copy(this.records.get(id) ?? null); }
  list(scope?: InvitationScope): BaseInvitation[] { return copy([...this.records.values()].filter((r) => !scope || sameScope(r, scope))); }
  migration(id: string): BaseMigrationRecord | null { return copy(this.migrations.get(id) ?? null); }
  byMessage(messageId: string, scope?: InvitationScope, botId?: string): BaseInvitation | null { return copy([...this.records.values()].find((r) => r.messageId === messageId && (!scope || sameScope(r, scope)) && (!botId || r.targetBotId === botId)) ?? null); }
  activeForBot(botId: string, scope?: InvitationScope): BaseInvitation | null { return copy([...this.records.values()].find((r) => r.targetBotId === botId && (!scope || sameScope(r, scope)) && activeStatuses.has(r.status)) ?? null); }
  accept(parsed: ParsedInvitation, input: Readonly<Pick<BaseInvitation, "messageId" | "inviterIdentity" | "identityEvidence" | "serverProfileId" | "worldId" | "dimension"> & { previousHomeBaseId?: string | null }>, now = new Date()): BaseInvitation {
    const evidence = chatIdentityEvidenceSchema.parse(input.identityEvidence);
    if (evidence.worldId !== input.worldId || evidence.dimension !== input.dimension || evidence.playerListUsername !== input.inviterIdentity) throw new Error("INVITATION_IDENTITY_SCOPE_MISMATCH");
    const existing = this.byMessage(input.messageId, input, parsed.targetBotId); if (existing) return existing;
    const iso = now.toISOString(); const invitationId = `inv-${digest([input.serverProfileId, input.worldId, input.dimension, parsed.targetBotId, input.messageId])}`;
    const migrationId = `mig-${digest(invitationId)}`;
    const prior = this.activeForBot(parsed.targetBotId, input);
    const status: InvitationStatus = prior ? "rejected" : this.automaticAcceptance ? "accepted" : "pending";
    const reason = prior ? "active_migration_requires_explicit_cancellation" : null;
    const record = baseInvitationSchema.parse({ schemaVersion: "1.0", invitationId, messageId: input.messageId, inviterIdentity: input.inviterIdentity,
      identityEvidence: evidence, ownershipBasis: "trusted-player-declaration", targetBotId: parsed.targetBotId, serverProfileId: input.serverProfileId, worldId: input.worldId,
      dimension: input.dimension, coordinates: parsed.coordinates, status, createdAt: iso, updatedAt: iso,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), migrationId, statusReason: reason });
    const migration = baseMigrationRecordSchema.parse({ schemaVersion: "1.0", migrationId, invitationId, botId: parsed.targetBotId,
      serverProfileId: input.serverProfileId, worldId: input.worldId, dimension: input.dimension,
      phase: prior ? "cancelled" : this.automaticAcceptance ? "preparing" : "awaiting_acceptance", target: parsed.coordinates,
      taskId: null, operationId: operationUuid(migrationId), previousHomeBaseId: input.previousHomeBaseId ?? null,
      targetHomeBaseId: null, createdAt: iso, updatedAt: iso, reason });
    this.commit(() => { this.records.set(invitationId, record); this.migrations.set(migrationId, migration); }); return copy(record);
  }
  /** Link a task-system record before dispatch. This store never schedules or retries it. */
  attachTask(migrationId: string, taskId: string, now = new Date()): BaseMigrationRecord {
    z.string().uuid().parse(taskId); const existing = this.migrations.get(migrationId); if (!existing) throw new Error("MIGRATION_NOT_FOUND");
    if (existing.taskId && existing.taskId !== taskId) throw new Error("MIGRATION_TASK_CONFLICT");
    if (existing.phase === "cancelled" || existing.phase === "awaiting_acceptance") throw new Error("MIGRATION_NOT_ACCEPTED");
    const next = { ...existing, taskId, updatedAt: now.toISOString() };
    this.commit(() => this.migrations.set(migrationId, next)); return copy(next);
  }
  transition(invitationId: string, status: InvitationStatus, reason: string | null = null, now = new Date()): BaseInvitation | null {
    const existing = this.records.get(invitationId); if (!existing) return null;
    if (status === existing.status) return copy(existing);
    if (!transitions[existing.status].includes(status)) return null;
    const migration = this.migrations.get(existing.migrationId)!;
    if (status === "travelling" && !migration.taskId) throw new Error("MIGRATION_TASK_REQUIRED");
    const next = baseInvitationSchema.parse({ ...existing, status, statusReason: reason, updatedAt: now.toISOString() });
    const phase: BaseMigrationRecord["phase"] = status === "accepted" ? "preparing" : status === "travelling" ? "travelling" : "cancelled";
    this.commit(() => { this.records.set(invitationId, next); this.migrations.set(migration.migrationId, { ...migration, phase, reason, updatedAt: next.updatedAt }); }); return copy(next);
  }
  revoke(invitationId: string, senderUuid: string, now = new Date()): BaseInvitation | null {
    const record = this.get(invitationId); if (!record || record.identityEvidence.senderUuid.replaceAll("-", "").toLowerCase() !== senderUuid.replaceAll("-", "").toLowerCase()) return null;
    return this.transition(invitationId, "revoked", "inviter_revoked", now);
  }
  expire(now = new Date()): number {
    const records = [...this.records.values()].filter((r) => activeStatuses.has(r.status) && Date.parse(r.expiresAt) <= now.getTime());
    for (const record of records) this.transition(record.invitationId, "expired", "invitation_expired", now);
    return records.length;
  }
}
