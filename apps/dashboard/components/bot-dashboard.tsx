"use client";

// 机器人实时状态（遥测）——已迁移到 v4 primitives 体系（2026-09-10 结构拆分
// 专项批次 2）。逻辑与 data-testid 契约零改动；仅视觉层从 gen2 类迁移。
import type { PublicBotDetailV1 } from "@minecraft-studio/protocol";
import { Activity, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useBotStore, type StreamState } from "@/stores/bot-store";
import { Button } from "@/components/ui/button";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  UiEmptyState,
  UiErrorState,
} from "@/components/ui/primitives";

const stateLabels: Record<PublicBotDetailV1["connectionState"], string> = {
  connecting: "连接中",
  online: "在线",
  stopping: "停止中",
  offline: "离线",
  stale: "失联",
  error: "异常",
};

const stateTones: Record<PublicBotDetailV1["connectionState"], "online" | "starting" | "warning" | "neutral" | "failed"> = {
  connecting: "starting",
  online: "online",
  stopping: "warning",
  offline: "neutral",
  stale: "warning",
  error: "failed",
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          机器人实时状态
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={store.streamState === "live" ? "online" : store.streamState === "error" ? "failed" : "info"} data-testid="stream-state-badge">
            {streamLabels[store.streamState]}
          </Badge>
          <Badge tone={store.loadState === "ready" ? "online" : store.loadState === "error" ? "failed" : "unknown"}>
            {sourceLabel(store.loadState)}
          </Badge>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => void store.refresh()}
            disabled={store.loadState === "loading" || store.refreshing}
          >
            <RefreshCw className={store.refreshing ? "animate-spin" : undefined} />
            {store.refreshing ? "刷新中…" : "刷新状态"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[11.5px] leading-relaxed text-subtle-foreground">
          数据源：本机 Control API。优先使用实时推送流；流不可用时自动退回每 3 秒轮询并明确标注。请求失败时清空在线列表，不使用演示数据回退。
        </p>

        {store.loadState === "error" ? (
          <div
            className="rounded-[6px] border border-danger/30 bg-danger/10 px-3 py-3 text-[12.5px] text-danger"
            role="alert"
            data-testid="bot-backend-error"
          >
            <div className="font-semibold">机器人状态后端不可用</div>
            <div>{store.error?.message ?? "无法读取 Control API。"}</div>
            <div className="text-[11px] opacity-80">当前页面没有展示任何模拟 Bot。</div>
          </div>
        ) : null}

        {store.loadState === "loading" || store.loadState === "idle" ? (
          <div
            className="rounded-[6px] border border-border-subtle bg-elevated px-3 py-6 text-center text-[12.5px] text-subtle-foreground"
            data-testid="bot-loading"
          >
            正在连接本机 Control API…
          </div>
        ) : null}

        {store.loadState === "ready" ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="已注册" value={counts.total} />
              <Metric label="在线" value={counts.online} tone="text-success" />
              <Metric label="失联" value={counts.stale} tone="text-warning" />
              <Metric label="离线" value={counts.offline} tone="text-subtle-foreground" />
            </div>

            {store.bots.length === 0 ? (
              <UiEmptyState
                title="Control API 已连接"
                hint="当前注册表中没有机器人。系统不会创建模拟机器人填充页面。"
              />
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="bot-grid">
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

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-subtle-foreground">
              <span>
                数据时间：{store.generatedAt ? new Date(store.generatedAt).toLocaleString("zh-CN") : "不可用"}
              </span>
              <span>{store.requestId ? `请求 ${store.requestId}` : "无请求编号"}</span>
            </div>
          </>
        ) : null}

        {store.stopMessage ? (
          <div
            className={`rounded-[6px] border px-3 py-2 text-[12.5px] ${
              store.stopState === "failed"
                ? "border-danger/30 bg-danger/10 text-danger"
                : "border-success/30 bg-success/10 text-success"
            }`}
            role="status"
            data-testid="stop-result"
          >
            <span>{store.stopMessage}</span>
            {store.stopTraceId ? (
              <code className="data-mono ml-2 text-[11px]" data-testid="stop-trace-id">追踪编号：{store.stopTraceId}</code>
            ) : null}
          </div>
        ) : null}

        {detailBot ? (
          <div
            className="fixed inset-0 z-50 flex bg-black/60 p-4"
            role="presentation"
            onMouseDown={() => setDetailBotId(null)}
          >
            <aside
              className="mx-auto flex max-h-full w-full max-w-xl flex-col overflow-y-auto rounded-[8px] border border-border-subtle bg-card shadow-lg"
              role="dialog"
              aria-modal="true"
              aria-labelledby="bot-drawer-title"
              data-testid="bot-drawer"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                <div>
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">BOT DETAIL</p>
                  <h4 id="bot-drawer-title" className="text-[14px] font-semibold">{detailBot.botId}</h4>
                </div>
                <Button variant="ghost" size="sm" type="button" onClick={() => setDetailBotId(null)}>
                  关闭
                </Button>
              </header>
              <dl className="grid gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-2">
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
                  label="网络 Ping"
                  value={detailBot.latencyMs === null ? "不可用" : `${detailBot.latencyMs} ms`}
                />
                <DrawerFact label="钻石及以上护甲" value={detailBot.armorSlots ? `${Object.values(detailBot.armorSlots).filter((item) => item?.startsWith("diamond_") || item?.startsWith("netherite_")).length} / 4 槽` : "未上报"} />
                <DrawerFact label="物理 Tick 间隔 P95" value={detailBot.performance?.physics ? `${detailBot.performance.physics.p95IntervalMs} ms · ${detailBot.performance.physics.samples} 样本` : "等待采样"} />
                <DrawerFact label="事件循环延迟 P99" value={detailBot.performance?.eventLoop ? `${detailBot.performance.eventLoop.p99DelayMs} ms · 峰值 ${detailBot.performance.eventLoop.maxDelayMs} ms` : "等待采样"} />
                <DrawerFact label="位置" value={formatPosition(detailBot)} />
                <DrawerFact label="L0 安全" value={formatSafety(detailBot)} />
                <DrawerFact label="当前任务" value={formatCurrentTask(detailBot)} />
                <DrawerFact
                  label="MC 版本"
                  value={detailBot.minecraftVersion ? `${detailBot.minecraftVersion.resolvedVersion ?? "未解析"} · ${supportLevelLabel(detailBot.minecraftVersion.supportLevel)}` : "未解析"}
                />
                <DrawerFact
                  label="最后消息"
                  value={new Date(detailBot.lastMessageAt).toLocaleString("zh-CN")}
                />
              </dl>
              <div className="flex flex-wrap gap-2 border-t border-border-subtle px-4 py-3">
                <Button variant="secondary" size="sm" type="button" asChild={false}>
                  <a href={`/incidents?bot=${encodeURIComponent(detailBot.botId)}`}>该 Bot 的 Incidents</a>
                </Button>
                <Button variant="secondary" size="sm" type="button" asChild={false}>
                  <a href={`/api/incidents/export?scope=bot:${encodeURIComponent(detailBot.botId)}&format=zip`}>
                    Export Bot Incidents (ZIP)
                  </a>
                </Button>
              </div>
            </aside>
          </div>
        ) : null}

        {selectedBot ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            role="presentation"
            onMouseDown={closeStopDialog}
          >
            <div
              className="w-full max-w-md rounded-[8px] border border-border-subtle bg-card p-4 shadow-lg"
              role="dialog"
              aria-modal="true"
              aria-labelledby="stop-dialog-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">SECOND CONFIRMATION</p>
              <h4 id="stop-dialog-title" className="text-[14px] font-semibold">停止机器人 {selectedBot.botId}？</h4>
              <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
                系统只发送优雅停止命令，并等待目标 Runtime 返回真实确认。离线或失联 Bot 不允许停止。
              </p>
              <label htmlFor="stop-confirmation-code" className="mt-3 block text-[11.5px] font-medium text-muted-foreground">
                本地停止确认码
              </label>
              <input
                id="stop-confirmation-code"
                type="password"
                autoComplete="off"
                value={confirmationCode}
                onChange={(event) => setConfirmationCode(event.target.value)}
                placeholder="输入至少 6 位确认码"
                className="mt-1.5 h-9 w-full rounded-[6px] border border-border-subtle bg-background px-2.5 text-[12.5px] text-foreground outline-none focus-visible:border-primary/60"
              />
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="secondary" type="button" onClick={closeStopDialog} disabled={store.stopState === "submitting"}>
                  取消
                </Button>
                <Button
                  variant="destructive"
                  type="button"
                  disabled={confirmationCode.length < 6 || store.stopState === "submitting"}
                  onClick={async () => {
                    const completed = await store.stopBot(selectedBot.botId, confirmationCode);
                    if (completed) closeStopDialog();
                  }}
                >
                  {store.stopState === "submitting" ? "等待 Bot 确认…" : "确认优雅停止"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-[6px] border border-border-subtle bg-elevated px-3 py-2.5">
      <div className="text-[10.5px] uppercase tracking-wide text-subtle-foreground">{label}</div>
      <div className={`data-mono text-[18px] font-semibold ${tone}`}>{value}</div>
    </div>
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
    <div
      className="flex flex-col gap-3 rounded-[8px] border border-border-subtle bg-elevated p-3"
      data-testid={`bot-card-${bot.botId}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10.5px] uppercase tracking-wide text-subtle-foreground">BOT</div>
          <div className="text-[13px] font-semibold">{bot.botId}</div>
        </div>
        <Badge tone={stateTones[bot.connectionState]} data-testid={`bot-state-${bot.botId}`}>
          {stateLabels[bot.connectionState]}
        </Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
        <Fact label="生命" value={bot.health ? `${formatNumber(bot.health.current)} / ${bot.health.maximum === null ? "?" : formatNumber(bot.health.maximum)}` : "不可用"} />
        <Fact label="饥饿" value={bot.food ? `${bot.food.level} / 20` : "不可用"} />
        <Fact label="延迟" value={bot.latencyMs === null ? "不可用" : `${bot.latencyMs} ms`} />
        <Fact label="任务" value={formatCurrentTask(bot)} />
        <Fact label="L0安全" value={formatSafety(bot)} wide />
        <Fact label="位置" value={formatPosition(bot)} wide />
        <Fact label="版本" value={bot.minecraftVersion?.resolvedVersion ?? "未解析"} wide />
      </dl>
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
        <small className="text-[10.5px] text-subtle-foreground">
          最后消息：{new Date(bot.lastMessageAt).toLocaleTimeString("zh-CN")}
        </small>
        <div className="flex items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={onDetail}
            data-testid={`bot-detail-${bot.botId}`}
          >
            详情
          </Button>
          <Button
            variant="destructive"
            size="sm"
            type="button"
            onClick={onStop}
            disabled={!canStop}
            title={!stopConfigured ? "尚未配置本地停止确认码" : undefined}
          >
            {bot.connectionState === "stale" ? "失联不可停止" : "安全停止"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DrawerFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10.5px] uppercase tracking-wide text-subtle-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-[12.5px]">{value}</dd>
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
  return <div className={wide ? "col-span-2" : ""}><dt className="text-[10.5px] uppercase tracking-wide text-subtle-foreground">{label}</dt><dd className="mt-0.5 break-words text-[12px]">{value}</dd></div>;
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
