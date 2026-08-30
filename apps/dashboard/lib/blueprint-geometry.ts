// 蓝图 2D 网格几何纯函数（从 blueprint-grid.tsx 抽出，供组件与测试共用，无 JSX）

export interface BlueprintCellView {
  /** 本地 offset（蓝图坐标）。 */
  offset: { x: number; y: number; z: number };
  itemName: string;
  blockClass: string;
  /** 对账状态（无对账数据时为 unknown）。 */
  reconcileStatus: string;
  observedItemName?: string | null;
}

export interface GridRow {
  z: number;
  cells: BlueprintCellView[]; // 按 x 升序
}

/** cells → 按 Y 层分组的行（纯函数）。 */
export function buildGrid(cells: readonly BlueprintCellView[]): {
  levels: number[];
  rowsByLevel: Map<number, GridRow[]>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
} {
  const levels = [...new Set(cells.map((cell) => cell.offset.y))].sort((a, b) => a - b);
  const rowsByLevel = new Map<number, GridRow[]>();
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const cell of cells) {
    minX = Math.min(minX, cell.offset.x);
    maxX = Math.max(maxX, cell.offset.x);
    minZ = Math.min(minZ, cell.offset.z);
    maxZ = Math.max(maxZ, cell.offset.z);
  }
  for (const level of levels) {
    const levelCells = cells.filter((cell) => cell.offset.y === level);
    const zs = [...new Set(levelCells.map((cell) => cell.offset.z))].sort((a, b) => b - a); // 北（-z）在上
    rowsByLevel.set(
      level,
      zs.map((z) => ({
        z,
        cells: levelCells
          .filter((cell) => cell.offset.z === z)
          .sort((a, b) => a.offset.x - b.offset.x),
      })),
    );
  }
  const safeBounds =
    cells.length === 0
      ? { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }
      : { minX, maxX, minZ, maxZ };
  return { levels, rowsByLevel, bounds: safeBounds };
}
