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
// 原子性：writeFile(tmp) + rename —— 崩溃不留半截状态文件。
// 损坏容错：load 失败 → 把坏文件改名 *.corrupt 隔离 → 返回 null（首启语义），
//           绝不让损坏文件永久挡住启动。
// ---------------------------------------------------------------------------

import { existsSync, renameSync, writeFileSync, readFileSync } from "node:fs";

import type { BaseRecord } from "./base-registry.js";
import { BaseRegistry } from "./base-registry.js";
import type { Facility } from "./facility-registry.js";
import { FacilityRegistry } from "./facility-registry.js";
import type { WorkstationEntry } from "./workstation-registry.js";
import { InMemoryWorkstationRegistry } from "./workstation-registry.js";

export interface DurableStateSnapshot {
  workstations: { entries: WorkstationEntry[] };
  facilities: { facilities: Facility[] };
  bases: { bases: BaseRecord[] };
  savedAt: string;
}

/** 从三个注册表收集快照（未剥离 ephemeral）。 */
export function durableSnapshotFrom(
  workstations: InMemoryWorkstationRegistry,
  facilities: FacilityRegistry,
  bases: BaseRegistry,
): DurableStateSnapshot {
  return {
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
    const durable = stripEphemeralState(snapshot);
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(durable), "utf8");
    renameSync(tmp, this.filePath);
  }

  /**
   * 读取持久状态。文件不存在 → null（首启）。
   * 损坏 → 隔离为 *.corrupt 并返回 null，不抛异常。
   */
  load(): DurableStateSnapshot | null {
    if (!existsSync(this.filePath)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as DurableStateSnapshot;
      if (!parsed || typeof parsed !== "object" || !parsed.workstations || !parsed.facilities) {
        throw new Error("malformed");
      }
      return parsed;
    } catch {
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt`);
      } catch {
        // 隔离失败不阻塞启动
      }
      return null;
    }
  }

  get path(): string {
    return this.filePath;
  }
}
