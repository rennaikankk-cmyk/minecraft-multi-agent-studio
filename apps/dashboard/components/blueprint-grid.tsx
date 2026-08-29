// ---------------------------------------------------------------------------
// Blueprint 2D 网格（二十四节：Y 层切换；状态不只靠颜色；支持多模块多 Y 层）
//
// 纯几何变换 buildGrid() 可单测；未来 7×7 模块网格同样适用（不写死 5×5）。
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";

import { FacilitySlotBadge, facilitySlotLabel, facilitySlotTone } from "@/components/status-badges";

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

function cellGlyph(cell: BlueprintCellView): string {
  // 字符冗余标识（不只靠颜色）
  switch (cell.blockClass) {
    case "foundation": return "▦";
    case "shell": return "▤";
    case "structural": return "▩";
    case "utility": return "⛏";
    case "decoration": return "✦";
    default: return "▪";
  }
}

export function BlueprintGrid({ cells, anchor }: { cells: readonly BlueprintCellView[]; anchor?: { x: number; y: number; z: number } }) {
  const { levels, rowsByLevel, bounds } = useMemo(() => buildGrid(cells), [cells]);
  const [level, setLevel] = useState<number>(levels[0] ?? 0);
  const [selected, setSelected] = useState<BlueprintCellView | null>(null);

  if (cells.length === 0) {
    return (
      <div className="stateBox empty">
        <strong>无蓝图数据</strong>
        <p className="hint">该 Base 没有可展示的 blueprint cells（可能尚未开始施工或快照为空）。</p>
      </div>
    );
  }

  const rows = rowsByLevel.get(level) ?? [];

  return (
    <div className="blueprintView">
      <div className="levelSwitch" role="tablist" aria-label="Y 层切换">
        {levels.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={candidate === level}
            className={candidate === level ? "active" : ""}
            onClick={() => setLevel(candidate)}
          >
            Y={candidate}
          </button>
        ))}
      </div>
      <div className="gridFrame">
        <table className="blueprintTable">
          <tbody>
            {rows.map((row) => (
              <tr key={row.z}>
                <th scope="row" className="gridAxis">z{row.z}</th>
                {Array.from({ length: bounds.maxX - bounds.minX + 1 }, (_, columnX) => {
                  const x = bounds.minX + columnX;
                  const cell = row.cells.find((candidate) => candidate.offset.x === x);
                  if (!cell) return <td key={x} className="gridCell void" aria-label={`空 (${x},${row.z})`} />;
                  const tone = facilitySlotTone(cell.reconcileStatus);
                  return (
                    <td key={x}>
                      <button
                        type="button"
                        className={`gridCell cell-${tone}`}
                        title={`${cell.itemName} · ${facilitySlotLabel(cell.reconcileStatus)}`}
                        onClick={() => setSelected(cell)}
                      >
                        <span aria-hidden="true">{cellGlyph(cell)}</span>
                        <span className="cellName">{shortName(cell.itemName)}</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <dl className="cellDetail">
          <div><dt>Local Offset</dt><dd>{selected.offset.x}, {selected.offset.y}, {selected.offset.z}</dd></div>
          <div><dt>World Position</dt><dd>{anchor ? `${anchor.x + selected.offset.x}, ${anchor.y + selected.offset.y}, ${anchor.z + selected.offset.z}` : "—"}</dd></div>
          <div><dt>Expected</dt><dd>{selected.itemName}</dd></div>
          <div><dt>Actual</dt><dd>{selected.observedItemName ?? "未观测"}</dd></div>
          <div><dt>Block Class</dt><dd>{selected.blockClass}</dd></div>
          <div><dt>Reconcile</dt><dd><FacilitySlotBadge status={selected.reconcileStatus} /></dd></div>
          <div className="cellDetailClose">
            <button type="button" onClick={() => setSelected(null)}>关闭</button>
          </div>
        </dl>
      ) : (
        <p className="hint">点击格子查看世界坐标 / 期望 / 实际 / 对账状态。</p>
      )}
    </div>
  );
}

function shortName(name: string): string {
  return name.replace(/^minecraft:/, "").slice(0, 10);
}

export function FacilitySlotStrip({
  slots,
}: {
  slots: ReadonlyArray<{ slotId: string; index: number; workstationType: string; status: string; reservedBy: string | null; statusReason: string | null; failureCount: number }>;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (slots.length === 0) return <p className="hint">无 slot。</p>;
  return (
    <div className="facilityStrip">
      <div className="slotRow" aria-label="facility slots">
        {slots.map((slot) => (
          <button
            key={slot.slotId}
            type="button"
            className={`slotCell cell-${facilitySlotTone(slot.status)}`}
            title={`${slot.slotId} · ${facilitySlotLabel(slot.status)}`}
            onClick={() => setOpen(open === slot.index ? null : slot.index)}
          >
            {slot.workstationType === "furnace" ? "F" : slot.workstationType.slice(0, 1).toUpperCase()}
          </button>
        ))}
      </div>
      {open !== null ? (
        <dl className="cellDetail">
          {(() => {
            const slot = slots.find((candidate) => candidate.index === open);
            if (!slot) return null;
            return (
              <>
                <div><dt>Slot ID</dt><dd>{slot.slotId}</dd></div>
                <div><dt>Workstation</dt><dd>{slot.workstationType}</dd></div>
                <div><dt>State</dt><dd><FacilitySlotBadge status={slot.status} /></dd></div>
                <div><dt>Reservation</dt><dd>{slot.reservedBy ?? "—"}</dd></div>
                <div><dt>Reason</dt><dd>{slot.statusReason ?? "—"}</dd></div>
                <div><dt>Failures</dt><dd>{slot.failureCount}</dd></div>
              </>
            );
          })()}
        </dl>
      ) : null}
      <p className="hint">F=furnace；点击查看 slotId / 预约 / 失败计数。</p>
    </div>
  );
}
