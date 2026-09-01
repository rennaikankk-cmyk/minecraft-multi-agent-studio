"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { EmptyState, LoadingState } from "@/components/data-states";
import { StatusBadge } from "@/components/status-badges";

const POLL_MS = 10_000;

interface LocalTestResourceView {
  status: "not_running" | "starting" | "online";
  desiredState: string;
  managedByStudio: boolean;
  ownerSessionId: string | null;
  ownerManagerSessionId?: string | null;
  resourceId: string | null;
  lifecycle: string | null;
  containerId: string | null;
  hostPort: number | null;
  hostPortOpen?: boolean;
  players: { online: number; max: number; names: string[] } | null;
  uptimeMs: number | null;
  world: { volumeName: string; identity: string };
  minecraftVersion: string | null;
  protocolVersion: number | null;
  mode: string | null;
  seed: string | null;
  startedAt: string | null;
  shutdownPolicy?: string;
  capabilities?: { start: boolean; stop: boolean; restart: boolean; resetWorld: boolean; logs: boolean };
}

interface OperationView {
  operationId: string;
  kind: string;
  action: string;
  status: "running" | "succeeded" | "failed";
  result: { status?: string; error?: string } | null;
  error: string | null;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function LocalTestServerCard() {
  const [resource, setResource] = useState<LocalTestResourceView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [operation, setOperation] = useState<OperationView | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/servers/local-test", { cache: "no-store" });
      const body = (await response.json()) as { status?: string; resource?: LocalTestResourceView; message?: string };
      if (body.status === "ok" && body.resource) {
        setResource(body.resource);
        setNotice(null);
      } else {
        setNotice(body.message ?? "Local Test Server 状态不可用");
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

  // operation 轮询：pending/succeeded/failed 都是 observed 事实
  const pollOperation = useCallback((operationId: string) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    const tick = async () => {
      try {
        const response = await fetch(`/api/operations/${operationId}`, { cache: "no-store" });
        const body = (await response.json()) as { status?: string; operation?: OperationView };
        if (body.status === "ok" && body.operation) {
          setOperation(body.operation);
          if (body.operation.status === "running") {
            pollTimer.current = setTimeout(() => void tick(), 2_000);
            return;
          }
          void refresh();
        }
      } catch {
        pollTimer.current = setTimeout(() => void tick(), 2_000);
      }
    };
    void tick();
  }, [refresh]);

  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

  const runAction = useCallback(async (action: "start" | "stop" | "restart" | "reset") => {
    if (action === "reset" && !resetConfirm) {
      setResetConfirm(true);
      setNotice(`将删除 Local Test 世界（${resource?.world.identity ?? "studio-local-test-data"}）。再次点击确认执行；取消请点击其他区域。`);
      return;
    }
    setResetConfirm(false);
    setNotice(null);
    setOperation({ operationId: "…", kind: "local-test", action, status: "running", result: null, error: null });
    try {
      const response = await fetch(`/api/servers/local-test/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Studio-Action": `local-test-${action}`,
        },
        body: JSON.stringify(action === "reset" ? { confirmWorldIdentity: resource?.world.volumeName } : {}),
      });
      const body = (await response.json()) as { status?: string; operationId?: string | null; message?: string };
      if (!response.ok || !body.operationId) {
        setOperation(null);
        setNotice(`操作被拒绝：${body.message ?? `HTTP ${response.status}`}`);
        return;
      }
      pollOperation(body.operationId);
    } catch (error) {
      setOperation(null);
      setNotice(error instanceof Error ? error.message : "unknown");
    }
  }, [pollOperation, resetConfirm, resource]);

  const openLogs = useCallback(async () => {
    try {
      const response = await fetch("/api/servers/local-test/logs?tail=200", { cache: "no-store" });
      const body = (await response.json()) as { status?: string; logs?: string; message?: string };
      if (body.status === "ok") {
        setLogs(body.logs ?? "");
      } else {
        setNotice(body.message ?? "日志不可用");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "unknown");
    }
  }, []);

  if (!loaded) return <LoadingState label="读取 Local Test Server 状态" />;
  if (!resource) return <EmptyState title="Local Test Server 状态不可用" hint={notice ?? "unknown"} />;

  const caps = resource.capabilities ?? { start: true, stop: true, restart: true, resetWorld: true, logs: true };
  const desiredOnlineButObservedOffline = resource.desiredState === "on" && resource.status !== "online";
  const runningWithPlayers = resource.status === "online" && (resource.players?.online ?? 0) > 0;

  return (
    <div className="panel">
      <header className="panelHeader">
        <h3>Local Test Server（Studio 管理）</h3>
        <StatusBadge tone={resource.status === "online" ? "ok" : resource.status === "starting" ? "info" : "muted"}>
          {resource.status === "online" ? "ONLINE" : resource.status === "starting" ? "STARTING" : "NOT RUNNING"}
        </StatusBadge>
        {desiredOnlineButObservedOffline ? <StatusBadge tone="bad">DESIRED=ON / OBSERVED≠ONLINE</StatusBadge> : null}
        {resource.managedByStudio ? <StatusBadge tone="info">managedByStudio</StatusBadge> : null}
      </header>
      <div className="stack">
        <p className="hint">
          desired {resource.desiredState} · observed {resource.status}
          {resource.minecraftVersion ? ` · MC ${resource.minecraftVersion}` : " · MC —"}
          {resource.protocolVersion ? `（protocol ${resource.protocolVersion}）` : "（protocol 握手后可知）"}
          {resource.hostPort ? ` · port ${resource.hostPort}` : ""}
          {resource.seed ? ` · seed ${resource.seed}` : ""} · mode {resource.mode ?? "—"}
          {resource.players ? ` · players ${resource.players.online}/${resource.players.max}` : " · players —"}
          {resource.uptimeMs !== null ? ` · uptime ${formatUptime(resource.uptimeMs)}` : ""}
        </p>
        <p className="hint">
          world {resource.world.identity} · container {resource.containerId ?? "—"}
          {resource.ownerSessionId ? ` · owner session ${resource.ownerSessionId}` : " · owner session —"}
          {resource.shutdownPolicy ? ` · shutdownPolicy ${resource.shutdownPolicy}` : ""}
        </p>
        {runningWithPlayers ? (
          <p className="hint"><StatusBadge tone="warn">有玩家在线</StatusBadge> 停止/重置会断开 {resource.players?.names.join(", ")}</p>
        ) : null}
        {notice ? <p className="hint"><StatusBadge tone="warn">注意</StatusBadge> {notice}</p> : null}
        {operation ? (
          <p className="hint">
            操作 {operation.action}：
            {operation.status === "running" ? <StatusBadge tone="info">PENDING</StatusBadge>
              : operation.status === "succeeded" ? <StatusBadge tone="ok">SUCCEEDED（observed {operation.result?.status ?? "—"}）</StatusBadge>
              : <StatusBadge tone="bad">FAILED（{operation.error ?? operation.result?.error ?? "unknown"}）</StatusBadge>}
          </p>
        ) : null}
        <div className="filterBar">
          <button type="button" disabled={!caps.start || operation?.status === "running"} onClick={() => void runAction("start")}>
            Start Local Test Server
          </button>
          <button type="button" disabled={!caps.stop || resource.status === "not_running" || operation?.status === "running"} onClick={() => void runAction("stop")}>
            Stop
          </button>
          <button type="button" disabled={!caps.restart || resource.status === "not_running" || operation?.status === "running"} onClick={() => void runAction("restart")}>
            Restart
          </button>
          <button type="button" disabled={!caps.resetWorld || operation?.status === "running"} className={resetConfirm ? "danger" : undefined} onClick={() => void runAction("reset")}>
            {resetConfirm ? `确认 Reset World（删除 ${resource.world.volumeName}）` : "Reset World…"}
          </button>
          <button type="button" disabled={!caps.logs || resource.status === "not_running"} onClick={() => void openLogs()}>
            Open Logs
          </button>
        </div>
        {logs !== null ? (
          <div className="subPanel">
            <header className="panelHeader">
              <strong>服务器日志（最近 200 行，已脱敏）</strong>
              <button type="button" onClick={() => setLogs(null)}>关闭</button>
            </header>
            <pre className="logView">{logs}</pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
