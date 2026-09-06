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
  acquire(request: z.infer<typeof facilityLeaseRequestSchema>, nowMs?: number): FacilityLease | null | Promise<FacilityLease | null>;
  renew(lease: FacilityLease, ttlMs: number, nowMs?: number): FacilityLease | null | Promise<FacilityLease | null>;
  release(lease: FacilityLease, nowMs?: number): boolean | Promise<boolean>;
  isCurrent(lease: FacilityLease, nowMs?: number): boolean | Promise<boolean>;
}

export type FacilityLeaseQuery = (text: string, values?: readonly unknown[]) => Promise<{
  rows: readonly Record<string, unknown>[];
  rowCount?: number | null;
}>;

/** PostgreSQL-backed fencing authority shared by every Coordinator instance. */
export class PostgresFacilityLeaseAuthority implements FacilityLeaseAuthority {
  constructor(private readonly query: FacilityLeaseQuery) {}

  async acquire(request: z.infer<typeof facilityLeaseRequestSchema>, nowMs = Date.now()): Promise<FacilityLease | null> {
    const parsed = facilityLeaseRequestSchema.parse(request);
    const expiresAtMs = nowMs + parsed.ttlMs;
    const result = await this.query(
      `INSERT INTO studio_facility_leases (facility_id, owner_id, fencing_token, expires_at_ms, updated_at_ms)
       VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT (facility_id) DO UPDATE
         SET owner_id = EXCLUDED.owner_id,
             fencing_token = studio_facility_leases.fencing_token + 1,
             expires_at_ms = EXCLUDED.expires_at_ms,
             updated_at_ms = EXCLUDED.updated_at_ms
       WHERE studio_facility_leases.expires_at_ms <= $4
          OR studio_facility_leases.owner_id = $2
       RETURNING facility_id, owner_id, fencing_token, expires_at_ms`,
      [parsed.facilityId, parsed.ownerId, expiresAtMs, nowMs],
    );
    return leaseFromRow(result.rows[0]);
  }

  async renew(lease: FacilityLease, ttlMs: number, nowMs = Date.now()): Promise<FacilityLease | null> {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60_000) return null;
    const result = await this.query(
      `UPDATE studio_facility_leases
          SET expires_at_ms = $4, updated_at_ms = $5
        WHERE facility_id = $1 AND owner_id = $2 AND fencing_token = $3 AND expires_at_ms > $5
       RETURNING facility_id, owner_id, fencing_token, expires_at_ms`,
      [lease.facilityId, lease.ownerId, lease.fencingToken, nowMs + ttlMs, nowMs],
    );
    return leaseFromRow(result.rows[0]);
  }

  async release(lease: FacilityLease, nowMs = Date.now()): Promise<boolean> {
    const result = await this.query(
      `DELETE FROM studio_facility_leases
        WHERE facility_id = $1 AND owner_id = $2 AND fencing_token = $3 AND expires_at_ms > $4`,
      [lease.facilityId, lease.ownerId, lease.fencingToken, nowMs],
    );
    return result.rowCount === 1;
  }

  async isCurrent(lease: FacilityLease, nowMs = Date.now()): Promise<boolean> {
    const result = await this.query(
      `SELECT 1 AS current FROM studio_facility_leases
        WHERE facility_id = $1 AND owner_id = $2 AND fencing_token = $3 AND expires_at_ms > $4`,
      [lease.facilityId, lease.ownerId, lease.fencingToken, nowMs],
    );
    return result.rows.length === 1;
  }
}

function leaseFromRow(row: Record<string, unknown> | undefined): FacilityLease | null {
  if (!row || typeof row.facility_id !== "string" || typeof row.owner_id !== "string") return null;
  const fencingToken = Number(row.fencing_token);
  const expiresAtMs = Number(row.expires_at_ms);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1 || !Number.isSafeInteger(expiresAtMs)) return null;
  return { facilityId: row.facility_id, ownerId: row.owner_id, fencingToken, expiresAtMs };
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
