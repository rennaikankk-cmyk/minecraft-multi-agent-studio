"use client";

import type { PublicBotDetailV1 } from "@minecraft-studio/protocol";
import { useEffect, useMemo, useState } from "react";

import { useBotStore } from "@/stores/bot-store";

const stateLabels: Record<PublicBotDetailV1["connectionState"], string> = {
  connecting: "连接中",
  online: "在线",
  stopping: "停止中",
  offline: "离线",
  stale: "失联",
  error: "异常",
};

export function BotDashboard() {
  const store = useBotStore();
  const [selectedBot, setSelectedBot] = useState<PublicBotDetailV1 | null>(null);
  const [confirmationCode, setConfirmationCode] = useState("");

  useEffect(() => {
    void store.refresh();
    const timer = window.setInterval(() => void useBotStore.getState().refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, []);

  const counts = useMemo(() => ({
    total: store.bots.length,
    online: store.bots.filter((bot) => bot.connectionState === "online").length,
    stale: store.bots.filter((bot) => bot.connectionState === "stale").length,
    offline: store.bots.filter((bot) => bot.connectionState === "offline").length,
  }), [store.bots]);

  const openStopDialog = (bot: PublicBotDetailV1) => {
    store.resetStopResult();
    setConfirmationCode("");
    setSelectedBot(bot);
  };

  const closeStopDialog = () => {
    if (store.stopState === "submitting") return;
    setSelectedBot(null);
    setConfirmationCode("");
  };

  return (
    <section className="botSection" aria-labelledby="bot-dashboard-title">
      <div className="sectionHeading botHeading">
        <div>
          <span>REAL BOT TELEMETRY</span>
          <h3 id="bot-dashboard-title">机器人实时状态</h3>
        </div>
        <div className="botToolbar">
          <span className={`sourceBadge ${store.loadState}`}>
            <i />
            {sourceLabel(store.loadState)}
          </span>
          <button
            className="refreshButton"
            type="button"
            onClick={() => void store.refresh()}
            disabled={store.loadState === "loading" || store.refreshing}
          >
            {store.refreshing ? "刷新中…" : "刷新状态"}
          </button>
        </div>
      </div>

      <p className="sourceNotice">
        数据源：本机 Control API。页面每 3 秒读取一次；请求失败时清空在线列表，不使用演示数据回退。
      </p>

      {store.loadState === "error" ? (
        <div className="errorPanel" role="alert" data-testid="bot-backend-error">
          <strong>机器人状态后端不可用</strong>
          <span>{store.error?.message ?? "无法读取 Control API。"}</span>
          <small>当前页面没有展示任何模拟 Bot。</small>
        </div>
      ) : null}

      {store.loadState === "loading" || store.loadState === "idle" ? (
        <div className="loadingPanel" data-testid="bot-loading">正在连接本机 Control API…</div>
      ) : null}

      {store.loadState === "ready" ? (
        <>
          <div className="botMetricGrid">
            <Metric label="已注册" value={counts.total} />
            <Metric label="在线" value={counts.online} tone="online" />
            <Metric label="失联" value={counts.stale} tone="stale" />
            <Metric label="离线" value={counts.offline} tone="offline" />
          </div>

          {store.bots.length === 0 ? (
            <div className="emptyBotPanel" data-testid="bot-empty">
              <strong>Control API 已连接</strong>
              <span>当前注册表中没有机器人。系统不会创建模拟机器人填充页面。</span>
            </div>
          ) : (
            <div className="botGrid" data-testid="bot-grid">
              {store.bots.map((bot) => (
                <BotCard
                  key={bot.botId}
                  bot={bot}
                  stopConfigured={store.stopConfirmationConfigured}
                  onStop={() => openStopDialog(bot)}
                />
              ))}
            </div>
          )}

          <div className="freshnessLine">
            <span>
              数据时间：{store.generatedAt ? new Date(store.generatedAt).toLocaleString("zh-CN") : "不可用"}
            </span>
            <span>{store.requestId ? `请求 ${store.requestId}` : "无请求编号"}</span>
          </div>
        </>
      ) : null}

      {store.stopMessage ? (
        <div
          className={`stopResult ${store.stopState}`}
          role="status"
          data-testid="stop-result"
        >
          {store.stopMessage}
        </div>
      ) : null}

      {selectedBot ? (
        <div className="dialogBackdrop" role="presentation" onMouseDown={closeStopDialog}>
          <div
            className="confirmDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="stop-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="dialogEyebrow">SECOND CONFIRMATION</span>
            <h4 id="stop-dialog-title">停止机器人 {selectedBot.botId}？</h4>
            <p>系统只发送优雅停止命令，并等待目标 Runtime 返回真实确认。离线或失联 Bot 不允许停止。</p>
            <label htmlFor="stop-confirmation-code">本地停止确认码</label>
            <input
              id="stop-confirmation-code"
              type="password"
              autoComplete="off"
              value={confirmationCode}
              onChange={(event) => setConfirmationCode(event.target.value)}
              placeholder="输入至少 6 位确认码"
            />
            <div className="dialogActions">
              <button type="button" className="secondaryButton" onClick={closeStopDialog} disabled={store.stopState === "submitting"}>
                取消
              </button>
              <button
                type="button"
                className="dangerButton"
                disabled={confirmationCode.length < 6 || store.stopState === "submitting"}
                onClick={async () => {
                  const completed = await store.stopBot(selectedBot.botId, confirmationCode);
                  if (completed) closeStopDialog();
                }}
              >
                {store.stopState === "submitting" ? "等待 Bot 确认…" : "确认优雅停止"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return (
    <article className={`botMetric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function BotCard({
  bot,
  stopConfigured,
  onStop,
}: {
  bot: PublicBotDetailV1;
  stopConfigured: boolean;
  onStop: () => void;
}) {
  const canStop = stopConfigured && !["offline", "stale", "stopping"].includes(bot.connectionState);
  return (
    <article className="botCard" data-testid={`bot-card-${bot.botId}`}>
      <header>
        <div>
          <span>BOT</span>
          <h4>{bot.botId}</h4>
        </div>
        <em className={`botState ${bot.connectionState}`} data-testid={`bot-state-${bot.botId}`}>
          {stateLabels[bot.connectionState]}
        </em>
      </header>
      <dl className="botFacts">
        <Fact label="生命" value={bot.health ? `${formatNumber(bot.health.current)} / ${bot.health.maximum === null ? "?" : formatNumber(bot.health.maximum)}` : "不可用"} />
        <Fact label="饥饿" value={bot.food ? `${bot.food.level} / 20` : "不可用"} />
        <Fact label="延迟" value={bot.latencyMs === null ? "不可用" : `${bot.latencyMs} ms`} />
        <Fact label="任务" value={bot.currentTask ? `${bot.currentTask.title} · ${bot.currentTask.status}` : "无任务"} />
        <Fact label="位置" value={formatPosition(bot)} wide />
        <Fact label="版本" value={bot.minecraftVersion?.resolvedVersion ?? "未解析"} wide />
      </dl>
      <div className="botCardFooter">
        <small>最后消息：{new Date(bot.lastMessageAt).toLocaleTimeString("zh-CN")}</small>
        <button
          type="button"
          className="stopButton"
          onClick={onStop}
          disabled={!canStop}
          title={!stopConfigured ? "尚未配置本地停止确认码" : undefined}
        >
          {bot.connectionState === "stale" ? "失联不可停止" : "安全停止"}
        </button>
      </div>
    </article>
  );
}

function Fact({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={wide ? "wide" : ""}><dt>{label}</dt><dd>{value}</dd></div>;
}

function sourceLabel(state: string): string {
  if (state === "ready") return "真实数据已连接";
  if (state === "error") return "Control API 不可用";
  return "正在连接真实数据";
}

function formatPosition(bot: PublicBotDetailV1): string {
  if (bot.positionRedacted) return "权限不足，坐标已隐藏";
  if (!bot.position) return "不可用";
  return `${formatNumber(bot.position.x)}, ${formatNumber(bot.position.y)}, ${formatNumber(bot.position.z)} · ${bot.position.dimension}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
