// ---------------------------------------------------------------------------
// DurableStateStore —— 持久化基础设施状态（Phase 6）
//
// Durable vs Ephemeral（十六节的硬性区分）：
//   持久化（重启必须记得）：
//     - Base 身份 / lifecycle / construction progress
//     - Facility 身份 / slot 语义状态（planned/occupied/missing/invalid/...）
//     - Workstation 观测（位置/类型/lastSeenAt）
//   不持久化（重启即弃，TTL 语义本来就短命）：
//     - workstation lease
//     - facility placement reservation（placement_reserved → planned）
//     - cell build reservation
//
// Atomic rename supports process recovery. No fsync or host power-loss guarantee.
// Read/corruption failures block recovery and preserve the original for inspection.
// ---------------------------------------------------------------------------

import { mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import type { BaseRecord } from "./base-registry.js";
import { BaseRegistry } from "./base-registry.js";
import type { Facility } from "./facility-registry.js";
import { FacilityRegistry } from "./facility-registry.js";
import type { WorkstationEntry } from "./workstation-registry.js";
import { InMemoryWorkstationRegistry } from "./workstation-registry.js";

export interface DurableStateSnapshot {
  schemaVersion?: "1.0";
  workstations: { entries: WorkstationEntry[] };
  facilities: { facilities: Facility[] };
  bases: { bases: BaseRecord[] };
  savedAt: string;
}

const positionSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const scopeSchema = z.object({ serverProfileId: z.string().min(1), dimension: z.string().min(1) });
const durableSchema = z.object({
  schemaVersion: z.literal("1.0").optional(), savedAt: z.iso.datetime(),
  workstations: z.object({ entries: z.array(scopeSchema.extend({
    type: z.enum(["crafting_table", "furnace", "blast_furnace", "smoker", "anvil", "enchanting_table", "brewing_stand",
      "stonecutter", "smithing_table", "grindstone", "chest", "barrel"]),
    position: positionSchema, usageMode: z.enum(["shared", "exclusive"]),
    lastSeenAt: z.number().finite(), confidence: z.number().min(0).max(1),
  }).passthrough()).max(4096) }),
  facilities: z.object({ facilities: z.array(scopeSchema.extend({
    id: z.string().min(1), anchor: positionSchema, facilityType: z.enum(["smelting_zone", "crafting_zone", "storage_zone"]),
    slots: z.array(z.object({ index: z.number().int().nonnegative(), worldPosition: positionSchema,
      status: z.enum(["planned", "placement_reserved", "occupied", "missing", "temporarily_blocked", "invalid", "unknown"]),
    }).passthrough()).max(4096),
  }).passthrough()).max(4096) }),
  bases: z.object({ bases: z.array(scopeSchema.extend({
    id: z.string().min(1), anchor: positionSchema, blueprintId: z.string().min(1), blueprintVersion: z.number().int().positive(),
    status: z.enum(["planned", "building", "operational", "damaged", "abandoned"]),
    placedCells: z.number().int().nonnegative(), integrity01: z.number().min(0).max(1),
    memberBotIds: z.array(z.string().min(1)).optional(),
    phaseFacts: z.record(z.string(), z.object({ availability: z.enum(["UNVERIFIED", "AVAILABLE", "DAMAGED", "RECOVERING"]),
      everCompleted: z.boolean(), evidence: z.string().min(1), observedAt: z.iso.datetime(), validator: z.string().min(1) })).optional(),
  }).passthrough()).max(4096) }),
});

/** 从三个注册表收集快照（未剥离 ephemeral）。 */
export function durableSnapshotFrom(
  workstations: InMemoryWorkstationRegistry,
  facilities: FacilityRegistry,
  bases: BaseRegistry,
): DurableStateSnapshot {
  return {
    schemaVersion: "1.0",
    workstations: { entries: workstations.serialize().entries },
    facilities: { facilities: facilities.serialize().facilities },
    bases: { bases: bases.serialize().bases },
    savedAt: new Date().toISOString(),
  };
}

/**
 * 剥离 ephemeral 协调状态，只留 durable 知识。
 * placement_reserved 的 slot 回到 planned（reason 记录恢复事实），
 * 但保留 failureCount / lastFailureAtMs（这是历史知识，不是预约）。
 */
export function stripEphemeralState(snapshot: DurableStateSnapshot): DurableStateSnapshot {
  const workstations = snapshot.workstations.entries.map((entry) => ({
    ...entry,
    lease: null,
  }));

  const facilities = snapshot.facilities.facilities.map((facility) => ({
    ...facility,
    slots: facility.slots.map((slot) => {
      if (slot.status !== "placement_reserved") {
        return { ...slot, reservedBy: null, reservedUntilMs: null };
      }
      return {
        ...slot,
        status: "planned" as const,
        reservedBy: null,
        reservedUntilMs: null,
        statusReason: "reservation_dropped_on_persist",
      };
    }),
  }));

  // Base 的 cell 级施工预约同样不持久化——BaseRecord 本身不含预约
  //（预约在 BaseRegistry 内部 Map，serialize 已不含它们）。
  return {
    schemaVersion: "1.0",
    workstations: { entries: workstations },
    facilities: { facilities },
    bases: { bases: snapshot.bases.bases },
    savedAt: snapshot.savedAt,
  };
}

/** 从 durable 快照重建三个注册表（重启恢复）。 */
export function registriesFromDurableSnapshot(
  snapshot: DurableStateSnapshot,
): { workstations: InMemoryWorkstationRegistry; facilities: FacilityRegistry; bases: BaseRegistry } {
  return {
    workstations: InMemoryWorkstationRegistry.restore({ entries: snapshot.workstations?.entries ?? [] }),
    facilities: FacilityRegistry.restore({ facilities: snapshot.facilities?.facilities ?? [] }),
    bases: BaseRegistry.restore({ bases: snapshot.bases?.bases ?? [] }),
  };
}

export class DurableStateStore {
  constructor(private readonly filePath: string) {}

  /** 原子保存（strip ephemeral → tmp → rename）。 */
  save(snapshot: DurableStateSnapshot): void {
    durableSchema.parse(snapshot);
    const durable = stripEphemeralState(snapshot);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(durable), "utf8");
    renameSync(tmp, this.filePath);
  }

  /**
   * 读取持久状态。文件不存在 → null（首启）。
   * Corrupt or inaccessible files throw; only ENOENT means first startup.
   */
  load(): DurableStateSnapshot | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("DURABLE_STATE_READ_FAILED", { cause: error });
    }
    try {
      const parsed = JSON.parse(raw) as DurableStateSnapshot;
      durableSchema.parse(parsed);
      return parsed;
    } catch (error) {
      throw new Error("DURABLE_STATE_INVALID", { cause: error });
    }
  }

  get path(): string {
    return this.filePath;
  }
}
