// ---------------------------------------------------------------------------
// DataTable + Loading/Empty/Error 状态组件（四十一节：每页处理六态）
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";

export function LoadingState({ label = "加载中" }: { label?: string }) {
  return (
    <div className="stateBox" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="stateBox empty" role="status">
      <strong>{title}</strong>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="stateBox error" role="alert">
      <strong>{title}</strong>
      {detail ? <p className="hint">{detail}</p> : null}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode | undefined;
  tone?: "ok" | "warn" | "bad" | "info" | undefined;
}) {
  return (
    <div className={`metricCard${tone ? ` metric-${tone}` : ""}`}>
      <span className="metricLabel">{label}</span>
      <span className="metricValue">{value}</span>
      {sub ? <span className="metricSub">{sub}</span> : null}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyTitle,
  emptyHint,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  emptyTitle: string;
  emptyHint?: string | undefined;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} {...(emptyHint === undefined ? {} : { hint: emptyHint })} />;
  }
  return (
    <div className="tableScroll">
      <table className="dataTable">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.className}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.className}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
