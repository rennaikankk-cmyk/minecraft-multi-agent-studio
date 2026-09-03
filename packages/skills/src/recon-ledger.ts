// ---------------------------------------------------------------------------
// recon-ledger.ts —— 侦察标记账本（RAID 研究 S1/S3-R 的持久化情报池）。
//
// 定位（R5-RECON Phase 1.4）：
//   1. **事件只入账不触发行动**（触发模型 L-事件层）：登出点/tab list/
//      chunk 命中喂进这里，出击永远由 operator 从池里挑。
//   2. 持久化照 ProvenanceStore 模式：tmp+rename 原子写、.corrupt-* 隔离
//      不杀进程、bounded 上限驱逐最旧。
//   3. 分级启发式确定性（零模型）：dressedness（周边人造痕迹计数）+
//      离出生点/高速距离 → high/medium/low。出生点垃圾门不许淹没账本。
//   4. 标记≠基地：门→基地距离分布 UNKNOWN，主世界候选区只由 nether-coords
//      的 overworldCandidateRegion 给出（候选不给实锤）。
// ---------------------------------------------------------------------------

import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  dimensionIdSchema,
  overworldCandidateRegion,
  worldPositionSchema,
  type OverworldCandidateRegion,
} from "./nether-coords.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const reconMarkTypeSchema = z.enum([
  "nether_portal",
  "stash_container",
  "logout_point",
  "roof_structure",
  "crafted_signal",
]);
export type ReconMarkType = z.infer<typeof reconMarkTypeSchema>;

export const reconGradeSchema = z.enum(["high", "medium", "low"]);
export type ReconGrade = z.infer<typeof reconGradeSchema>;

export const reconEvidenceSchema = z
  .object({
    /** 周边人造方块计数（dressedness：planks/torch/rail 等的 census 汇总）。 */
    nearbyCraftedCounts: z.record(z.string().min(1).max(64), z.number().int().min(0).max(65_536)).optional(),
    /** 门户被方块覆盖伪装（chunk 数据命中但视觉不可见）。 */
    covered: z.boolean().optional(),
    /** 登出点归属玩家（UUID 优先；S1 通道才有）。 */
    playerUuid: z.string().min(1).max(128).nullable().optional(),
    /** 观测来源（哪个扫描通道/哪次走廊）。 */
    observedVia: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ReconEvidence = z.infer<typeof reconEvidenceSchema>;

export const reconMarkSchema = z
  .object({
    markId: z.string().min(1).max(128),
    serverProfileId: z.string().min(1).max(128),
    dimension: dimensionIdSchema,
    position: worldPositionSchema,
    type: reconMarkTypeSchema,
    grade: reconGradeSchema,
    evidence: reconEvidenceSchema.optional(),
    firstObservedAtMs: z.number().int().min(0),
    lastObservedAtMs: z.number().int().min(0),
    /** 同一标记被再次观测的次数（成熟度信号）。 */
    observationCount: z.number().int().min(1).max(65_536),
  })
  .strict();
export type ReconMark = z.infer<typeof reconMarkSchema>;

// ---------------------------------------------------------------------------
// 分级启发式（纯函数，确定性）
// ---------------------------------------------------------------------------

export interface GradeMarkInput {
  /** 离出生点的水平距离（格）。 */
  distanceToSpawnBlocks: number;
  /** 离最近已知高速走廊的距离（格）；无高速数据时 null。 */
  distanceToHighwayBlocks: number | null;
  /** 周边人造方块计数总和（summarizeCensus 结果求和）。 */
  nearbyCraftedCount: number;
  /** 是否覆盖伪装门户。 */
  isCoveredPortal: boolean;
}

/**
 * 标记分级。规则（固定，无权重魔法数以外的自由度）：
 *   - dressed（人造痕迹 ≥4）或 覆盖伪装门 → 至少 medium；且远离出生点
 *     （>2000 格）升 high——有人跑两千格还要藏的东西值得排查。
 *   - 裸门 + 离出生点 <512 格 → low（出生点垃圾门）。
 *   - 其余 medium。
 */
export function gradeMark(input: GradeMarkInput): ReconGrade {
  const dressed = input.nearbyCraftedCount >= 4 || input.isCoveredPortal;
  const farFromSpawn = input.distanceToSpawnBlocks > 2_000;
  const nearSpawn = input.distanceToSpawnBlocks < 512;
  if (dressed && farFromSpawn) return "high";
  if (dressed) return "medium";
  if (nearSpawn && input.distanceToHighwayBlocks !== null && input.distanceToHighwayBlocks < 64) {
    return "low";
  }
  if (nearSpawn) return "low";
  return "medium";
}

// ---------------------------------------------------------------------------
// 登出点聚类（S1：同 UUID 反复登出 = 基地半径候选）
// ---------------------------------------------------------------------------

export interface LogoutSample {
  readonly playerUuid: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly observedAtMs: number;
}

export interface LogoutCluster {
  readonly playerUuid: string;
  readonly centroid: { readonly x: number; readonly y: number; readonly z: number };
  readonly sampleCount: number;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
}

/**
 * 按 UUID 分组后做半径聚类。确定性：样本先按 (x,z,y,observedAtMs) 排序
 * 再 first-fit——同输入同输出。minSamples 默认 3（研究文档 S1 阈值）。
 */
export function clusterLogoutPoints(
  samples: readonly LogoutSample[],
  radiusBlocks = 32,
  minSamples = 3,
): readonly LogoutCluster[] {
  const byPlayer = new Map<string, LogoutSample[]>();
  for (const sample of samples) {
    const list = byPlayer.get(sample.playerUuid) ?? [];
    list.push(sample);
    byPlayer.set(sample.playerUuid, list);
  }
  const clusters: LogoutCluster[] = [];
  for (const [playerUuid, list] of byPlayer) {
    const sorted = [...list].sort((a, b) =>
      a.position.x - b.position.x ||
      a.position.z - b.position.z ||
      a.position.y - b.position.y ||
      a.observedAtMs - b.observedAtMs,
    );
    const members: LogoutSample[][] = [];
    for (const sample of sorted) {
      let placed = false;
      for (const group of members) {
        const anchor = group[0]!;
        const dx = sample.position.x - anchor.position.x;
        const dy = sample.position.y - anchor.position.y;
        const dz = sample.position.z - anchor.position.z;
        if (dx * dx + dy * dy + dz * dz <= radiusBlocks * radiusBlocks) {
          group.push(sample);
          placed = true;
          break;
        }
      }
      if (!placed) members.push([sample]);
    }
    for (const group of members) {
      if (group.length < minSamples) continue;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let first = Number.POSITIVE_INFINITY;
      let last = 0;
      for (const sample of group) {
        sx += sample.position.x;
        sy += sample.position.y;
        sz += sample.position.z;
        first = Math.min(first, sample.observedAtMs);
        last = Math.max(last, sample.observedAtMs);
      }
      clusters.push({
        playerUuid,
        centroid: {
          x: Math.round(sx / group.length),
          y: Math.round(sy / group.length),
          z: Math.round(sz / group.length),
        },
        sampleCount: group.length,
        firstObservedAtMs: first,
        lastObservedAtMs: last,
      });
    }
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// ReconLedgerStore（bounded + 持久化）
// ---------------------------------------------------------------------------

export interface ReconLedgerOptions {
  maxMarks?: number;
  persistPath?: string;
  now?: () => number;
}

const DEFAULT_MAX_MARKS = 4_096;

export class ReconLedgerStore {
  private readonly marks = new Map<string, ReconMark>();
  private readonly maxMarks: number;
  private readonly persistPath: string | null;
  private readonly now: () => number;

  constructor(options: ReconLedgerOptions = {}) {
    this.maxMarks = options.maxMarks ?? DEFAULT_MAX_MARKS;
    this.persistPath = options.persistPath ?? null;
    this.now = options.now ?? (() => Date.now());
    this.loadFromDisk();
  }

  private static markKey(type: ReconMarkType, dimension: string, position: { x: number; y: number; z: number }): string {
    return `${type}|${dimension}:${position.x},${position.y},${position.z}`;
  }

  /**
   * 记录/更新一条标记。同 key 幂等：grade 取新旧较高者（升级不降级），
   * evidence 浅合并（新值优先），observationCount 递增，lastObserved 刷新。
   */
  record(entry: Omit<ReconMark, "markId" | "firstObservedAtMs" | "lastObservedAtMs" | "observationCount"> & {
    markId?: string;
  }): ReconMark {
    const key = ReconLedgerStore.markKey(entry.type, entry.dimension, entry.position);
    const nowMs = this.now();
    const existing = this.marks.get(key);
    if (existing !== undefined) {
      const gradeRank: Record<ReconGrade, number> = { low: 0, medium: 1, high: 2 };
      const updated: ReconMark = {
        ...existing,
        grade: gradeRank[entry.grade] > gradeRank[existing.grade] ? entry.grade : existing.grade,
        evidence: { ...existing.evidence, ...entry.evidence },
        lastObservedAtMs: nowMs,
        observationCount: Math.min(65_536, existing.observationCount + 1),
      };
      this.marks.set(key, updated);
      this.persistToDisk();
      return updated;
    }
    if (this.marks.size >= this.maxMarks) this.evictOldest();
    const mark: ReconMark = {
      markId: entry.markId ?? `recon-${nowMs}-${this.marks.size}`,
      serverProfileId: entry.serverProfileId,
      dimension: entry.dimension,
      position: entry.position,
      type: entry.type,
      grade: entry.grade,
      evidence: entry.evidence,
      firstObservedAtMs: nowMs,
      lastObservedAtMs: nowMs,
      observationCount: 1,
    };
    this.marks.set(key, mark);
    this.persistToDisk();
    return mark;
  }

  /** 主世界排查候选区：下界门标记 → overworldCandidateRegion（nether-coords 单源）。 */
  overworldCandidateFor(markId: string, searchRadiusBlocks?: number): OverworldCandidateRegion | null {
    const mark = this.get(markId);
    if (mark === null || mark.type !== "nether_portal") return null;
    return overworldCandidateRegion(mark.position, searchRadiusBlocks);
  }

  /** 分级查询（排查优先队列的原料；返回按 grade 降序、再按最近观测降序）。 */
  byGrade(grade: ReconGrade): readonly ReconMark[] {
    return [...this.marks.values()]
      .filter((m) => m.grade === grade)
      .sort((a, b) => b.lastObservedAtMs - a.lastObservedAtMs);
  }

  get size(): number {
    return this.marks.size;
  }

  get(markId: string): ReconMark | null {
    for (const mark of this.marks.values()) {
      if (mark.markId === markId) return mark;
    }
    return null;
  }

  private loadFromDisk(): void {
    if (this.persistPath === null) return;
    try {
      if (!existsSync(this.persistPath)) return;
      const parsed = JSON.parse(readFileSync(this.persistPath, "utf8")) as {
        schemaVersion: string;
        marks: unknown[];
      };
      if (parsed.schemaVersion !== "1.0" || !Array.isArray(parsed.marks)) {
        throw new Error("invalid recon ledger schema");
      }
      for (const raw of parsed.marks) {
        const mark = reconMarkSchema.safeParse(raw);
        if (!mark.success) continue;
        const key = ReconLedgerStore.markKey(mark.data.type, mark.data.dimension, mark.data.position);
        this.marks.set(key, mark.data);
      }
    } catch {
      try {
        if (this.persistPath && existsSync(this.persistPath)) {
          renameSync(this.persistPath, `${this.persistPath}.corrupt-${Date.now()}`);
        }
      } catch {
        // 隔离失败也继续（空账本运行，不杀进程）
      }
    }
  }

  private persistToDisk(): void {
    if (this.persistPath === null) return;
    try {
      mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const body = JSON.stringify({
        schemaVersion: "1.0",
        updatedAt: new Date().toISOString(),
        marks: [...this.marks.values()],
      }) + "\n";
      const tmpPath = `${this.persistPath}.tmp-${randomUUID().slice(0, 8)}`;
      writeFileSync(tmpPath, body, "utf8");
      renameSync(tmpPath, this.persistPath);
    } catch {
      // 磁盘失败不杀进程：内存账本仍生效，下次启动回退旧盘文件
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, mark] of this.marks) {
      if (mark.lastObservedAtMs < oldestTime) {
        oldestKey = key;
        oldestTime = mark.lastObservedAtMs;
      }
    }
    if (oldestKey !== null) this.marks.delete(oldestKey);
  }
}
