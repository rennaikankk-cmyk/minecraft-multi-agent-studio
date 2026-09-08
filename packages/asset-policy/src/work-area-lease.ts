import { randomUUID } from "node:crypto";
import { z } from "zod";
import { workAreaSchema, withinWorkArea, type WorkArea, type WorkPosition } from "./work-area.js";

export const workAreaClaimSchema = z.object({ area: workAreaSchema, owner: z.string().min(1).max(512) }).strict();
export const workAreaLeaseSchema = workAreaClaimSchema.extend({ leaseId: z.uuid(), expiresAtMs: z.number().int() }).strict();
export const workAreaProofSchema = z.object({ leaseId: z.uuid(), owner: z.string().min(1).max(512) }).strict();
export type WorkAreaLease = z.infer<typeof workAreaLeaseSchema>;
export type WorkAreaProof = z.infer<typeof workAreaProofSchema>;
export interface WorkAreaLeasePort {
  claim(input: z.infer<typeof workAreaClaimSchema>): WorkAreaLease | Promise<WorkAreaLease>;
  renew(proof: WorkAreaProof): WorkAreaLease | Promise<WorkAreaLease>;
  validate(proof: WorkAreaProof): boolean | Promise<boolean>;
  release(proof: WorkAreaProof): boolean | Promise<boolean>;
}
export const WORK_AREA_LEASE_TTL_MS = 30_000;

export class WorkAreaLeaseAuthority {
  private readonly leases = new Map<string, WorkAreaLease>();
  constructor(private readonly now: () => number = Date.now) {}
  private expire(): void {
    for (const [id, lease] of this.leases) if (lease.expiresAtMs <= this.now()) this.leases.delete(id);
  }
  claim(raw: z.infer<typeof workAreaClaimSchema>): WorkAreaLease {
    const input = workAreaClaimSchema.parse(raw);
    this.expire();
    for (const lease of this.leases.values()) {
      if (overlaps(lease.area, input.area)) throw new Error("WORK_AREA_BUSY");
    }
    if (this.leases.size >= 1024) throw new Error("WORK_AREA_LEASE_CAPACITY");
    const lease = { ...input, leaseId: randomUUID(), expiresAtMs: this.now() + WORK_AREA_LEASE_TTL_MS };
    this.leases.set(lease.leaseId, lease);
    return structuredClone(lease);
  }
  validate(raw: WorkAreaProof): boolean {
    const proof = workAreaProofSchema.parse(raw);
    this.expire();
    return this.leases.get(proof.leaseId)?.owner === proof.owner;
  }
  renew(raw: WorkAreaProof): WorkAreaLease {
    const proof = workAreaProofSchema.parse(raw);
    if (!this.validate(proof)) throw new Error("WORK_AREA_LEASE_LOST");
    const lease = this.leases.get(proof.leaseId)!;
    lease.expiresAtMs = this.now() + WORK_AREA_LEASE_TTL_MS;
    return structuredClone(lease);
  }
  release(raw: WorkAreaProof): boolean {
    const proof = workAreaProofSchema.parse(raw);
    return this.validate(proof) && this.leases.delete(proof.leaseId);
  }
  permits(scope: { serverProfileId: string; worldId?: string | null | undefined; dimension: string; position: WorkPosition; leaseId?: string | undefined }): boolean {
    this.expire();
    if (scope.leaseId && !this.leases.has(scope.leaseId)) return false;
    for (const lease of this.leases.values()) {
      if (lease.area.serverProfileId === scope.serverProfileId && (lease.area.worldId ?? null) === (scope.worldId ?? null) && lease.area.dimension === scope.dimension &&
        withinWorkArea(lease.area, scope.position) && lease.leaseId !== scope.leaseId) return false;
    }
    return true;
  }
}

function overlaps(a: WorkArea, b: WorkArea): boolean {
  return a.serverProfileId === b.serverProfileId && (a.worldId ?? null) === (b.worldId ?? null) && a.dimension === b.dimension &&
    a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y &&
    a.min.z <= b.max.z && b.min.z <= a.max.z;
}
