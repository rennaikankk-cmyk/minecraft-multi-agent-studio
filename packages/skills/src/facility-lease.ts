import { z } from "zod";

export const facilityLeaseRequestSchema = z.object({
  facilityId: z.string().min(1),
  ownerId: z.string().min(1),
  ttlMs: z.number().int().min(1_000).max(15 * 60_000),
}).strict();

export type FacilityLease = Readonly<{
  facilityId: string;
  ownerId: string;
  fencingToken: number;
  expiresAtMs: number;
}>;

export interface FacilityLeaseAuthority {
  acquire(request: z.infer<typeof facilityLeaseRequestSchema>, nowMs?: number): FacilityLease | null;
  renew(lease: FacilityLease, ttlMs: number, nowMs?: number): FacilityLease | null;
  release(lease: FacilityLease, nowMs?: number): boolean;
  isCurrent(lease: FacilityLease, nowMs?: number): boolean;
}

/** In-memory authority for tests and single-process development. Production
 * must provide the same interface backed by Postgres/Redis fencing. */
export class InMemoryFacilityLeaseAuthority implements FacilityLeaseAuthority {
  private readonly active = new Map<string, FacilityLease>();
  private readonly counters = new Map<string, number>();

  acquire(request: z.infer<typeof facilityLeaseRequestSchema>, nowMs = Date.now()): FacilityLease | null {
    const parsed = facilityLeaseRequestSchema.parse(request);
    const current = this.active.get(parsed.facilityId);
    if (current && current.expiresAtMs > nowMs && current.ownerId !== parsed.ownerId) return null;
    const fencingToken = (this.counters.get(parsed.facilityId) ?? 0) + 1;
    const lease: FacilityLease = { facilityId: parsed.facilityId, ownerId: parsed.ownerId, fencingToken, expiresAtMs: nowMs + parsed.ttlMs };
    this.counters.set(parsed.facilityId, fencingToken);
    this.active.set(parsed.facilityId, lease);
    return lease;
  }

  renew(lease: FacilityLease, ttlMs: number, nowMs = Date.now()): FacilityLease | null {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60_000 || !this.isCurrent(lease, nowMs)) return null;
    const renewed = { ...lease, expiresAtMs: nowMs + ttlMs };
    this.active.set(lease.facilityId, renewed);
    return renewed;
  }

  release(lease: FacilityLease, nowMs = Date.now()): boolean {
    if (!this.isCurrent(lease, nowMs)) return false;
    this.active.delete(lease.facilityId);
    return true;
  }

  isCurrent(lease: FacilityLease, nowMs = Date.now()): boolean {
    const current = this.active.get(lease.facilityId);
    return current?.ownerId === lease.ownerId && current.fencingToken === lease.fencingToken && current.expiresAtMs > nowMs;
  }
}
