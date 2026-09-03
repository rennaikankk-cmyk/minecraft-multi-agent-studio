// ---------------------------------------------------------------------------
// recon-patrol.ts —— 巡逻网格分配器（触发模型 L-巡逻层的"扫哪里"单源）。
//
// 设计（R5-RECON Phase 1.6）：
//   1. 纯函数、确定性：同 scanState 同输出——"扫哪里"是账本驱动的覆盖
//      问题（RAID 研究 §4.5），不拍脑袋、零模型。
//   2. 网格：把（下界 roof）平面切成 cellSize 格的正方格；从锚点（高速
//      走廊参考点）按 Chebyshev 环向外扩；环内按 (gx, gz) 字典序。
//   3. 选择规则：第一个"从未扫描 或 超过 staleness 窗口"的格子 → 产出
//      一条走廊参数；全部新鲜 → null（无事可做，不硬造工作）。
//   4. 走廊 goal 文本与 deterministic-goals 的"roof 扫描走廊"模板严格
//      对齐（模板解析器在 coordinator 侧，两侧格式必须同步改）。
// ---------------------------------------------------------------------------

export interface PatrolCell {
  readonly gx: number;
  readonly gz: number;
}

export type PatrolScanState = ReadonlyMap<string, number>; // cellKey → lastScannedAtMs

export interface PatrolGridOptions {
  /** 锚点（世界坐标，通常是高速走廊参考点或出生点）。 */
  readonly anchorX: number;
  readonly anchorZ: number;
  /** 网格边长（格）。默认 128（8 chunk）。 */
  readonly cellSizeBlocks?: number;
  /** 最大环距（防无限外扩；默认 32 环 = 4096 格半径）。 */
  readonly maxRing?: number;
  /** staleness 窗口 ms（默认 7 天）。 */
  readonly stalenessMs?: number;
}

export interface PatrolCorridor {
  /** 走廊起点（世界坐标，格子 min 角）。 */
  readonly originX: number;
  readonly originZ: number;
  readonly direction: "+x" | "-x" | "+z" | "-z";
  readonly lengthBlocks: number;
  readonly halfWidthBlocks: number;
  /** 本次覆盖的格子（recordScanned 用）。 */
  readonly cell: PatrolCell;
  /** 与 deterministic-goals roof 模板对齐的 goal 文本。 */
  readonly goalText: string;
}

const DEFAULT_CELL_SIZE = 128;
const DEFAULT_MAX_RING = 32;
const DEFAULT_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

export function patrolCellKey(cell: PatrolCell): string {
  return `${cell.gx},${cell.gz}`;
}

function cellOrigin(cell: PatrolCell, cellSize: number): { x: number; z: number } {
  return { x: cell.gx * cellSize, z: cell.gz * cellSize };
}

/**
 * 依 scanState 选下一条要扫的走廊。锚点格所在环优先，环内字典序；
 * 从未扫描的格子先于过期格子（同为候选时按环序自然裁决）。
 */
export function nextPatrolCorridor(
  scanState: PatrolScanState,
  options: PatrolGridOptions,
  nowMs: number,
): PatrolCorridor | null {
  const cellSize = options.cellSizeBlocks ?? DEFAULT_CELL_SIZE;
  const maxRing = options.maxRing ?? DEFAULT_MAX_RING;
  const stalenessMs = options.stalenessMs ?? DEFAULT_STALENESS_MS;

  const anchorGx = Math.floor(options.anchorX / cellSize);
  const anchorGz = Math.floor(options.anchorZ / cellSize);

  for (let ring = 0; ring <= maxRing; ring += 1) {
    const cells = ringCells(anchorGx, anchorGz, ring);
    for (const cell of cells) {
      const key = patrolCellKey(cell);
      const lastScanned = scanState.get(key);
      const stale = lastScanned === undefined || nowMs - lastScanned > stalenessMs;
      if (!stale) continue;
      const origin = cellOrigin(cell, cellSize);
      return {
        originX: origin.x,
        originZ: origin.z,
        direction: "+x",
        lengthBlocks: cellSize,
        halfWidthBlocks: Math.floor(cellSize / 2),
        cell,
        goalText: `roof 扫描走廊：起点 x=${origin.x} y=128 z=${origin.z}，沿 +x 扫 ${cellSize} 格`,
      };
    }
  }
  return null;
}

/** 环上的格子（Chebyshev 距离 === ring），环内按 (gx, gz) 字典序——确定性。 */
function ringCells(anchorGx: number, anchorGz: number, ring: number): readonly PatrolCell[] {
  if (ring === 0) return [{ gx: anchorGx, gz: anchorGz }];
  const cells: PatrolCell[] = [];
  for (let gx = anchorGx - ring; gx <= anchorGx + ring; gx += 1) {
    for (let gz = anchorGz - ring; gz <= anchorGz + ring; gz += 1) {
      if (Math.max(Math.abs(gx - anchorGx), Math.abs(gz - anchorGz)) === ring) {
        cells.push({ gx, gz });
      }
    }
  }
  return cells;
}

/** 走廊扫完记账（调用方持久化 scanState——roof 巡逻游标）。 */
export function recordCorridorScanned(
  scanState: Map<string, number>,
  cell: PatrolCell,
  nowMs: number,
): void {
  scanState.set(patrolCellKey(cell), nowMs);
}
