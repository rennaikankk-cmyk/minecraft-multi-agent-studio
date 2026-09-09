import { z } from "zod";
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

/** Actions which must be authorized immediately before a runtime side effect. */
export const assetActionSchema = z.enum([
  "dig", "place", "use", "interact", "container-transfer", "fluid", "entity",
]);
export type AssetAction = z.infer<typeof assetActionSchema>;

export const assetRoleSchema = z.enum([
  "machine", "container", "workstation", "facility", "unknown",
]);
export type AssetRole = z.infer<typeof assetRoleSchema>;

export const assetProtectionSchema = z.enum([
  "UNPROTECTED", "SHARED", "OUTPUT_ONLY", "PRIVATE", "UNKNOWN_PROTECTED",
]);
export type AssetProtection = z.infer<typeof assetProtectionSchema>;

export const assetPolicyRecordSchema = z.object({
  assetId: z.string().min(1).max(128),
  serverProfileId: z.string().min(1).max(128),
  /** Persistent world generation. A connection/session epoch is not sufficient. */
  worldId: z.string().min(1).max(128).nullable(),
  dimension: z.string().min(1).max(128),
  position: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict(),
  role: assetRoleSchema,
  protection: assetProtectionSchema,
  ownerSubject: z.string().min(1).max(256).optional(),
  revision: z.number().int().positive(),
  version: z.number().int().positive(),
  allowedActions: z.array(assetActionSchema).max(16).default([]),
  subjects: z.array(z.string().min(1).max(128)).max(256).default([]),
  bounds: z.object({ min: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
    max: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }) }).optional(),
  expectedBlock: z.string().min(1).max(128).optional(),
  allowedItems: z.array(z.string().min(1).max(128)).max(256).default([]),
  maxWithdrawal: z.number().int().positive().max(2304).default(64),
  minimumRetained: z.number().int().nonnegative().max(2304).default(0),
  protectedEntityUuids: z.array(z.string().min(1).max(128)).max(256).default([]),
  revoked: z.boolean().default(false),
}).strict();
export type AssetPolicyRecord = z.infer<typeof assetPolicyRecordSchema>;

export const assetAuthorizationRequestSchema = z.object({
  assetId: z.string().min(1).max(128),
  serverProfileId: z.string().min(1).max(128),
  worldId: z.string().min(1).max(128).nullable(),
  dimension: z.string().min(1).max(128),
  position: assetPolicyRecordSchema.shape.position,
  subject: z.string().min(1).max(256),
  action: assetActionSchema,
  assetVersion: z.number().int().positive(),
  policyRevision: z.number().int().positive(),
  purpose: z.string().max(128).optional(),
  /** container-transfer direction is relevant for OUTPUT_ONLY assets. */
  direction: z.enum(["deposit", "withdraw"]).optional(),
  nowMs: z.number().int().nonnegative().optional(),
  observedBlock: z.string().max(128).optional(),
  itemName: z.string().max(128).optional(),
  count: z.number().int().nonnegative().max(2304).optional(),
}).strict();
export type AssetAuthorizationRequest = z.infer<typeof assetAuthorizationRequestSchema>;

export const worldEffectRequestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  serverProfileId: z.string().min(1).max(128), worldId: z.string().min(1).max(128).nullable(),
  dimension: z.string().min(1).max(128), subject: z.string().min(1).max(128),
  position: assetPolicyRecordSchema.shape.position, action: assetActionSchema,
  impactRadius: z.number().min(0).max(64).default(0),
  observedBlock: z.string().min(1).max(128).optional(), entityUuid: z.string().max(128).optional(),
  direction: z.enum(["deposit", "withdraw", "inspect"]).optional(),
  itemName: z.string().max(128).optional(), count: z.number().int().nonnegative().max(2304).optional(),
}).strict();
export type WorldEffectRequest = z.infer<typeof worldEffectRequestSchema>;
export const worldEffectDecisionSchema = z.object({ allowed: z.boolean(), code: z.string().max(128),
  policyRevisions: z.array(z.object({ assetId: z.string(), revision: z.number().int() })).max(4096) }).strict();
export type WorldEffectDecision = z.infer<typeof worldEffectDecisionSchema>;

export function evaluateWorldEffect(records: readonly AssetPolicyRecord[], raw: WorldEffectRequest): WorldEffectDecision {
  const input = worldEffectRequestSchema.parse(raw);
  const hits = records.filter((record) => {
    if (record.serverProfileId !== input.serverProfileId || record.worldId !== input.worldId || record.dimension !== input.dimension) return false;
    if (input.entityUuid && record.protectedEntityUuids.includes(input.entityUuid)) return true;
    const min = record.bounds?.min ?? record.position, max = record.bounds?.max ?? record.position;
    return (["x", "y", "z"] as const).every((axis) => input.position[axis] + input.impactRadius >= min[axis] && input.position[axis] - input.impactRadius <= max[axis]);
  });
  const policyRevisions = hits.map((r) => ({ assetId: r.assetId, revision: r.revision }));
  const deny = (code: string): WorldEffectDecision => ({ allowed: false, code, policyRevisions });
  if (hits.some((r) => r.revoked)) return deny("ASSET_POLICY_REVOKED");
  if (hits.some((r) => r.role === "machine")) return deny("ASSET_MACHINE_PROTECTED");
  const exact = hits.find((r) => !r.bounds && (["x", "y", "z"] as const).every((axis) => r.position[axis] === input.position[axis]));
  if (exact && exact.protection !== "UNKNOWN_PROTECTED") {
    if (input.impactRadius > 0) return deny("ASSET_INDIRECT_EFFECT_DENIED");
    if (exact.expectedBlock && exact.expectedBlock !== input.observedBlock) return deny("ASSET_VERSION_STALE");
    if (!exact.subjects.includes(input.subject)) return deny("ASSET_SUBJECT_DENIED");
    if (exact.protection === "OUTPUT_ONLY") {
      if (input.action !== "container-transfer" || !["inspect", "withdraw"].includes(input.direction ?? "")) return deny("ASSET_OUTPUT_ONLY");
      if (input.direction === "withdraw" && (!input.itemName || !exact.allowedItems.includes(input.itemName) || !input.count || input.count > exact.maxWithdrawal)) return deny("ASSET_OUTPUT_ALLOWANCE");
      return { allowed: true, code: "AUTHORIZED_OUTPUT", policyRevisions };
    }
    if (!exact.allowedActions.includes(input.action)) return deny("ASSET_ACTION_DENIED");
    return { allowed: true, code: "AUTHORIZED_ASSET", policyRevisions };
  }
  if (hits.length) return deny("ASSET_UNKNOWN_PROTECTED");
  return { allowed: true, code: "OUTSIDE_PROTECTED_ASSETS", policyRevisions };
}

export type AssetAuthorizationDecision =
  | { allowed: true; reason: "unprotected" | "shared" | "authorized_output" | "owner" }
  | { allowed: false; code: "ASSET_UNKNOWN_PROTECTED" | "ASSET_SCOPE_MISMATCH" | "ASSET_VERSION_STALE" | "ASSET_POLICY_REVOKED" | "ASSET_ACTION_DENIED" | "ASSET_OUTPUT_ONLY"; reason: string };

type Grant = { subject: string; action: AssetAction; expiresAtMs: number; revision: number; version: number };

/**
 * Deterministic, in-memory policy index. The coordinator owns registrations;
 * runtimes receive a snapshot and call authorize immediately before effects.
 * Unknown assets fail closed, and revocation/replacement invalidates old
 * versions through the revision/version checks.
 */
export class AssetPolicy {
  private readonly records = new Map<string, AssetPolicyRecord>();
  private readonly grants = new Map<string, Grant[]>();

  constructor(private readonly persistPath?: string) {
    if (!persistPath) return;
    let content: string;
    try { content = readFileSync(persistPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("ASSET_POLICY_READ_FAILED"); }
    try {
      if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error("size");
      const snapshot = z.object({ schemaVersion: z.literal("1.0"), records: z.array(assetPolicyRecordSchema).max(4096) }).strict().parse(JSON.parse(content));
      for (const record of snapshot.records) {
        if (this.records.has(this.key(record))) throw new Error("duplicate");
        this.records.set(this.key(record), record);
      }
    } catch { throw new Error("ASSET_POLICY_CORRUPT"); }
  }

  snapshot(scope?: { serverProfileId: string; worldId: string | null; dimension: string }): AssetPolicyRecord[] {
    return [...this.records.values()].filter((r) => !scope || this.sameScope(r, scope)).map((r) => structuredClone(r));
  }

  private sameScope(a: { serverProfileId: string; worldId: string | null; dimension: string }, b: { serverProfileId: string; worldId: string | null; dimension: string }): boolean {
    return a.serverProfileId === b.serverProfileId && a.worldId === b.worldId && a.dimension === b.dimension;
  }

  private persist(): void {
    if (!this.persistPath) return;
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const temporary = `${this.persistPath}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx");
      try { writeFileSync(fd, JSON.stringify({ schemaVersion: "1.0", records: this.snapshot() })); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, this.persistPath);
    } catch {
      try { unlinkSync(temporary); } catch { /* Preserve the last committed file. */ }
      throw new Error("ASSET_POLICY_WRITE_FAILED");
    }
  }

  register(raw: z.input<typeof assetPolicyRecordSchema>): AssetPolicyRecord {
    const record = assetPolicyRecordSchema.parse(raw);
    const key = this.key(record);
    const current = this.records.get(key);
    if (current && record.revision < current.revision) throw new Error("ASSET_POLICY_REVISION_REWIND");
    if (current && (record.version < current.version || record.revision === current.revision && !isDeepStrictEqual(record, current))) throw new Error("ASSET_POLICY_REVISION_CONFLICT");
    if (record.bounds && (["x", "y", "z"] as const).some((axis) => record.bounds!.min[axis] > record.bounds!.max[axis] || record.bounds!.max[axis] - record.bounds!.min[axis] > 512)) throw new Error("ASSET_POLICY_BOUNDS_INVALID");
    if (!current && this.records.size >= 4096) throw new Error("ASSET_POLICY_CAPACITY");
    this.records.set(key, structuredClone(record));
    try { this.persist(); } catch (error) { if (current) this.records.set(key, current); else this.records.delete(key); throw error; }
    return structuredClone(record);
  }

  revoke(raw: Pick<AssetPolicyRecord, "assetId" | "serverProfileId" | "worldId" | "dimension" | "position">): boolean {
    const key = this.key(raw);
    const current = this.records.get(key);
    if (!current || current.assetId !== raw.assetId) return false;
    this.register({ ...current, revision: current.revision + 1, revoked: true });
    this.grants.delete(key);
    return true;
  }

  get(raw: Pick<AssetPolicyRecord, "serverProfileId" | "worldId" | "dimension" | "position">): AssetPolicyRecord | null {
    const record = this.records.get(this.key(raw));
    return record ? structuredClone(record) : null;
  }

  grant(raw: { assetId: string; subject: string; action: AssetAction; expiresAtMs: number; revision: number;
    serverProfileId: string; worldId: string | null; dimension: string; position: AssetPolicyRecord["position"]; version: number }): void {
    if (!Number.isSafeInteger(raw.expiresAtMs) || raw.expiresAtMs <= 0) throw new Error("ASSET_GRANT_EXPIRY_INVALID");
    const key = this.key(raw), record = this.records.get(key);
    if (!record || record.revoked || record.assetId !== raw.assetId || record.version !== raw.version || record.revision !== raw.revision) throw new Error("ASSET_GRANT_SCOPE_INVALID");
    if (record.role === "machine" || record.protection === "UNKNOWN_PROTECTED" || record.protection === "OUTPUT_ONLY") throw new Error("ASSET_GRANT_PROTECTED");
    const list = (this.grants.get(key) ?? []).filter((grant) => grant.expiresAtMs > Date.now());
    if (list.length >= 256) throw new Error("ASSET_GRANT_CAPACITY");
    list.push({ subject: raw.subject, action: raw.action, expiresAtMs: raw.expiresAtMs, revision: raw.revision, version: raw.version });
    this.grants.set(key, list);
  }

  authorize(raw: AssetAuthorizationRequest): AssetAuthorizationDecision {
    // Authorization callers only provide the request contract. Accepting a
    // full policy record here would let an adapter smuggle mutable metadata
    // into the decision path, so strip any accidental extras before parsing.
    const request = assetAuthorizationRequestSchema.parse(raw);
    const record = this.records.get(this.key(request));
    if (!record) return { allowed: false, code: "ASSET_UNKNOWN_PROTECTED", reason: "asset is not registered" };
    if (record.assetId !== request.assetId || record.serverProfileId !== request.serverProfileId ||
      record.worldId !== request.worldId || record.dimension !== request.dimension) {
      return { allowed: false, code: "ASSET_SCOPE_MISMATCH", reason: "asset scope does not match request" };
    }
    if (record.version !== request.assetVersion || record.revision !== request.policyRevision) {
      return { allowed: false, code: "ASSET_VERSION_STALE", reason: "asset policy revision or version is stale" };
    }
    if (record.revoked) return { allowed: false, code: "ASSET_POLICY_REVOKED", reason: "permission revoked; protection retained" };
    if (record.expectedBlock && request.observedBlock !== record.expectedBlock) return { allowed: false, code: "ASSET_VERSION_STALE", reason: "target block changed or unobserved" };
    const now = request.nowMs ?? Date.now();
    const grant = (this.grants.get(this.key(record)) ?? []).find((candidate) =>
      candidate.subject === request.subject && candidate.action === request.action &&
      candidate.version === record.version && candidate.revision === record.revision && candidate.expiresAtMs > now);
    if (record.role === "machine" || record.protection === "UNKNOWN_PROTECTED") return { allowed: false, code: "ASSET_ACTION_DENIED", reason: "machine or unknown structure protected" };
    if (grant) return { allowed: true, reason: "owner" };
    if (record.ownerSubject === request.subject && record.protection === "PRIVATE") return { allowed: true, reason: "owner" };
    if (record.protection === "PRIVATE") {
      return { allowed: false, code: "ASSET_ACTION_DENIED", reason: "protected asset" };
    }
    if (record.protection === "OUTPUT_ONLY") {
      if (request.action !== "container-transfer" || request.direction !== "withdraw") {
        return { allowed: false, code: "ASSET_OUTPUT_ONLY", reason: "only confirmed output withdrawal is allowed" };
      }
      if (!record.subjects.includes(request.subject) || !request.itemName || !record.allowedItems.includes(request.itemName) ||
          !request.count || request.count > record.maxWithdrawal) return { allowed: false, code: "ASSET_ACTION_DENIED", reason: "output allowance exceeded or unspecified" };
      return { allowed: true, reason: "authorized_output" };
    }
    if (record.allowedActions.length > 0 && !record.allowedActions.includes(request.action)) {
      return { allowed: false, code: "ASSET_ACTION_DENIED", reason: "action is not allowlisted for asset" };
    }
    return { allowed: true, reason: record.protection === "SHARED" ? "shared" : "unprotected" };
  }

  private key(value: Pick<AssetPolicyRecord, "serverProfileId" | "worldId" | "dimension" | "position">): string {
    return `${value.serverProfileId}\u0000${value.worldId}\u0000${value.dimension}\u0000${value.position.x},${value.position.y},${value.position.z}`;
  }
}

/** Convenience predicate for adapters that need a single fail-closed check. */
export function assertAssetAction(policy: AssetPolicy, request: AssetAuthorizationRequest): void {
  const decision = policy.authorize(request);
  if (!decision.allowed) throw new Error(decision.code);
}
