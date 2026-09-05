import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { BaseRegistry } from "./base-registry.js";
import { ProvenanceStore, provenanceRecordSchema, type ProvenanceRecord } from "./provenance.js";
import { workPositionSchema, workScopeSchema } from "./work-area.js";
import { WorkAreaLeaseAuthority } from "./work-area-lease.js";

export const worldAssetQuerySchema = workScopeSchema.extend({ position: workPositionSchema, leaseId: z.uuid().optional() }).strict();
export type WorldAssetQuery = z.infer<typeof worldAssetQuerySchema>;
export const worldAssetObservationSchema = z.object({
  record: provenanceRecordSchema.nullable(),
  nearOwnBase: z.boolean(),
  workAllowed: z.boolean(),
}).strict();
export type WorldAssetObservation = z.infer<typeof worldAssetObservationSchema>;
export const worldAssetWriteSchema = provenanceRecordSchema.omit({ recordId: true, recordedAtMs: true }).extend({
  ...workScopeSchema.shape, position: workPositionSchema, leaseId: z.uuid().optional(),
}).strict();
export type WorldAssetWrite = z.infer<typeof worldAssetWriteSchema>;

export interface WorldAssetPort {
  observe(query: WorldAssetQuery): Promise<WorldAssetObservation> | WorldAssetObservation;
  record(entry: WorldAssetWrite): Promise<ProvenanceRecord> | ProvenanceRecord;
  remove(query: WorldAssetQuery): Promise<boolean> | boolean;
}

export interface WorldAssetAuthorityPort {
  observe(query: WorldAssetQuery): WorldAssetObservation;
  record(entry: WorldAssetWrite): ProvenanceRecord;
  remove(query: WorldAssetQuery): boolean;
}

/** The Coordinator is the only file writer. Runtime caches cannot authorize destruction. */
export class WorldAssetAuthority implements WorldAssetPort {
  private readonly stores = new Map<string, ProvenanceStore>();
  readonly workAreas: WorkAreaLeaseAuthority;
  constructor(private readonly options: { bases?: BaseRegistry; persistDir?: string; maxRecordsPerServer?: number; workAreas?: WorkAreaLeaseAuthority } = {}) {
    this.workAreas = options.workAreas ?? new WorkAreaLeaseAuthority();
  }

  private store(serverProfileId: string): ProvenanceStore {
    workScopeSchema.shape.serverProfileId.parse(serverProfileId);
    const current = this.stores.get(serverProfileId);
    if (current) return current;
    // Hash the exact identifier so case-insensitive filesystems and punctuation cannot merge scopes.
    const filename = createHash("sha256").update(serverProfileId, "utf8").digest("hex");
    const legacyName = serverProfileId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
    const store = new ProvenanceStore({ strictPersistence: true,
      serverProfileId,
      maxRecords: this.options.maxRecordsPerServer ?? 1_000_000,
      ...(this.options.persistDir ? {
        persistPath: path.join(this.options.persistDir, "by-profile", `${filename}.json`),
        legacyPersistPath: path.join(this.options.persistDir, `${legacyName}.json`),
      } : {}),
    });
    this.stores.set(serverProfileId, store);
    return store;
  }

  observe(raw: WorldAssetQuery): WorldAssetObservation {
    const query = worldAssetQuerySchema.parse(raw);
    const record = this.store(query.serverProfileId).get(query.position, query.dimension);
    if (record && record.serverProfileId !== query.serverProfileId) throw new Error("PROVENANCE_SCOPE_MISMATCH");
    const nearOwnBase = this.options.bases?.findBases(query.serverProfileId, query.dimension, query.position)
      .some((base) => {
        if (base.status === "abandoned") return false;
        const p = query.position, bounds = base.protectedBounds;
        const withinBlueprint = bounds && p.x >= bounds.min.x && p.x <= bounds.max.x &&
          p.y >= bounds.min.y && p.y <= bounds.max.y && p.z >= bounds.min.z && p.z <= bounds.max.z;
        // The fallback guard protects unrecorded starter assets; registered blueprints may extend it.
        return withinBlueprint || (Math.abs(base.anchor.x - p.x) <= 32 && Math.abs(base.anchor.z - p.z) <= 32 && Math.abs(base.anchor.y - p.y) <= 32);
      }) ?? false;
    return { record, nearOwnBase, workAllowed: this.workAreas.permits(query) };
  }

  record(raw: WorldAssetWrite): ProvenanceRecord {
    const { leaseId, ...entry } = worldAssetWriteSchema.parse(raw);
    if (!this.workAreas.permits({ ...entry, ...(leaseId ? { leaseId } : {}) })) throw new Error("WORK_AREA_BUSY");
    return this.store(entry.serverProfileId).record(entry);
  }

  remove(raw: WorldAssetQuery): boolean {
    const query = worldAssetQuerySchema.parse(raw);
    if (!this.workAreas.permits(query)) throw new Error("WORK_AREA_BUSY");
    return this.store(query.serverProfileId).remove(query.position, query.dimension);
  }
}
