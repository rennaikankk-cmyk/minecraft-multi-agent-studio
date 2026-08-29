"use client";

import { useCallback, useEffect, useState } from "react";

import type { ServersView } from "@/app/api/servers/route";
import { ConnectionStateBadge, ProcessStateBadge, StatusBadge } from "@/components/status-badges";
import { EmptyState, ErrorState, LoadingState, MetricCard } from "@/components/data-states";

const POLL_MS = 10_000;

interface ActionState { pending: string | null; error: string | null }

export function ServersConsole() {
  const [view, setView] = useState<ServersView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [action, setAction] = useState<ActionState>({ pending: null, error: null });
  const [form, setForm] = useState({ username: "", host: "127.0.0.1", port: "25565", version: "auto" });

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/servers", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setView((await response.json()) as ServersView);
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

  async function runAction(label: string, input: RequestInfo, init?: RequestInit) {
    setAction({ pending: label, error: null });
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      await refresh();
    } catch (error) {
      setAction({ pending: null, error: error instanceof Error ? error.message : "unknown" });
    } finally {
      setAction((current) => ({ ...current, pending: null }));
    }
  }

  const connectBot = () =>
    runAction(
      "connect",
      "/api/studio/bots",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.username.trim(),
          serverHost: form.host.trim(),
          serverPort: Number.parseInt(form.port, 10),
          minecraftVersion: form.version.trim() || "auto",
        }),
      },
    );

  if (!loaded) return <LoadingState label="读取服务器视图" />;
  if (failed && !view) return <ErrorState title="服务器视图不可用" detail={failed} />;

  const totalReady = view?.servers.reduce((sum, server) => sum + server.counts.ready, 0) ?? 0;
  const totalConnecting = view?.servers.reduce((sum, server) => sum + server.counts.connecting, 0) ?? 0;
  const totalFailed = view?.servers.reduce((sum, server) => sum + server.counts.failed, 0) ?? 0;

  return (
    <section className="stack">
      <div className="metricRow">
        <MetricCard label="服务器端点" value={view?.servers.length ?? 0} />
        <MetricCard label="READY (online)" value={totalReady} tone={totalReady > 0 ? "ok" : undefined} />
        <MetricCard label="CONNECTING" value={totalConnecting} tone={totalConnecting > 0 ? "info" : undefined} />
        <MetricCard label="FAILED" value={totalFailed} tone={totalFailed > 0 ? "bad" : undefined} />
      </div>

      {view?.notes.map((note) => (
        <p key={note} className="hint"><StatusBadge tone="warn">注意</StatusBadge> {note}</p>
      ))}
      <p className="hint">
        连接态来自 Control API 的 6 态模型；细粒度登录阶段（WAITING_SPAWN / WAITING_PLUGIN_AUTH 等）
        后端尚未上报，前端不伪造。Ping / 玩家数当前后端未提供 → 不显示。
      </p>

      <div className="panel">
        <h3>连接新 Bot（由 Studio Manager 创建进程并连接真实服务器）</h3>
        <div className="formRow">
          <label>用户名 <input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="bot_a01" /></label>
          <label>Host <input value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} /></label>
          <label>Port <input value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} /></label>
          <label>版本 <input value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} placeholder="auto" /></label>
          <button type="button" disabled={action.pending !== null || form.username.trim().length < 3} onClick={connectBot}>
            Connect Bot
          </button>
        </div>
        {action.error ? <p className="hint errorText">失败：{action.error}</p> : null}
        {action.pending ? <p className="hint">执行中：{action.pending}…</p> : null}
      </div>

      {view?.servers.length === 0 ? (
        <EmptyState
          title="没有已连接的真实服务器"
          hint="Studio Manager 中尚无 Bot 进程。使用上方表单连接第一个 Bot，或检查 STUDIO_MANAGER 配置。"
        />
      ) : (
        view?.servers.map((server) => (
          <div key={server.endpoint} className="panel">
            <header className="panelHeader">
              <h3>{server.host}<span className="muted">:{server.port}</span></h3>
              <span className="hint">版本 {server.minecraftVersion}</span>
              <span className="hint">
                READY {server.counts.ready} · CONNECTING {server.counts.connecting} · FAILED {server.counts.failed} · 其他 {server.counts.other}
              </span>
            </header>
            <div className="tableScroll">
              <table className="dataTable">
                <thead>
                  <tr><th>Bot</th><th>用户名</th><th>进程</th><th>连接</th><th>生命</th><th>延迟</th><th>位置</th><th>最近错误</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {server.bots.map((bot) => (
                    <tr key={bot.botId}>
                      <td>{bot.botId}</td>
                      <td>{bot.username}</td>
                      <td><ProcessStateBadge state={bot.processState as "starting" | "running" | "stopping" | "stopped" | "error"} /></td>
                      <td>{bot.connectionState ? <ConnectionStateBadge state={bot.connectionState as "connecting" | "online" | "stale" | "offline" | "stopping" | "error"} /> : <span className="muted">未注册</span>}</td>
                      <td>{bot.healthCurrent ?? "—"}</td>
                      <td>{bot.latencyMs !== null ? `${bot.latencyMs}ms` : "—"}</td>
                      <td>{bot.position ?? "—"}</td>
                      <td className="muted">{bot.lastError ?? "—"}</td>
                      <td>
                        <button type="button" disabled={action.pending !== null}
                          onClick={() => confirm(`重启 ${bot.username}？`) && void runAction(`restart ${bot.botId}`, `/api/studio/bots/${bot.botId}/restart`, { method: "POST" })}>
                          重启
                        </button>
                        {" "}
                        <button type="button" disabled={action.pending !== null} className="danger"
                          onClick={() => confirm(`停止 ${bot.username}？`) && void runAction(`stop ${bot.botId}`, `/api/studio/bots/${bot.botId}/stop`, { method: "POST" })}>
                          停止
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
      {failed ? <p className="hint"><StatusBadge tone="warn">STALE</StatusBadge> 最近一次刷新失败：{failed}（显示旧数据）</p> : null}
    </section>
  );
}
