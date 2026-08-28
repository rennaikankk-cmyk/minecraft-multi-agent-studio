"use client";

import { BotCompass } from "@/components/bot-compass";
import { BotLifecycleSwitch } from "@/components/bot-lifecycle-switch";
import { BotMap } from "@/components/bot-map";
import { useBotStore } from "@/stores/bot-store";
import { useEffect } from "react";

// ---------------------------------------------------------------------------
// TacView —— 战术视图：实时地图 + 每 bot 视角罗盘 + 生命周期开关。
//
// 数据全部来自 bot-store 的实时流（与 BotDashboard 同源），不另开连接。
// 地图轨迹本地维护（组件内 ref），不进协议。
// ---------------------------------------------------------------------------

export function TacView() {
  const store = useBotStore();

  useEffect(() => {
    useBotStore.getState().startLive();
    return () => useBotStore.getState().stopLive();
  }, []);

  const bots = store.bots;
  const onlineBots = bots.filter((bot) => bot.connectionState === "online");
  const withPosition = bots.filter((bot) => bot.position !== null);

  const restartBot = async (botId: string) => {
    await fetch(`/api/studio/bots/${encodeURIComponent(botId)}/restart`, {
      method: "POST",
      headers: { "x-studio-action": "restart-bot" },
    });
  };
  const stopBot = async (botId: string) => {
    await fetch(`/api/studio/bots/${encodeURIComponent(botId)}/stop`, {
      method: "POST",
      headers: { "x-studio-action": "stop-bot" },
    });
  };

  return (
    <section
      style={{
        border: "1px solid var(--line)",
        borderRadius: 12,
        padding: 16,
        background: "var(--panel)",
        marginBottom: 20,
      }}
      data-testid="tac-view"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, letterSpacing: "0.08em" }}>
          战术视图 · TAC MAP
        </h3>
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          {onlineBots.length}/{bots.length} 在线 · {withPosition.length} 有位置
          {store.streamState === "live" ? " · 实时流" : store.streamState === "fallback-polling" ? " · 轮询" : ""}
        </span>
      </div>

      {bots.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          {store.loadState === "loading"
            ? "正在加载机器人列表…"
            : "暂无机器人。在上方创建一个真实服 Bot 后，这里会出现实时地图与视角。"}
        </p>
      ) : (
        <>
          <BotMap bots={bots} height={380} />

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 14,
              marginTop: 14,
            }}
          >
            {bots.map((bot) => (
              <div
                key={bot.botId}
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  padding: 12,
                  background: "var(--panel-2)",
                  opacity: bot.connectionState === "online" ? 1 : 0.55,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 10,
                  }}
                >
                  <strong
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 13,
                    }}
                  >
                    {bot.botId}
                  </strong>
                  <span
                    style={{
                      fontSize: 10,
                      padding: "2px 8px",
                      borderRadius: 10,
                      fontFamily: "ui-monospace, monospace",
                      background:
                        bot.connectionState === "online"
                          ? "rgba(110,231,162,0.12)"
                          : "rgba(255,255,255,0.06)",
                      color:
                        bot.connectionState === "online"
                          ? "var(--ok)"
                          : "var(--muted)",
                    }}
                  >
                    {bot.connectionState}
                  </span>
                </div>

                <BotCompass bot={bot} />

                {bot.currentTask ? (
                  <p
                    style={{
                      margin: "10px 0 4px",
                      fontSize: 11,
                      color: "var(--muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={bot.currentTask.title}
                  >
                    当前任务: {bot.currentTask.title}
                  </p>
                ) : null}

                <div style={{ marginTop: 10 }}>
                  <BotLifecycleSwitch
                    botId={bot.botId}
                    running={bot.connectionState !== "offline"}
                    onRestart={() => restartBot(bot.botId)}
                    onStop={() => stopBot(bot.botId)}
                    onStart={() => restartBot(bot.botId)}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
