"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { EmptyState, ErrorState, LoadingState, MetricCard } from "@/components/data-states";
import { BaseStatusBadge, StatusBadge } from "@/components/status-badges";

const POLL_MS = 10_000;

interface IncidentIssueView {
  incidentId: string;
  type: string;
  primaryFailureCode: string;
  terminalFailureCode?: string | null;
  maxSeverity: string;
  suspectedLayer: string;
  classifierRuleId: string;
  confidenceBand: string;
  status: string;
  verificationStatus: string;
  fingerprint?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  retainedOccurrenceCount?: number;
  affectedBotIds: string[];
  affectedServerProfileIds: string[];
  representativeOccurrenceId?: string | null;
}

interface IncidentOccurrenceView {
  occurrenceId: string;
  occurredAt: string;
  botId: string | null;
  sessionId: string | null;
  gitCommit: string | null;
  dirtyBuild?: boolean | null;
  minecraftVersion: string | null;
  protocolVersion: number | null;
  goal: string | null;
  skillId: string | null;
  phase: string | null;
  failureCode: string;
  terminalFailureCode?: string | null;
  causedByFailureCodes?: string[];
  expected: string | null;
  actual: string | null;
  position: { x: number; y: number; z: number } | null;
  dimension: string | null;
  eventWindow: Array<{ at: string; kind: string; detail?: string }>;
  evidenceStripped?: boolean;
}

interface WriterHealthView {
  dirty: boolean;
  droppedWriteCount: number;
  flushCount: number;
  lastFlushAt: string | null;
  lastFlushError: string | null;
  quarantinedCount: number;
  restoredFromBackupCount: number;
  approxStoreBytes: number;
  maxDiskBytes: number;
  diskPressure: boolean;
  evidenceDroppedCount: number;
  pinnedIssueCount: number;
  lifetimeOccurrences: number;
  retainedOccurrences: number;
}

type TimeWindow = "all" | "1h" | "24h";

function severityTone(severity: string): "ok" | "warn" | "bad" | "muted" | "info" {
  switch (severity) {
    case "CRITICAL": return "bad";
    case "ERROR": return "bad";
    case "WARNING": return "warn";
    default: return "muted";
  }
}

function sinceForWindow(window: TimeWindow): string | null {
  if (window === "1h") return new Date(Date.now() - 3_600_000).toISOString();
  if (window === "24h") return new Date(Date.now() - 86_400_000).toISOString();
  return null;
}

export function IncidentsConsole() {
  const [issues, setIssues] = useState<IncidentIssueView[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ issue: IncidentIssueView; occurrences: IncidentOccurrenceView[] } | null>(null);
  const [writer, setWriter] = useState<WriterHealthView | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // filters（支持 URL 预设：?bot= / ?server= / ?layer=）
  const [quick, setQuick] = useState<"none" | "open" | "critical">("none");
  const [layer, setLayer] = useState<string>("");
  const [botFilter, setBotFilter] = useState<string>("");
  const [serverFilter, setServerFilter] = useState<string>("");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("all");

  const [initialFilters] = useState(() => {
    if (typeof window === "undefined") return { bot: "", server: "", layer: "" };
    const params = new URLSearchParams(window.location.search);
    return {
      bot: params.get("bot") ?? "",
      server: params.get("server") ?? "",
      layer: params.get("layer") ?? "",
    };
  });
  const [appliedBot, setAppliedBot] = useState(initialFilters.bot);
  const [appliedServer, setAppliedServer] = useState(initialFilters.server);
  const [appliedLayer, setAppliedLayer] = useState(initialFilters.layer);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    const since = sinceForWindow(timeWindow);
    if (since) params.set("since", since);
    if (appliedLayer) params.set("suspectedLayer", appliedLayer);
    if (appliedBot) params.set("botId", appliedBot);
    if (appliedServer) params.set("serverProfileId", appliedServer);
    return params.toString();
  }, [timeWindow, appliedLayer, appliedBot, appliedServer]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/incidents${query ? `?${query}` : ""}`, { cache: "no-store" });
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
  }, [query]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/incidents/health", { cache: "no-store" });
        const body = (await response.json()) as { status?: string; writer?: WriterHealthView };
        if (body.status === "ok" && body.writer) setWriter(body.writer);
      } catch {
        // writer health 不可用不阻塞列表
      }
    })();
  }, []);

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

  const download = useCallback(async (path: string, fallbackName: string) => {
    setExportNotice(null);
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { message?: string } | null;
        setExportNotice(`导出失败：${detail?.message ?? `HTTP ${response.status}`}`);
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? fallbackName;
      anchor.click();
      URL.revokeObjectURL(url);
      setExportNotice("下载已开始。");
    } catch (error) {
      setExportNotice(`导出失败：${error instanceof Error ? error.message : "unknown"}`);
    }
  }, []);

  const copyRepairPrompt = useCallback(async (incidentId: string) => {
    setExportNotice(null);
    try {
      const response = await fetch(`/api/incidents/${incidentId}/export?format=repair-prompt`, { cache: "no-store" });
      if (!response.ok) {
        setExportNotice(`repair prompt 获取失败（HTTP ${response.status}）。`);
        return;
      }
      const text = await response.text();
      await navigator.clipboard.writeText(text);
      setExportNotice("repair prompt 已复制到剪贴板。");
    } catch (error) {
      setExportNotice(`复制失败：${error instanceof Error ? error.message : "unknown"}`);
    }
  }, []);

  const postAction = useCallback(async (incidentId: string, action: "status" | "verification", payload: Record<string, unknown>) => {
    setExportNotice(null);
    try {
      const response = await fetch(`/api/incidents/${incidentId}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Studio-Action": action === "status" ? "incident-status" : "incident-verification",
        },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { status?: string; message?: string };
      if (!response.ok) {
        setExportNotice(`操作被拒绝：${body.message ?? `HTTP ${response.status}`}`);
        return;
      }
      await refresh();
      if (open === incidentId) await openDetail(incidentId);
    } catch (error) {
      setExportNotice(`操作失败：${error instanceof Error ? error.message : "unknown"}`);
    }
  }, [refresh, open, openDetail]);

  if (!loaded) return <LoadingState label="读取 Incident 列表" />;
  if (notice && !issues) return <EmptyState title="Incident 数据不可用" hint={notice} />;

  const filtered = (issues ?? []).filter((issue) => {
    if (quick === "open" && issue.status !== "open" && issue.status !== "investigating") return false;
    if (quick === "critical" && issue.maxSeverity !== "CRITICAL") return false;
    return true;
  });
  const critical = filtered.filter((issue) => issue.maxSeverity === "CRITICAL").length;
  const openCount = filtered.filter((issue) => issue.status === "open" || issue.status === "investigating").length;
  const hourCutoff = new Date(Date.now() - 3_600_000).toISOString();
  const newLastHour = filtered.filter((issue) => issue.firstSeenAt >= hourCutoff).length;
  const repeated = filtered.filter((issue) => issue.occurrenceCount > 1).length;
  const layerCounts = new Map<string, number>();
  const codeCounts = new Map<string, number>();
  for (const issue of filtered) {
    layerCounts.set(issue.suspectedLayer, (layerCounts.get(issue.suspectedLayer) ?? 0) + issue.occurrenceCount);
    codeCounts.set(issue.primaryFailureCode, (codeCounts.get(issue.primaryFailureCode) ?? 0) + issue.occurrenceCount);
  }
  const topLayers = [...layerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topCodes = [...codeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  return (
    <section className="stack">
      <div className="metricRow">
        <MetricCard label="Open" value={openCount} tone={openCount > 0 ? "info" : undefined} />
        <MetricCard label="Critical" value={critical} tone={critical > 0 ? "bad" : undefined} />
        <MetricCard label="New（1h）" value={newLastHour} tone={newLastHour > 0 ? "warn" : undefined} />
        <MetricCard label="Repeated" value={repeated} sub="occurrenceCount>1" />
        {topLayers.map(([layerName, count]) => (
          <button key={layerName} type="button" className="metricCard" onClick={() => { setAppliedLayer(layerName); setQuick("none"); }}>
            <MetricCard label={`${layerName} 层`} value={count} sub="occurrences" />
          </button>
        ))}
        {topCodes.map(([code, count]) => (
          <MetricCard key={code} label={code} value={count} sub="occurrences" />
        ))}
      </div>

      <div className="panel">
        <header className="panelHeader"><h3>筛选</h3></header>
        <div className="filterBar">
          <label>
            快速
            <select value={quick} onChange={(event) => setQuick(event.target.value as typeof quick)}>
              <option value="none">全部</option>
              <option value="open">Open/Investigating</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label>
            疑似层
            <select value={appliedLayer} onChange={(event) => setAppliedLayer(event.target.value)}>
              <option value="">全部</option>
              {["SKILL", "PATHFINDING", "RUNTIME", "COORDINATOR", "WORLD_STATE", "WORKSTATION", "FACILITY", "BASE", "BUILD", "LLM", "SERVER", "NETWORK", "VERSION_COMPAT", "UNKNOWN"].map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            Bot
            <input value={appliedBot} placeholder="studio-bot-01" onChange={(event) => setAppliedBot(event.target.value)} />
          </label>
          <label>
            Server Profile
            <input value={appliedServer} placeholder="sp-…" onChange={(event) => setAppliedServer(event.target.value)} />
          </label>
          <label>
            时间窗
            <select value={timeWindow} onChange={(event) => setTimeWindow(event.target.value as TimeWindow)}>
              <option value="all">全部</option>
              <option value="1h">最近 1 小时</option>
              <option value="24h">最近 24 小时</option>
            </select>
          </label>
          <button type="button" onClick={() => { setQuick("none"); setAppliedLayer(""); setAppliedBot(""); setAppliedServer(""); setTimeWindow("all"); }}>清除</button>
          <button type="button" onClick={() => void download(`/api/incidents/export?scope=open&format=json`, "incidents-open.json")}>Export Open (JSON)</button>
          <button type="button" onClick={() => void download(`/api/incidents/export?scope=last24h&format=zip`, "incidents-last24h.zip")}>Export Last 24h (ZIP)</button>
          <button type="button" onClick={() => void download(`/api/diagnostics/export?from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`, "bot-diagnostics-last24h.zip")}>Export Bot Diagnostics (24h)</button>
        </div>
        {writer ? (
          <p className="hint">
            writer：flush {writer.flushCount} 次 · store {(writer.approxStoreBytes / 1024).toFixed(0)}KB / {(writer.maxDiskBytes / 1024 / 1024).toFixed(0)}MB
            {writer.diskPressure ? <StatusBadge tone="bad">DISK PRESSURE</StatusBadge> : null}
            {writer.droppedWriteCount > 0 ? <StatusBadge tone="warn">DROPPED WRITES ×{writer.droppedWriteCount}</StatusBadge> : null}
            {writer.quarantinedCount > 0 ? <StatusBadge tone="warn">QUARANTINED ×{writer.quarantinedCount}</StatusBadge> : null}
            {writer.restoredFromBackupCount > 0 ? <StatusBadge tone="info">BACKUP RESTORED ×{writer.restoredFromBackupCount}</StatusBadge> : null}
            {writer.evidenceDroppedCount > 0 ? <StatusBadge tone="warn">EVIDENCE DROPPED ×{writer.evidenceDroppedCount}</StatusBadge> : null}
          </p>
        ) : null}
        {exportNotice ? <p className="hint">{exportNotice}</p> : null}
      </div>

      {notice ? <p className="hint"><StatusBadge tone="warn">STALE</StatusBadge> {notice}</p> : null}
      <p className="hint">
        同一 fingerprint 的重复失败聚合为一个 Issue（lifetime {">"}= retained 计数）；suspectedLayer 来自确定性规则
        （ruleId + confidence），recovery exhausted 只作终态、不默认归咎 Skill。
      </p>

      {filtered.length === 0 ? (
        <EmptyState title="没有匹配的 Incident" hint="调整筛选条件；Bot 崩溃、卡住阈值、假成功等真实失败出现后会自动出现在这里。" />
      ) : (
        filtered.map((issue) => (
          <div key={issue.incidentId} className="panel">
            <header className="panelHeader">
              <h3>{issue.incidentId}</h3>
              <BaseStatusBadge status={issue.status} />
              <StatusBadge tone={severityTone(issue.maxSeverity)}>{issue.maxSeverity}</StatusBadge>
              <span className="hint">{issue.type} · {issue.primaryFailureCode}{issue.terminalFailureCode ? ` → terminal ${issue.terminalFailureCode}` : ""}</span>
              <span className="hint">层 {issue.suspectedLayer}（{issue.classifierRuleId}/{issue.confidenceBand}）</span>
              <span className="hint">×{issue.occurrenceCount}{issue.retainedOccurrenceCount !== undefined && issue.retainedOccurrenceCount !== issue.occurrenceCount ? `（保留 ${issue.retainedOccurrenceCount}）` : ""}</span>
              <span className="hint">bots {issue.affectedBotIds.length} · servers {issue.affectedServerProfileIds.length}</span>
              <button type="button" onClick={() => void openDetail(issue.incidentId)}>{open === issue.incidentId ? "收起" : "详情"}</button>
            </header>
            <p className="hint">first {issue.firstSeenAt} · last {issue.lastSeenAt} · 验证 {issue.verificationStatus}{issue.fingerprint ? ` · ${issue.fingerprint}` : ""}</p>
            {open === issue.incidentId ? (
              detail === null ? <LoadingState label="读取详情" /> : (
                <div className="stack">
                  <div className="filterBar">
                    <button type="button" onClick={() => void download(`/api/incidents/${issue.incidentId}/export?format=json`, `${issue.incidentId}.json`)}>Download JSON</button>
                    <button type="button" onClick={() => void download(`/api/incidents/${issue.incidentId}/export?format=markdown`, `${issue.incidentId}.md`)}>Download Markdown</button>
                    <button type="button" onClick={() => void download(`/api/incidents/${issue.incidentId}/export?format=zip`, `incident-${issue.incidentId}.zip`)}>Export ZIP Bundle</button>
                    <button type="button" onClick={() => void copyRepairPrompt(issue.incidentId)}>Copy Repair Prompt</button>
                    <button type="button" onClick={() => void download(`/api/incidents/${issue.incidentId}/export?format=repair-prompt`, `${issue.incidentId}-repair-prompt.txt`)}>Download Repair Prompt</button>
                  </div>
                  <div className="filterBar">
                    {issue.status === "open" ? (
                      <button type="button" onClick={() => void postAction(issue.incidentId, "status", { status: "investigating" })}>标记 Investigating</button>
                    ) : null}
                    {issue.status === "investigating" || issue.status === "known_issue" ? (
                      <>
                        <button type="button" onClick={() => void postAction(issue.incidentId, "verification", { action: "request" })}>请求验证</button>
                        <button type="button" onClick={() => void postAction(issue.incidentId, "verification", { action: "record", result: "passed" })}>记录验证通过</button>
                        <button type="button" onClick={() => void postAction(issue.incidentId, "status", { status: "fixed", fixedByCommit: "pending" })}>标记 Fixed（需验证通过）</button>
                        <button type="button" onClick={() => void postAction(issue.incidentId, "status", { status: "known_issue" })}>标记 Known Issue</button>
                      </>
                    ) : null}
                    {issue.status !== "ignored" ? (
                      <button type="button" onClick={() => void postAction(issue.incidentId, "status", { status: "ignored" })}>Ignore</button>
                    ) : null}
                    {issue.status !== "open" ? (
                      <button type="button" onClick={() => void postAction(issue.incidentId, "status", { status: "open" })}>重开</button>
                    ) : null}
                  </div>
                  {detail.occurrences.length === 0 ? (
                    <p className="hint">没有保留的 occurrence（retention 已裁剪证据；lifetime 计数 {detail.issue.occurrenceCount}）。</p>
                  ) : detail.occurrences.map((occurrence) => (
                    <div key={occurrence.occurrenceId} className="subPanel">
                      <header className="panelHeader">
                        <strong>{occurrence.occurrenceId}</strong>
                        <span className="hint">{occurrence.occurredAt}</span>
                        <span className="hint">{occurrence.botId ?? "无 bot"}</span>
                        <span className="hint">{occurrence.goal ?? "—"} / {occurrence.skillId ?? "—"} / {occurrence.phase ?? "—"}</span>
                        {occurrence.evidenceStripped ? <StatusBadge tone="warn">EVIDENCE STRIPPED</StatusBadge> : null}
                      </header>
                      <p className="hint">
                        {occurrence.gitCommit ? `commit ${occurrence.gitCommit}${occurrence.dirtyBuild ? "（dirty build）" : ""}` : "commit 未知"}
                        {" · "}{occurrence.minecraftVersion ?? "MC ?"}（proto {occurrence.protocolVersion ?? "?"}）
                        {occurrence.position ? ` · pos ${occurrence.position.x},${occurrence.position.y},${occurrence.position.z}` : ""}
                      </p>
                      {occurrence.causedByFailureCodes && occurrence.causedByFailureCodes.length > 0 ? (
                        <p className="hint">因果链：{occurrence.causedByFailureCodes.join(" → ")}{occurrence.terminalFailureCode ? ` → terminal ${occurrence.terminalFailureCode}` : ""}</p>
                      ) : null}
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
                      ) : <p className="hint">无事件窗口（或已因磁盘压力剥离）。</p>}
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
