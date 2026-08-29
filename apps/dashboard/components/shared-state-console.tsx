"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { BlueprintGrid, FacilitySlotStrip, type BlueprintCellView } from "@/components/blueprint-grid";
import { BaseStatusBadge, StatusBadge } from "@/components/status-badges";
import { EmptyState, ErrorState, LoadingState, MetricCard } from "@/components/data-states";
import type { SharedStateView } from "@/lib/shared-state-client";

const POLL_MS = 10_000;

type SharedStateResponse =
  | ({ status?: "not_configured" | "unreachable"; message?: string } & Partial<SharedStateView>);

function useSharedState() {
  const [view, setView] = useState<SharedStateView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/shared-state", { cache: "no-store" });
      const body = (await response.json()) as SharedStateResponse;
      if (body.schemaVersion === "1.0" && body.bases && body.facilities && body.workstations) {
        setView(body as SharedStateView);
        setNotice(null);
      } else {
        setNotice(body.message ?? "共享状态不可用");
      }
      setFailed(null);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "unknown");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { view, notice, failed, loaded, refresh };
}

/** starter_base_v1 的确定性展示网格（无对账数据 → 全部 unknown，如实标注）。 */
function starterBaseCells(anchor: { x: number; y: number; z: number }): BlueprintCellView[] {
  const cells: BlueprintCellView[] = [];
  for (let x = 0; x <= 4; x += 1)
    for (let z = 0; z <= 4; z += 1)
      cells.push({ offset: { x, y: 0, z }, itemName: "cobblestone", blockClass: "foundation", reconcileStatus: "unknown" });
  for (let y = 1; y <= 2; y += 1)
    for (let x = 0; x <= 4; x += 1)
      for (let z = 0; z <= 4; z += 1) {
        const onPerimeter = x === 0 || x === 4 || z === 0 || z === 4;
        if (!onPerimeter || (x === 2 && z === 4)) continue;
        cells.push({ offset: { x, y, z }, itemName: "oak_planks", blockClass: "structural", reconcileStatus: "unknown" });
      }
  for (let ring = 0; ring <= 2; ring += 1)
    for (let x = ring; x <= 4 - ring; x += 1)
      for (let z = ring; z <= 4 - ring; z += 1) {
        const onRing = x === ring || x === 4 - ring || z === ring || z === 4 - ring;
        if (!onRing) continue;
        cells.push({ offset: { x, y: 3, z }, itemName: "oak_planks", blockClass: "shell", reconcileStatus: "unknown" });
      }
  cells.push({ offset: { x: 1, y: 1, z: 1 }, itemName: "furnace", blockClass: "utility", reconcileStatus: "unknown" });
  cells.push({ offset: { x: 3, y: 1, z: 1 }, itemName: "crafting_table", blockClass: "utility", reconcileStatus: "unknown" });
  cells.push({ offset: { x: 1, y: 1, z: 3 }, itemName: "chest", blockClass: "utility", reconcileStatus: "unknown" });
  cells.push({ offset: { x: 3, y: 1, z: 3 }, itemName: "torch", blockClass: "decoration", reconcileStatus: "unknown" });
  cells.push({ offset: { x: 2, y: 1, z: 2 }, itemName: "torch", blockClass: "decoration", reconcileStatus: "unknown" });
  return cells;
}

export function BasesConsole() {
  const { view, notice, failed, loaded } = useSharedState();
  const [openBase, setOpenBase] = useState<string | null>(null);

  if (!loaded) return <LoadingState label="读取基地视图" />;
  if (notice) return <EmptyState title="共享状态不可用" hint={`${notice}。Bases 页依赖 Coordinator SharedStateServer（STUDIO_SHARED_STATE_URL + STUDIO_SHARED_STATE_TOKEN）——未启用时不显示任何假基地。`} />;

  const bases = view?.bases ?? [];
  return (
    <section className="stack">
      <div className="metricRow">
        <MetricCard label="Bases" value={bases.length} />
        <MetricCard label="Facilities" value={view?.facilities.length ?? 0} />
        <MetricCard label="Workstations" value={view?.workstations.length ?? 0} />
        {view?.savedAt ? <MetricCard label="快照时间" value={<time dateTime={view.savedAt}>{new Date(view.savedAt).toLocaleTimeString()}</time>} /> : null}
      </div>
      {failed ? <p className="hint"><StatusBadge tone="warn">STALE</StatusBadge> 刷新失败：{failed}</p> : null}

      {bases.length === 0 ? (
        <EmptyState
          title="共享状态中没有 Base"
          hint="BaseRegistry 尚未登记任何基地。Bot 建造 starter_base_v1 并写入共享状态后会出现在这里。"
        />
      ) : (
        bases.map((base) => {
          const open = openBase === base.id;
          const facilities = (view?.facilities ?? []).filter((facility) => facility.baseId === base.id);
          return (
            <div key={base.id} className="panel">
              <header className="panelHeader">
                <h3>{base.name}</h3>
                <BaseStatusBadge status={base.status} />
                <span className="hint">{base.blueprintId}</span>
                <span className="hint">完整性 {(base.integrity01 * 100).toFixed(0)}%</span>
                <span className="hint">{base.serverProfileId} · {base.dimension} · 锚点 {base.anchor.x},{base.anchor.y},{base.anchor.z}</span>
                <button type="button" onClick={() => setOpenBase(open ? null : base.id)}>{open ? "收起" : "展开"}</button>
              </header>
              {open ? (
                <div className="stack">
                  <p className="hint">
                    蓝图为 starter_base_v1 参考展示（快照尚不含 cell 级对账 → 全部标 UNKNOWN，不伪造 MATCH）。
                    未来模块化基地（7×7 网格）同样按 Y 层渲染。
                  </p>
                  <BlueprintGrid cells={starterBaseCells(base.anchor)} anchor={base.anchor} />
                  {facilities.map((facility) => (
                    <div key={facility.id} className="subPanel">
                      <header className="panelHeader">
                        <strong>{facility.facilityType}</strong>
                        <span className="hint">{facility.id}</span>
                        <span className="hint">
                          {Object.entries(facility.slotCounts).map(([status, count]) => `${status}=${count}`).join(" · ")}
                        </span>
                      </header>
                      <FacilitySlotStrip slots={facility.slots} />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}

export function SharedStateConsole() {
  const { view, notice, failed, loaded } = useSharedState();
  const workstationRows = useMemo(
    () => (view?.workstations ?? []).slice().sort((a, b) => a.serverProfileId.localeCompare(b.serverProfileId) || a.type.localeCompare(b.type)),
    [view],
  );

  if (!loaded) return <LoadingState label="读取共享状态" />;
  if (notice) return <EmptyState title="共享状态不可用" hint={notice} />;

  return (
    <section className="stack">
      <div className="metricRow">
        <MetricCard label="Workstations" value={view?.workstations.length ?? 0} />
        <MetricCard label="Facilities" value={view?.facilities.length ?? 0} />
        <MetricCard label="Leases" value={(view?.workstations ?? []).filter((entry) => entry.leaseOwnerBotId !== null).length} tone="info" />
      </div>
      {failed ? <p className="hint"><StatusBadge tone="warn">STALE</StatusBadge> 刷新失败：{failed}</p> : null}

      <div className="panel">
        <h3>Workstation 观测与租约</h3>
        {workstationRows.length === 0 ? (
          <EmptyState title="没有 workstation 观测" hint="Bot 在真实服务器发现/登记工作站后写入共享状态。" />
        ) : (
          <div className="tableScroll">
            <table className="dataTable">
              <thead>
                <tr><th>类型</th><th>Server</th><th>维度</th><th>位置</th><th>模式</th><th>Lease Owner</th><th>Lease 到期</th><th>最后观测</th></tr>
              </thead>
              <tbody>
                {workstationRows.map((entry) => (
                  <tr key={`${entry.serverProfileId}|${entry.dimension}|${entry.position.x},${entry.position.y},${entry.position.z}`}>
                    <td>{entry.type}</td>
                    <td>{entry.serverProfileId}</td>
                    <td>{entry.dimension}</td>
                    <td>{entry.position.x}, {entry.position.y}, {entry.position.z}</td>
                    <td>{entry.usageMode}</td>
                    <td>{entry.leaseOwnerBotId ?? "—"}</td>
                    <td>{entry.leaseExpiresAtMs ? new Date(entry.leaseExpiresAtMs).toLocaleTimeString() : "—"}</td>
                    <td>{entry.lastSeenAt ? new Date(entry.lastSeenAt).toLocaleTimeString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Facilities 与 slot 预约</h3>
        {(view?.facilities ?? []).length === 0 ? (
          <EmptyState title="没有 facility" />
        ) : (
          (view?.facilities ?? []).map((facility) => (
            <div key={facility.id} className="subPanel">
              <header className="panelHeader">
                <strong>{facility.facilityType}</strong>
                <span className="hint">{facility.id}</span>
                <span className="hint">{facility.serverProfileId}/{facility.dimension}</span>
                {facility.baseId ? <span className="hint">base={facility.baseId}</span> : null}
              </header>
              <FacilitySlotStrip slots={facility.slots} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}
