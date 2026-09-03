// ---------------------------------------------------------------------------
// chunk-census.ts —— chunk 列级方块 census 通用原语。
//
// 设计（R5-RECON Phase 1.3，泛化决策：raid 只是第一个消费者）：
//   1. "bot 的视觉是 chunk 数据包"：已加载 chunk 的整列方块皆可程序化
//      读取——被覆盖伪装的方块照样命中（非视线）。
//   2. 引擎纯逻辑 + 抽象 CensusColumnProvider：包内不 import mineflayer，
//      单测用假 provider；bot-runtime 侧实现真 provider（接线另行交付）。
//   3. **分帧纪律**：单次调用受 budget 约束（列数/方块数/截止时刻三闸），
//      到预算即返回剩余列——调用方用 setImmediate 续帧。禁止一次调用
//      扫到天荒地老（树冠寻路冻结事件循环教训）。
//   4. 三种使用模式都归约到同一 API：
//      - 列扫描：调用方直接给列清单
//      - 区域扫描：columnsForRegion() 把 x/z 边界折成列清单
//      - 增量扫描：调用方订阅 chunk 加载事件，把新列逐个/逐批喂进来
// ---------------------------------------------------------------------------

import { z } from "zod";

import { dimensionIdSchema, worldPositionSchema } from "./nether-coords.js";

// ---------------------------------------------------------------------------
// Provider 契约
// ---------------------------------------------------------------------------

export interface ChunkColumnRef {
  readonly cx: number;
  readonly cz: number;
}

/**
 * 方块数据源抽象。getBlock 的 x/z 是列内局部坐标（0..15），y 是世界坐标。
 * 返回 null 表示未加载/越界/不可读——引擎按"未观测"处理，不当作空气
 * （把未观测当空气会让 complete 语义撒谎）。
 */
export interface CensusColumnProvider {
  /** 当前已加载的列（同 dimension）。 */
  loadedColumns(dimension: string): readonly ChunkColumnRef[];
  getBlock(dimension: string, cx: number, cz: number, localX: number, y: number, localZ: number): string | null;
}

// ---------------------------------------------------------------------------
// 查询与结果
// ---------------------------------------------------------------------------

export const censusQuerySchema = z
  .object({
    dimension: dimensionIdSchema,
    /** 命中方块名集合（registry 命名，小写下划线）。 */
    blockNames: z.array(z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u)).min(1).max(64),
    minY: z.number().int().min(-2_048).max(2_047),
    maxY: z.number().int().min(-2_048).max(2_047),
  })
  .strict()
  .refine((q) => q.minY <= q.maxY, { message: "minY must be <= maxY" });
export type CensusQuery = z.infer<typeof censusQuerySchema>;

export const censusHitSchema = worldPositionSchema.extend({
  blockName: z.string().min(1).max(64),
});
export type CensusHit = z.infer<typeof censusHitSchema>;

export interface CensusBudget {
  /** 本次调用最多扫描多少列（默认 4：一列 16x16x高度 已是数万次方块读）。 */
  readonly maxColumns?: number;
  /** 本次调用最多读多少方块（硬闸，防一列超高 y 范围打爆帧）。 */
  readonly maxBlocks?: number;
  /** 截止时刻（performance.now 时基，单调）；到点立即收工。 */
  readonly deadlineMonotonicMs?: number;
  /** 时钟注入（默认 performance.now，无则 Date.now——测试用确定性时钟）。 */
  readonly nowMonotonicMs?: () => number;
}

export interface CensusBatchResult {
  /** 本次命中的方块（世界坐标）。已按列序+列内序稳定输出。 */
  readonly hits: readonly CensusHit[];
  /** 已完成的列（含本次）。 */
  readonly scannedColumns: number;
  /** 尚未扫描的列——调用方下次续扫传回 scanColumnsBatch。 */
  readonly pendingColumns: readonly ChunkColumnRef[];
  /** 预算是哪一闸先断的（done=true 时为 null）。 */
  readonly stoppedBy: "columns" | "blocks" | "deadline" | null;
  /** 全部列扫完。 */
  readonly done: boolean;
}

const DEFAULT_MAX_COLUMNS_PER_BATCH = 4;
const DEFAULT_MAX_BLOCKS_PER_BATCH = 512 * 1024;

// ---------------------------------------------------------------------------
// 列清单派生（区域/走廊模式）
// ---------------------------------------------------------------------------

/** x/z 世界边界 → 列清单（闭区间，含负坐标——floor 语义与 chunkKey 一致）。 */
export function columnsForRegion(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): readonly ChunkColumnRef[] {
  const columns: ChunkColumnRef[] = [];
  const cx0 = Math.floor(minX / 16);
  const cz0 = Math.floor(minZ / 16);
  const cx1 = Math.floor(maxX / 16);
  const cz1 = Math.floor(maxZ / 16);
  for (let cx = cx0; cx <= cx1; cx += 1) {
    for (let cz = cz0; cz <= cz1; cz += 1) {
      columns.push({ cx, cz });
    }
  }
  return columns;
}

export type CorridorDirection = "+x" | "-x" | "+z" | "-z";

/**
 * 走廊 → 列清单：从 origin 沿 direction 长 lengthBlocks、两侧各
 * halfWidthBlocks 的矩形（水平投影）。roof 扫描走廊的列清单就来自这里。
 */
export function columnsForCorridor(
  origin: { x: number; z: number },
  direction: CorridorDirection,
  lengthBlocks: number,
  halfWidthBlocks: number,
): readonly ChunkColumnRef[] {
  const safeLength = Math.max(1, Math.min(30_000_000, lengthBlocks));
  const safeHalfWidth = Math.max(0, Math.min(10_000, halfWidthBlocks));
  let minX: number;
  let minZ: number;
  let maxX: number;
  let maxZ: number;
  if (direction === "+x" || direction === "-x") {
    const far = direction === "+x" ? origin.x + safeLength : origin.x - safeLength;
    minX = Math.min(origin.x, far) - safeHalfWidth;
    maxX = Math.max(origin.x, far) + safeHalfWidth;
    minZ = origin.z - safeHalfWidth;
    maxZ = origin.z + safeHalfWidth;
  } else {
    const far = direction === "+z" ? origin.z + safeLength : origin.z - safeLength;
    minX = origin.x - safeHalfWidth;
    maxX = origin.x + safeHalfWidth;
    minZ = Math.min(origin.z, far) - safeHalfWidth;
    maxZ = Math.max(origin.z, far) + safeHalfWidth;
  }
  return columnsForRegion(minX, minZ, maxX, maxZ);
}

// ---------------------------------------------------------------------------
// 扫描引擎（预算约束的列批扫描）
// ---------------------------------------------------------------------------

/**
 * 按预算扫描一批列。纯同步、有界：预算在 **y 层粒度**检查（列数/方块数/
 * 截止时刻三闸），任何一闸先断即返回。
 *
 * 进度语义：scannedColumns 只计**完整扫完**的列；被预算打断的列完整保留
 * 在 pendingColumns 头部（下次重扫该列——只读幂等，重扫无害）。调用方
 * 契约：maxBlocks 至少要 ≥ 一整列的方块量（16×16×列高），否则单列永远
 * 扫不完（进度保证的数学下界）；默认值按 roof 全高度一列 ~7 千格的 70 倍
 * 余量取 512k。
 */
export function scanColumnsBatch(
  provider: CensusColumnProvider,
  query: CensusQuery,
  columns: readonly ChunkColumnRef[],
  budget: CensusBudget = {},
): CensusBatchResult {
  const maxColumns = budget.maxColumns ?? DEFAULT_MAX_COLUMNS_PER_BATCH;
  const maxBlocks = budget.maxBlocks ?? DEFAULT_MAX_BLOCKS_PER_BATCH;
  const now = budget.nowMonotonicMs ?? defaultMonotonicMs;

  const wanted = new Set(query.blockNames);
  const yStart = query.minY;
  const yEnd = query.maxY;
  const hits: CensusHit[] = [];
  let blocksRead = 0;
  let stoppedBy: CensusBatchResult["stoppedBy"] = null;
  let scanned = 0;

  columnLoop: for (let columnIdx = 0; columnIdx < columns.length; columnIdx += 1) {
    if (scanned >= maxColumns) {
      stoppedBy = "columns";
      break;
    }
    const { cx, cz } = columns[columnIdx]!;
    for (let localX = 0; localX < 16; localX += 1) {
      for (let localZ = 0; localZ < 16; localZ += 1) {
        for (let y = yStart; y <= yEnd; y += 1) {
          if (blocksRead >= maxBlocks) {
            stoppedBy = "blocks";
            break columnLoop;
          }
          if (budget.deadlineMonotonicMs !== undefined && now() >= budget.deadlineMonotonicMs) {
            stoppedBy = "deadline";
            break columnLoop;
          }
          const blockName = provider.getBlock(query.dimension, cx, cz, localX, y, localZ);
          blocksRead += 1;
          if (blockName === null) continue;
          if (!wanted.has(blockName)) continue;
          hits.push({
            x: cx * 16 + localX,
            y,
            z: cz * 16 + localZ,
            blockName,
          });
        }
      }
    }
    scanned += 1;
  }

  const done = stoppedBy === null;
  return {
    hits,
    scannedColumns: scanned,
    pendingColumns: done ? [] : columns.slice(scanned),
    stoppedBy,
    done,
  };
}

// ---------------------------------------------------------------------------
// 汇总（census summary）
// ---------------------------------------------------------------------------

/** 按方块名聚合计数——dressedness 评估（门户周边人造痕迹）用。 */
export function summarizeCensus(hits: readonly CensusHit[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    counts.set(hit.blockName, (counts.get(hit.blockName) ?? 0) + 1);
  }
  return counts;
}

function defaultMonotonicMs(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf !== undefined ? perf.now() : Date.now();
}
