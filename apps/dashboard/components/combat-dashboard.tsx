"use client";

import type { PublicBotDetailV1 } from "@minecraft-studio/protocol";
import { useEffect, useMemo } from "react";

import { useBotStore, type StreamState } from "@/stores/bot-store";

const connectionLabels: Record<PublicBotDetailV1["connectionState"], string> = {
  connecting: "连接中",
  online: "在线",
  stopping: "停止中",
  offline: "离线",
  stale: "失联",
  error: "异常",
};

const stanceLabels: Record<
  NonNullable<PublicBotDetailV1["combat"]>["stance"],
  string
> = {
  disengaged: "已脱离",
  engaging: "交战中",
  retreating: "撤退中",
};

const streamLabels: Record<StreamState, string> = {
  idle: "未启动",
  connecting: "实时流连接中",
  live: "实时流已连接",
  "fallback-polling": "已退回 3 秒轮询",
  error: "数据源不可用",
};

export function CombatDashboard() {
  const store = useBotStore();

  useEffect(() => {
    useBotStore.getState().startLive();
    return () => useBotStore.getState().stopLive();
  }, []);

  const counts = useMemo(
    () => ({
      reported: store.bots.filter((bot) => bot.combat !== null).length,
      engaging: store.bots.filter((bot) => bot.combat?.stance === "engaging").length,
      retreating: store.bots.filter((bot) => bot.combat?.stance === "retreating").length,
      reflexCleared: store.bots.filter(
        (bot) => bot.combat?.reflexProbe?.status === "cleared",
      ).length,
    }),
    [store.bots],
  );

  return (
    <section className="combatStatusSection" aria-labelledby="combat-status-title">
      <div className="sectionHeading botHeading">
        <div>
          <span>DETERMINISTIC COMBAT TELEMETRY</span>
          <h3 id="combat-status-title">运行时作战状态</h3>
        </div>
        <div className="botToolbar">
          <span
            className={`streamBadge ${store.streamState}`}
            data-testid="combat-stream-state"
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
            {store.refreshing ? "刷新中" : "刷新状态"}
          </button>
        </div>
      </div>

      <p className="sourceNotice">数据源：本机 Control API</p>

      {store.loadState === "error" ? (
        <div className="errorPanel" role="alert" data-testid="combat-backend-error">
          <strong>作战状态后端不可用</strong>
          <span>{store.error?.message ?? "无法读取 Control API。"}</span>
          <small>当前没有可展示的运行时作战状态。</small>
        </div>
      ) : null}

      {store.loadState === "loading" || store.loadState === "idle" ? (
        <div className="loadingPanel" data-testid="combat-loading">
          正在连接本机 Control API
        </div>
      ) : null}

      {store.loadState === "ready" ? (
        <>
          <dl className="combatSummary" aria-label="作战状态汇总">
            <SummaryFact label="已接入" value={counts.reported} />
            <SummaryFact label="交战中" value={counts.engaging} tone="engaging" />
            <SummaryFact label="撤退中" value={counts.retreating} tone="retreating" />
            <SummaryFact
              label="反射已放行"
              value={counts.reflexCleared}
              tone="cleared"
            />
          </dl>

          {store.bots.length === 0 ? (
            <div className="emptyBotPanel" data-testid="combat-empty">
              <strong>Control API 已连接</strong>
              <span>当前注册表中没有机器人。</span>
            </div>
          ) : (
            <div className="combatTableViewport" data-testid="combat-status-table">
              <table className="combatTable">
                <thead>
                  <tr>
                    <th scope="col">机器人</th>
                    <th scope="col">当前姿态</th>
                    <th scope="col">确定性目标</th>
                    <th scope="col">最近拒绝</th>
                    <th scope="col">反射探针</th>
                  </tr>
                </thead>
                <tbody>
                  {store.bots.map((bot) => (
                    <CombatRow bot={bot} key={bot.botId} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="freshnessLine">
            <span>
              数据时间：
              {store.generatedAt
                ? new Date(store.generatedAt).toLocaleString("zh-CN")
                : "不可用"}
            </span>
            <span>{store.requestId ? `请求 ${store.requestId}` : "无请求编号"}</span>
          </div>
        </>
      ) : null}
    </section>
  );
}

function SummaryFact({
  label,
  value,
  tone = "",
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className={tone}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CombatRow({ bot }: { bot: PublicBotDetailV1 }) {
  const combat = bot.combat;
  return (
    <tr data-testid={`combat-row-${bot.botId}`}>
      <th scope="row">
        <strong>{bot.botId}</strong>
        <span className={`combatConnection ${bot.connectionState}`}>
          {connectionLabels[bot.connectionState]}
        </span>
      </th>
      <td data-testid={`combat-stance-${bot.botId}`}>
        {combat ? (
          <span className={`combatStance ${combat.stance}`}>
            {stanceLabels[combat.stance]}
          </span>
        ) : (
          <MissingValue />
        )}
      </td>
      <td data-testid={`combat-target-${bot.botId}`}>
        {combat ? formatTarget(combat.target) : <MissingValue />}
      </td>
      <td data-testid={`combat-refusal-${bot.botId}`}>
        {combat ? formatRefusal(combat.latestRefusal) : <MissingValue />}
      </td>
      <td data-testid={`combat-probe-${bot.botId}`}>
        {combat ? formatProbe(combat.reflexProbe) : <MissingValue />}
      </td>
    </tr>
  );
}

function MissingValue() {
  return <span className="combatMissing">未接入</span>;
}

function formatTarget(
  target: NonNullable<PublicBotDetailV1["combat"]>["target"],
) {
  if (target === null) return <span className="combatMuted">无目标</span>;
  return (
    <span className="combatCode">
      #{target.entityId} · {target.kind === "player" ? "玩家" : "怪物"}
    </span>
  );
}

function formatRefusal(
  refusal: NonNullable<PublicBotDetailV1["combat"]>["latestRefusal"],
) {
  if (refusal === null) return <span className="combatMuted">无拒绝记录</span>;
  return (
    <span className="combatRefusal">
      <code>{refusal.reasonCode}</code>
      <time dateTime={refusal.observedAt}>
        {new Date(refusal.observedAt).toLocaleString("zh-CN")}
      </time>
    </span>
  );
}

function formatProbe(
  probe: NonNullable<PublicBotDetailV1["combat"]>["reflexProbe"],
) {
  if (probe === null) return <MissingValue />;
  if (probe.status === "cleared") {
    return <span className="combatProbe cleared">已放行</span>;
  }
  if (probe.status === "not-run") {
    return (
      <span className="combatProbe notRun">
        未运行 <code>{probe.denial}</code>
      </span>
    );
  }
  return (
    <span className="combatProbe denied">
      未放行 <code>{probe.denial}</code>
    </span>
  );
}

function sourceLabel(state: "idle" | "loading" | "ready" | "error"): string {
  switch (state) {
    case "loading":
      return "Control API 连接中";
    case "ready":
      return "Control API 实时数据";
    case "error":
      return "Control API 不可用";
    default:
      return "等待连接";
  }
}
