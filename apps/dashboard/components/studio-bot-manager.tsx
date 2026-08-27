"use client";

import {
  studioManagedBotResponseV1Schema,
  studioManagerErrorV1Schema,
  studioManagerStatusV1Schema,
  type StudioManagedBotV1,
  type StudioManagerStatusV1,
} from "@minecraft-studio/protocol";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { useBotStore } from "@/stores/bot-store";

const POLL_INTERVAL_MS = 3_000;

const processLabels: Record<StudioManagedBotV1["processState"], string> = {
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  error: "异常",
};

const connectionLabels = {
  connecting: "连接中",
  online: "在线",
  stopping: "停止中",
  offline: "离线",
  stale: "失联",
  error: "异常",
} as const;

export function StudioBotManager() {
  const telemetryBots = useBotStore((state) => state.bots);
  const [status, setStatus] = useState<StudioManagerStatusV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("StudioBot1");
  const [serverHost, setServerHost] = useState("127.0.0.1");
  const [serverPort, setServerPort] = useState("25565");
  const [minecraftVersion, setMinecraftVersion] = useState("auto");
  const [submitting, setSubmitting] = useState(false);
  const [restartingBotId, setRestartingBotId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/studio/status", { cache: "no-store" });
      const value = (await response.json()) as unknown;
      if (!response.ok) throw managerResponseError(value, "Studio Manager 不可用。");
      const parsed = studioManagerStatusV1Schema.safeParse(value);
      if (!parsed.success) throw new Error("Studio Manager 返回了无效数据。");
      setStatus(parsed.data);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Studio Manager 不可用。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const telemetryById = useMemo(
    () => new Map(telemetryBots.map((bot) => [bot.botId, bot])),
    [telemetryBots],
  );

  const createBot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setActionMessage("");
    try {
      const port = Number(serverPort);
      const response = await fetch("/api/studio/bots", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Studio-Action": "create-bot",
        },
        body: JSON.stringify({
          schemaVersion: "1.0",
          username,
          serverHost,
          serverPort: port,
          minecraftVersion,
        }),
      });
      const value = (await response.json()) as unknown;
      if (!response.ok) throw managerResponseError(value, "Bot 创建失败。");
      const parsed = studioManagedBotResponseV1Schema.safeParse(value);
      if (!parsed.success) throw new Error("Bot 创建接口返回了无效数据。");
      setActionMessage(`${parsed.data.bot.botId} 已创建并启动。`);
      setUsername(`StudioBot${Math.min(16, (status?.bots.length ?? 0) + 2)}`);
      await Promise.all([refresh(), useBotStore.getState().refresh()]);
    } catch (cause) {
      setActionMessage(cause instanceof Error ? cause.message : "Bot 创建失败。");
    } finally {
      setSubmitting(false);
    }
  };

  const restartBot = async (botId: string) => {
    setRestartingBotId(botId);
    setActionMessage("");
    try {
      const response = await fetch(
        `/api/studio/bots/${encodeURIComponent(botId)}/restart`,
        { method: "POST", headers: { "X-Studio-Action": "restart-bot" } },
      );
      const value = (await response.json()) as unknown;
      if (!response.ok) throw managerResponseError(value, "Bot 重启失败。");
      const parsed = studioManagedBotResponseV1Schema.safeParse(value);
      if (!parsed.success || parsed.data.bot.botId !== botId) {
        throw new Error("Bot 重启接口返回了无效数据。");
      }
      setActionMessage(`${botId} 已重新启动。`);
      await refresh();
    } catch (cause) {
      setActionMessage(cause instanceof Error ? cause.message : "Bot 重启失败。");
    } finally {
      setRestartingBotId(null);
    }
  };

  return (
    <section className="studioManagerSection" aria-labelledby="local-bot-title">
      <div className="sectionHeading botHeading">
        <div>
          <span>LOCAL RUNTIME</span>
          <h3 id="local-bot-title">创建本地 Bot</h3>
        </div>
        <span className={`sourceBadge ${error ? "error" : status ? "ready" : "loading"}`}>
          <i />
          {loading ? "连接中" : error ? "Manager 不可用" : `${status?.bots.length ?? 0}/${status?.capabilities.maxBots ?? 0} 个槽位`}
        </span>
      </div>

      <form className="botCreateForm" onSubmit={(event) => void createBot(event)}>
        <label>
          <span>Bot 用户名</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            minLength={3}
            maxLength={16}
            pattern="[A-Za-z0-9_]+"
            required
            autoComplete="off"
          />
        </label>
        <label>
          <span>服务器地址</span>
          <input
            value={serverHost}
            onChange={(event) => setServerHost(event.target.value)}
            maxLength={253}
            required
            autoComplete="off"
          />
        </label>
        <label>
          <span>端口</span>
          <input
            type="number"
            value={serverPort}
            onChange={(event) => setServerPort(event.target.value)}
            min={1}
            max={65535}
            required
          />
        </label>
        <label>
          <span>Minecraft 版本</span>
          <input
            value={minecraftVersion}
            onChange={(event) => setMinecraftVersion(event.target.value)}
            pattern="auto|[0-9]+\.[0-9]+(\.[0-9]+)?"
            required
            autoComplete="off"
          />
        </label>
        <button
          className="createBotButton"
          type="submit"
          disabled={submitting || !status?.capabilities.createBot}
        >
          {submitting ? "创建中…" : "创建并启动"}
        </button>
      </form>

      {error ? <div className="managerInlineError" role="alert">{error}</div> : null}
      {actionMessage ? <div className="managerActionResult" role="status">{actionMessage}</div> : null}

      {status?.bots.length ? (
        <div className="managedBotTableViewport">
          <table className="managedBotTable">
            <thead>
              <tr>
                <th>Bot</th>
                <th>服务器</th>
                <th>Runtime</th>
                <th>遥测</th>
                <th><span className="visuallyHidden">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {status.bots.map((bot) => {
                const telemetry = telemetryById.get(bot.botId);
                return (
                  <tr key={bot.botId}>
                    <th scope="row">
                      <strong>{bot.username}</strong>
                      <code>{bot.botId}</code>
                      {bot.lastError ? (
                        <small className="managedBotError">{bot.lastError}</small>
                      ) : null}
                    </th>
                    <td>
                      <code>{bot.serverHost}:{bot.serverPort}</code>
                      <small>{bot.minecraftVersion}</small>
                    </td>
                    <td>
                      <span className={`managedState ${bot.processState}`}>
                        {processLabels[bot.processState]}
                      </span>
                      {bot.pid ? <small>PID {bot.pid}</small> : null}
                    </td>
                    <td>
                      <span className={`managedState ${telemetry?.connectionState ?? "pending"}`}>
                        {telemetry
                          ? connectionLabels[telemetry.connectionState]
                          : bot.processState === "running"
                            ? "等待遥测"
                            : "未连接"}
                      </span>
                    </td>
                    <td>
                      <button
                        className="secondaryButton compact"
                        type="button"
                        onClick={() => void restartBot(bot.botId)}
                        disabled={restartingBotId !== null}
                      >
                        {restartingBotId === bot.botId ? "重启中…" : "重启"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : status && !error ? (
        <div className="managedBotEmpty">尚未创建本地 Bot。</div>
      ) : null}
    </section>
  );
}

function managerResponseError(value: unknown, fallback: string): Error {
  const parsed = studioManagerErrorV1Schema.safeParse(value);
  return new Error(parsed.success ? parsed.data.error.message : fallback);
}
