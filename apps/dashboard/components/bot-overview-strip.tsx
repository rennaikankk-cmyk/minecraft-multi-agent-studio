"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";

import { useBotStore } from "@/stores/bot-store";

export function BotOverviewStrip() {
  const store = useBotStore();

  useEffect(() => {
    void store.refresh();
    const timer = window.setInterval(
      () => void useBotStore.getState().refresh(),
      5_000,
    );
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(
    () => ({
      total: store.bots.length,
      online: store.bots.filter((bot) => bot.connectionState === "online").length,
    }),
    [store.bots],
  );

  return (
    <section className="botOverviewStrip" aria-labelledby="bot-overview-title">
      <div>
        <span className="stripEyebrow">BOT FLEET</span>
        <h3 id="bot-overview-title">机器人集群</h3>
      </div>
      <div className="stripFacts" data-testid="bot-overview-counts">
        {store.loadState === "ready" ? (
          <>
            <span><strong>{counts.total}</strong> 已注册</span>
            <span><strong>{counts.online}</strong> 在线</span>
          </>
        ) : store.loadState === "error" ? (
          <span className="stripError">Control API 不可用，无在线数据</span>
        ) : (
          <span>正在连接…</span>
        )}
      </div>
      <Link className="stripLink" href="/bots">
        进入机器人页 →
      </Link>
    </section>
  );
}
