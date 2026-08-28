"use client";

import type { PublicBotDetailV1 } from "@minecraft-studio/protocol";
import { useEffect, useMemo, useState } from "react";

import { useBotStore, type StreamState } from "@/stores/bot-store";

const stateLabels: Record<PublicBotDetailV1["connectionState"], string> = {
  connecting: "连接中",
  online: "在线",
  stopping: "停止中",
  offline: "离线",
  stale: "失联",
  error: "异常",
};

const streamLabels: Record<StreamState, string> = {
  idle: "未启动",
  connecting: "实时流连接中…",
  live: "实时流已连接",
  "fallback-polling": "已退回 3 秒轮询",
  error: "数据源不可用",
};

export function BotDashboard() {
  const store = useBotStore();
  const [selectedBot, setSelectedBot] = useState<PublicBotDetailV1 | null>(null);
  const [detailBotId, setDetailBotId] = useState<string | null>(null);
  const [confirmationCode, setConfirmationCode] = useState("");

  useEffect(() => {
    useBotStore.getState().startLive();
    return () => useBotStore.getState().stopLive();
  }, []);

  const detailBot = useMemo(
    () => store.bots.find((bot) => bot.botId === detailBotId) ?? null,
    [store.bots, detailBotId],
  );

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
          <span
            className={`streamBadge ${store.streamState}`}
            data-testid="stream-state-badge"
          >
            <i />
            {streamLabels[store.streamState]}
          </span>
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
        数据源：本机 Control API。优先使用实时推送流；流不可用时自动退回每 3 秒轮询并明确标注。请求失败时清空在线列表，不使用演示数据回退。
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
                  onDetail={() => setDetailBotId(bot.botId)}
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
          <span>{store.stopMessage}</span>
          {store.stopTraceId ? (
            <code data-testid="stop-trace-id">追踪编号：{store.stopTraceId}</code>
          ) : null}
        </div>
      ) : null}

      {detailBot ? (
        <div
          className="drawerBackdrop"
          role="presentation"
          onMouseDown={() => setDetailBotId(null)}
        >
          <aside
            className="botDrawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bot-drawer-title"
            data-testid="bot-drawer"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="drawerEyebrow">BOT DETAIL</span>
                <h4 id="bot-drawer-title">{detailBot.botId}</h4>
              </div>
              <button
                type="button"
                className="drawerClose"
                onClick={() => setDetailBotId(null)}
              >
                关闭
              </button>
            </header>
            <dl className="drawerFacts">
              <DrawerFact label="连接状态" value={stateLabels[detailBot.connectionState]} />
              <DrawerFact
                label="生命"
                value={detailBot.health ? `${formatNumber(detailBot.health.current)} / ${detailBot.health.maximum === null ? "?" : formatNumber(detailBot.health.maximum)}` : "不可用"}
              />
              <DrawerFact
                label="饥饿 / 饱和"
                value={detailBot.food ? `${detailBot.food.level} / 20 · 饱和 ${formatNumber(detailBot.food.saturation)}` : "不可用"}
              />
              <DrawerFact
                label="护甲值"
                value={detailBot.armorPoints === null ? "不可用" : `${detailBot.armorPoints} / 20`}
              />
              <DrawerFact
                label="延迟"
                value={detailBot.latencyMs === null ? "不可用" : `${detailBot.latencyMs} ms`}
              />
              <DrawerFact label="位置" value={formatPosition(detailBot)} />
              <DrawerFact label="L0 安全" value={formatSafety(detailBot)} />
              <DrawerFact
                label="当前任务"
                value={formatCurrentTask(detailBot)}
              />
              <DrawerFact
                label="MC 版本"
                value={detailBot.minecraftVersion ? `${detailBot.minecraftVersion.resolvedVersion ?? "未解析"} · ${supportLevelLabel(detailBot.minecraftVersion.supportLevel)}` : "未解析"}
              />
              <DrawerFact
                label="最后消息"
                value={new Date(detailBot.lastMessageAt).toLocaleString("zh-CN")}
              />
            </dl>
          </aside>
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
  onDetail,
}: {
  bot: PublicBotDetailV1;
  stopConfigured: boolean;
  onStop: () => void;
  onDetail: () => void;
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
        <Fact label="任务" value={formatCurrentTask(bot)} />
        <Fact label="L0安全" value={formatSafety(bot)} wide />
        <Fact label="位置" value={formatPosition(bot)} wide />
        <Fact label="版本" value={bot.minecraftVersion?.resolvedVersion ?? "未解析"} wide />
      </dl>
      <div className="botCardFooter">
        <small>最后消息：{new Date(bot.lastMessageAt).toLocaleTimeString("zh-CN")}</small>
        <div className="botCardActions">
          <button
            type="button"
            className="secondaryButton"
            onClick={onDetail}
            data-testid={`bot-detail-${bot.botId}`}
          >
            详情
          </button>
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
      </div>
    </article>
  );
}

function DrawerFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function supportLevelLabel(
  level: NonNullable<PublicBotDetailV1["minecraftVersion"]>["supportLevel"],
): string {
  if (level === "tested") return "已测试";
  if (level === "compatible-untested") return "兼容未测试";
  return "不受支持";
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

function formatSafety(bot: PublicBotDetailV1): string {
  if (bot.connectionState !== "online") return "不可用（Bot非在线）";
  const safety = bot.safety;
  if (!safety) return "不可用";
  if (safety.mode === "monitoring") return "正常监控";
  const labels: Record<(typeof safety.activeRisks)[number], string> = {
    CRITICAL_HEALTH: "生命危险",
    LOW_HEALTH: "低生命值",
    HUNGER: "饥饿",
    DROWNING: "溺水",
    LAVA: "岩浆",
    FALLING: "坠落",
    STUCK: "卡住",
    INVENTORY_FULL: "背包已满",
  };
  const risks = safety.activeRisks.map((risk) => labels[risk]).join("、");
  return risks || "正在干预";
}

function formatCurrentTask(bot: PublicBotDetailV1): string {
  if (bot.currentTask) {
    return `${bot.currentTask.title} · ${bot.currentTask.status}`;
  }
  if (bot.safety?.normalTasksPaused) {
    return `安全暂停: ${formatSafety(bot)} · paused`;
  }
  return "无任务";
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
