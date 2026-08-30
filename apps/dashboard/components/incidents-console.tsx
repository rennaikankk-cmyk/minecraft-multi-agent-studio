"use client";

import { useCallback, useEffect, useState } from "react";

import { EmptyState, ErrorState, LoadingState, MetricCard } from "@/components/data-states";
import { BaseStatusBadge, StatusBadge } from "@/components/status-badges";

const POLL_MS = 10_000;

interface IncidentIssueView {
  incidentId: string;
  type: string;
  primaryFailureCode: string;
  maxSeverity: string;
  suspectedLayer: string;
  classifierRuleId: string;
  confidenceBand: string;
  status: string;
  verificationStatus: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  affectedBotIds: string[];
  affectedServerProfileIds: string[];
}

interface IncidentOccurrenceView {
  occurrenceId: string;
  occurredAt: string;
  botId: string | null;
  goal: string | null;
  skillId: string | null;
  phase: string | null;
  failureCode: string;
  expected: string | null;
  actual: string | null;
  eventWindow: Array<{ at: string; kind: string; detail?: string }>;
}

function severityTone(severity: string): "ok" | "warn" | "bad" | "muted" | "info" {
  switch (severity) {
    case "CRITICAL": return "bad";
    case "ERROR": return "bad";
    case "WARNING": return "warn";
    default: return "muted";
  }
}

export function IncidentsConsole() {
  const [issues, setIssues] = useState<IncidentIssueView[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ issue: IncidentIssueView; occurrences: IncidentOccurrenceView[] } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/incidents", { cache: "no-store" });
      const body = (await response.json()) as { status?: string; issues?: IncidentIssueView[]; message?: string };
      if (body.status === "ok") {
        setIssues(body.issues ?? []);
        setNotice(null);
      } else {
        setNotice(body.message ?? "Incident 数据不可用");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "unknown");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const openDetail = useCallback(async (incidentId: string) => {
    if (open === incidentId) {
      setOpen(null);
      setDetail(null);
      return;
    }
    setOpen(incidentId);
    setDetail(null);
    try {
      const response = await fetch(`/api/incidents/${incidentId}`, { cache: "no-store" });
      const body = (await response.json()) as { status?: string; issue?: IncidentIssueView; occurrences?: IncidentOccurrenceView[] };
      if (body.status === "ok" && body.issue) {
        setDetail({ issue: body.issue, occurrences: body.occurrences ?? [] });
      } else {
        setNotice(body.status === "not_found" ? "该 Incident 不存在（可能已被 retention 清理）。" : "Incident 详情读取失败。");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "unknown");
    }
  }, [open]);

  if (!loaded) return <LoadingState label="读取 Incident 列表" />;
  if (notice && !issues) return <EmptyState title="Incident 数据不可用" hint={notice} />;

  const critical = (issues ?? []).filter((issue) => issue.maxSeverity === "CRITICAL").length;
  const openCount = (issues ?? []).filter((issue) => issue.status === "open").length;
  const layerCounts = new Map<string, number>();
  for (const issue of issues ?? []) {
    layerCounts.set(issue.suspectedLayer, (layerCounts.get(issue.suspectedLayer) ?? 0) + issue.occurrenceCount);
  }
  const topLayers = [...layerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);

  return (
    <section className="stack">
      <div className="metricRow">
        <MetricCard label="Open" value={openCount} tone={openCount > 0 ? "info" : undefined} />
        <MetricCard label="Critical" value={critical} tone={critical > 0 ? "bad" : undefined} />
        <MetricCard label="Issues（去重后）" value={issues?.length ?? 0} />
        {topLayers.map(([layer, count]) => (
          <MetricCard key={layer} label={`${layer} 层`} value={count} sub="occurrences" />
        ))}
      </div>
      {notice ? <p className="hint"><StatusBadge tone="warn">STALE</StatusBadge> {notice}</p> : null}
      <p className="hint">
        同一 fingerprint 的重复失败聚合为一个 Issue（occurrenceCount 递增）；suspectedLayer 来自确定性规则
        （ruleId + confidence），不是把失败默认归咎 Skill。
      </p>

      {(issues ?? []).length === 0 ? (
        <EmptyState title="没有 Incident" hint="Bot 崩溃、卡住阈值、假成功等真实失败出现后会自动出现在这里；普通 retry 不会制造噪音。" />
      ) : (
        (issues ?? []).map((issue) => (
          <div key={issue.incidentId} className="panel">
            <header className="panelHeader">
              <h3>{issue.incidentId}</h3>
              <BaseStatusBadge status={issue.status} />
              <StatusBadge tone={severityTone(issue.maxSeverity)}>{issue.maxSeverity}</StatusBadge>
              <span className="hint">{issue.type} · {issue.primaryFailureCode}</span>
              <span className="hint">层 {issue.suspectedLayer}（{issue.classifierRuleId}/{issue.confidenceBand}）</span>
              <span className="hint">×{issue.occurrenceCount} · bots {issue.affectedBotIds.length}</span>
              <button type="button" onClick={() => void openDetail(issue.incidentId)}>{open === issue.incidentId ? "收起" : "详情"}</button>
            </header>
            {open === issue.incidentId ? (
              detail === null ? <LoadingState label="读取详情" /> : (
                <div className="stack">
                  <p className="hint">first {detail.issue.firstSeenAt} · last {detail.issue.lastSeenAt} · 验证 {detail.issue.verificationStatus}</p>
                  {detail.occurrences.map((occurrence) => (
                    <div key={occurrence.occurrenceId} className="subPanel">
                      <header className="panelHeader">
                        <strong>{occurrence.occurrenceId}</strong>
                        <span className="hint">{occurrence.occurredAt}</span>
                        <span className="hint">{occurrence.botId ?? "无 bot"}</span>
                        <span className="hint">{occurrence.goal ?? "—"} / {occurrence.skillId ?? "—"} / {occurrence.phase ?? "—"}</span>
                      </header>
                      <div className="expectedActual">
                        <div><strong>Expected</strong><pre>{occurrence.expected ?? "—"}</pre></div>
                        <div><strong>Actual</strong><pre>{occurrence.actual ?? "—"}</pre></div>
                      </div>
                      {occurrence.eventWindow.length > 0 ? (
                        <ul className="timeline">
                          {occurrence.eventWindow.map((entry, index) => (
                            <li key={index}>{entry.at} {entry.kind}{entry.detail ? ` — ${entry.detail}` : ""}</li>
                          ))}
                        </ul>
                      ) : <p className="hint">无事件窗口。</p>}
                    </div>
                  ))}
                </div>
              )
            ) : null}
          </div>
        ))
      )}
    </section>
  );
}
