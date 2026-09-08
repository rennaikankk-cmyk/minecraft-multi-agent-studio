import { z } from "zod";

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
  worldId: z.string().min(1).max(128),
  dimension: z.string().min(1).max(128),
  position: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict(),
  role: assetRoleSchema,
  protection: assetProtectionSchema,
  ownerSubject: z.string().min(1).max(256).optional(),
  revision: z.number().int().positive(),
  version: z.number().int().positive(),
  allowedActions: z.array(assetActionSchema).max(16).default([]),
}).strict();
export type AssetPolicyRecord = z.infer<typeof assetPolicyRecordSchema>;

export const assetAuthorizationRequestSchema = z.object({
  assetId: z.string().min(1).max(128),
  serverProfileId: z.string().min(1).max(128),
  worldId: z.string().min(1).max(128),
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
}).strict();
export type AssetAuthorizationRequest = z.infer<typeof assetAuthorizationRequestSchema>;

export type AssetAuthorizationDecision =
  | { allowed: true; reason: "unprotected" | "shared" | "authorized_output" | "owner" }
  | { allowed: false; code: "ASSET_UNKNOWN_PROTECTED" | "ASSET_SCOPE_MISMATCH" | "ASSET_VERSION_STALE" | "ASSET_POLICY_REVOKED" | "ASSET_ACTION_DENIED" | "ASSET_OUTPUT_ONLY"; reason: string };

type Grant = { subject: string; action: AssetAction; expiresAtMs: number; revision: number };

/**
 * Deterministic, in-memory policy index. The coordinator owns registrations;
 * runtimes receive a snapshot and call authorize immediately before effects.
 * Unknown assets fail closed, and revocation/replacement invalidates old
 * versions through the revision/version checks.
 */
export class AssetPolicy {
  private readonly records = new Map<string, AssetPolicyRecord>();
  private readonly grants = new Map<string, Grant[]>();

  register(raw: AssetPolicyRecord): AssetPolicyRecord {
    const record = assetPolicyRecordSchema.parse(raw);
    const key = this.key(record);
    const current = this.records.get(key);
    if (current && record.revision < current.revision) throw new Error("ASSET_POLICY_REVISION_REWIND");
    this.records.set(key, structuredClone(record));
    return structuredClone(record);
  }

  revoke(raw: Pick<AssetPolicyRecord, "assetId" | "serverProfileId" | "worldId" | "dimension" | "position">): boolean {
    const key = this.key(raw);
    const removed = this.records.delete(key);
    if (removed) this.grants.delete(raw.assetId);
    return removed;
  }

  get(raw: Pick<AssetPolicyRecord, "serverProfileId" | "worldId" | "dimension" | "position">): AssetPolicyRecord | null {
    const record = this.records.get(this.key(raw));
    return record ? structuredClone(record) : null;
  }

  grant(raw: { assetId: string; subject: string; action: AssetAction; expiresAtMs: number; revision: number }): void {
    if (!Number.isSafeInteger(raw.expiresAtMs) || raw.expiresAtMs <= 0) throw new Error("ASSET_GRANT_EXPIRY_INVALID");
    const list = this.grants.get(raw.assetId) ?? [];
    list.push({ subject: raw.subject, action: raw.action, expiresAtMs: raw.expiresAtMs, revision: raw.revision });
    this.grants.set(raw.assetId, list);
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
    const now = request.nowMs ?? Date.now();
    const grant = (this.grants.get(record.assetId) ?? []).find((candidate) =>
      candidate.subject === request.subject && candidate.action === request.action &&
      candidate.revision === record.revision && candidate.expiresAtMs > now);
    if (grant) return { allowed: true, reason: "owner" };
    if (record.ownerSubject === request.subject && record.protection === "PRIVATE") return { allowed: true, reason: "owner" };
    if (record.protection === "UNKNOWN_PROTECTED" || record.protection === "PRIVATE") {
      return { allowed: false, code: "ASSET_ACTION_DENIED", reason: "protected asset" };
    }
    if (record.protection === "OUTPUT_ONLY") {
      if (request.action !== "container-transfer" || request.direction !== "withdraw") {
        return { allowed: false, code: "ASSET_OUTPUT_ONLY", reason: "only confirmed output withdrawal is allowed" };
      }
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
