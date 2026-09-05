"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { FacilitySlotStrip } from "@/components/blueprint-grid";
import { BaseOperations } from "@/components/base-operations";
import { StatusBadge } from "@/components/status-badges";
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
      if (!response.ok || body.status === "unreachable") throw new Error(body.message ?? `HTTP ${response.status}`);
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

export function BasesConsole() {
  const { view, notice, failed, loaded, refresh } = useSharedState();
  if (!loaded) return <LoadingState label="读取基地视图" />;
  if (failed && !view) return <ErrorState title="基地数据读取失败" detail={failed} />;
  if (notice) return <EmptyState title="基地数据不可用" hint={notice} />;
  return <BaseOperations view={view} failed={failed} refresh={refresh} />;
}

export function SharedStateConsole() {
  const { view, notice, failed, loaded } = useSharedState();
  const workstationRows = useMemo(
    () => (view?.workstations ?? []).slice().sort((a, b) => a.serverProfileId.localeCompare(b.serverProfileId) || a.type.localeCompare(b.type)),
    [view],
  );

  if (!loaded) return <LoadingState label="读取共享状态" />;
  if (failed && !view) return <ErrorState title="共享状态读取失败" detail={failed} />;
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
