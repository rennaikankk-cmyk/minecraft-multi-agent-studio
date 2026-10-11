"use client";

// Bot Fleet 高密度表（消费 useBotStore 的 SSE 实时流；行内状态色 + 链接 Incidents）。
// 此前自带 5s fetch 轮询——与同页 BotDashboard 的 SSE 流构成双状态源
// （10 bot ≈ 2.2 req/s 纯冗余上游扇出 + 同实体两份展示副本竞态）。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw, Search } from "lucide-react";
import type { PublicBotDetailV1 } from "@minecraft-studio/protocol";

import { Badge, Card, CardContent, CardHeader, CardTitle, DataTable, Input, Td, Th, UiEmptyState } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { useBotStore } from "@/stores/bot-store";

type BotRow = PublicBotDetailV1 & { username?: string };

export function BotFleetTable() {
  const store = useBotStore();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  useEffect(() => {
    useBotStore.getState().startLive();
    return () => useBotStore.getState().stopLive();
  }, []);

  const bots = store.bots as readonly BotRow[];
  const failed = store.error?.message ?? null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bots.filter((bot) => {
      if (q && !`${bot.botId} ${bot.username ?? ""}`.toLowerCase().includes(q)) return false;
      if (statusFilter && bot.connectionState !== statusFilter) return false;
      return true;
    });
  }, [bots, query, statusFilter]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bot Fleet（{filtered.length}）</CardTitle>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground" aria-hidden />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 bot…"
              aria-label="搜索 Bot"
              className="w-44 pl-7"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            aria-label="按状态筛选"
            className="h-7 rounded-[6px] border border-border-subtle bg-elevated px-2 text-[12.5px] text-foreground"
          >
            <option value="">全部状态</option>
            <option value="online">online</option>
            <option value="connecting">connecting</option>
            <option value="offline">offline</option>
            <option value="error">error</option>
          </select>
          <Button variant="ghost" size="icon" aria-label="刷新" onClick={() => void store.refresh()} disabled={store.refreshing}>
            <RefreshCw className={store.refreshing ? "animate-spin" : undefined} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {failed ? (
          <div className="p-4 text-xs text-danger">{failed}</div>
        ) : filtered.length === 0 ? (
          <div className="p-4">
            <UiEmptyState title={bots?.length ? "没有匹配的 Bot" : "没有已注册的 Bot"} hint="在 Servers 页连接第一个 Bot，或经 Studio Manager 创建。" />
          </div>
        ) : (
          <DataTable aria-label="Bot Fleet">
            <thead>
              <tr>
                <Th>Bot</Th>
                <Th>状态</Th>
                <Th>生命/饥饿</Th>
                <Th>位置</Th>
                <Th>当前任务</Th>
                <Th>Ping</Th>
                <Th>物理 Tick P95</Th>
                <Th>循环延迟 P99</Th>
                <Th>钻甲槽位</Th>
                <Th>最近消息</Th>
                <Th>Incidents</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((bot) => (
                <tr key={bot.botId} className="anim-120 hover:bg-hover/50">
                  <Td>
                    <span className="data-mono font-medium">{bot.botId}</span>
                    {bot.username ? <span className="ml-2 text-subtle-foreground">{bot.username}</span> : null}
                  </Td>
                  <Td>
                    <Badge tone={bot.connectionState === "online" ? "online" : bot.connectionState === "error" ? "failed" : bot.connectionState === "connecting" ? "starting" : "neutral"}>
                      {bot.connectionState ?? "unknown"}
                    </Badge>
                  </Td>
                  <Td className="data-mono text-muted-foreground">
                    {bot.health ? `${bot.health.current ?? "?"}${bot.food ? ` / ${bot.food.level}` : ""}` : "—"}
                  </Td>
                  <Td className="data-mono text-muted-foreground">
                    {bot.position ? `${Math.floor(bot.position.x)}, ${Math.floor(bot.position.y)}, ${Math.floor(bot.position.z)}` : "—"}
                  </Td>
                  <Td className="max-w-52 truncate text-muted-foreground" title={bot.currentTask?.title ?? ""}>
                    {bot.currentTask?.title ?? "—"}
                  </Td>
                  <Td className="data-mono text-muted-foreground">{bot.latencyMs != null ? `${bot.latencyMs}ms` : "—"}</Td>
                  <Td className="data-mono text-muted-foreground">{bot.performance?.physics && Date.now() - Date.parse(bot.performance.physics.observedAt) < 15_000 ? `${bot.performance.physics.p95IntervalMs} ms` : "未采样"}</Td>
                  <Td className="data-mono text-muted-foreground">{bot.performance?.eventLoop && Date.now() - Date.parse(bot.performance.eventLoop.observedAt) < 90_000 ? `${bot.performance.eventLoop.p99DelayMs} ms` : "未采样"}</Td>
                  <Td className="data-mono text-muted-foreground">{bot.armorSlots ? `${Object.values(bot.armorSlots).filter((item) => item?.startsWith("diamond_") || item?.startsWith("netherite_")).length} / 4` : "未上报"}</Td>
                  <Td className="text-subtle-foreground">{bot.lastMessageAt ? new Date(bot.lastMessageAt).toLocaleTimeString("zh-CN") : "—"}</Td>
                  <Td>
                    <Link href={`/incidents?bot=${encodeURIComponent(bot.botId)}`} className="text-primary hover:underline">查看</Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </CardContent>
    </Card>
  );
}
