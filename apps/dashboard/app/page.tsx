"use client";

// Overview —— 第一屏回答：Studio 是否健康/模式/Local MC/Bots/Incidents/Spark/待处理。
// 全部真实数据；无后端时序的图表不伪造（趋势图列为缺口）。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Bot as BotIcon,
  CheckCircle2,
  ChevronRight,
  Cpu,
  MinusCircle,
  Server,
  Sparkles,
} from "lucide-react";

import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader, Skeleton, UiErrorState } from "@/components/ui/primitives";
import { EnvironmentMemoryCard } from "@/components/environment-memory";
import { Button } from "@/components/ui/button";
import { SparkStatusBadge } from "@/components/ui/spark-status";
import { loadDashboardStatus } from "@/lib/dashboard-status";
import { cn } from "@/lib/utils";

interface EnvironmentView {
  mode: string;
  cpuModel: string;
  memoryTotal: string;
  memoryFree: string;
  software: Array<{ id: string; status: string; version: string | null }>;
}

interface EnvironmentRaw {
  mode?: { value: string };
  hardware?: { cpu?: { model: string }; memory?: { totalBytes: number; freeBytes: number } };
  software?: Array<{ id: string; status: string; version: string | null }>;
}

interface OverviewData {
  spark: { state: string; model: string | null; latencyMs: number | null } | null;
  localTest: { status: string; desiredState: string; managedByStudio: boolean } | null;
  localTestUnknown: boolean;
  // null = 后端不可用/无法确认：绝不降级成 0 或 []（ARCHITECTURE.md §10、AGENTS.md §1.6/§2.10）。
  bots: Array<{ botId: string; username?: string; connectionState: string; currentTask?: { title: string | null } | null }> | null;
  incidents: {
    open: number;
    critical: number;
    newLastHour: number;
    repeated: number;
    topLayers: Array<{ layer: string; occurrences: number }>;
    recentCritical: Array<{ incidentId: string; type: string; code: string; layer: string; lastSeenAt: string; count: number }>;
  } | null;
  servers: Array<{ endpoint: string; counts: { ready: number; failed: number } }> | null;
  environment: EnvironmentView | null;
  failed: string | null;
}

const DISMISSED_STORAGE_KEY = "studio-dismissed-action-required";

export default function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Action Required 逐条忽略（仅本地视角：不影响 incidents 控制台本身）。
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  // 全量环境检测只做一次（昂贵探测不进轮询；内存实时采样由 EnvironmentMemoryCard 负责）。
  // 必须声明在 refresh 之前并进入其依赖：否则 refresh 永远闭包到首次渲染的 null
  // （Host 卡片的 CPU/内存/模式永远显示「—」）。
  const [environmentSnapshot, setEnvironmentSnapshot] = useState<EnvironmentView | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
      const parsed = raw === null ? [] : JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
        setDismissedIds(parsed);
      }
    } catch {
      // 损坏键按空处理。
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(dismissedIds));
    } catch {
      // 写不进（隐私模式等）就只保留会话内状态。
    }
  }, [dismissedIds]);

  const dismissedSet = new Set(dismissedIds);
  const recentCritical = data?.incidents?.recentCritical ?? [];
  const visibleCritical = recentCritical.filter((issue) => !dismissedSet.has(issue.incidentId));
  const dismissedCount = recentCritical.length - visibleCritical.length;

  const refresh = useCallback(async () => {
    try {
      // F-B4：统一装载器把「后端不可用」显式表达为 null + failureMessage，
      // 不再把失败的 fetch 吞成 []/0 的假健康零态。
      const snapshot = await loadDashboardStatus();
      const issues = snapshot.incidents ?? [];
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      const open = issues.filter((issue) => issue.status === "open" || issue.status === "investigating");
      const layerCounts = new Map<string, number>();
      for (const issue of issues) {
        layerCounts.set(issue.suspectedLayer, (layerCounts.get(issue.suspectedLayer) ?? 0) + issue.occurrenceCount);
      }
      setData({
        spark: snapshot.studio?.ai ?? null,
        localTest: snapshot.localTest,
        localTestUnknown: snapshot.unavailable.includes("Local Test"),
        bots: snapshot.bots,
        incidents: snapshot.incidents === null ? null : {
          open: open.length,
          critical: open.filter((issue) => issue.maxSeverity === "CRITICAL").length,
          newLastHour: issues.filter((issue) => issue.firstSeenAt >= hourAgo).length,
          repeated: issues.filter((issue) => issue.occurrenceCount > 1).length,
          topLayers: [...layerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([layer, occurrences]) => ({ layer, occurrences })),
          recentCritical: open
            .filter((issue) => issue.maxSeverity === "CRITICAL" || issue.occurrenceCount > 3)
            .slice(0, 5)
            .map((issue) => ({
              incidentId: issue.incidentId, type: issue.type, code: issue.primaryFailureCode,
              layer: issue.suspectedLayer, lastSeenAt: issue.lastSeenAt, count: issue.occurrenceCount,
            })),
        },
        servers: snapshot.servers,
        environment: environmentSnapshot,
        failed: snapshot.failureMessage,
      });
    } catch (error) {
      // 装载器不会抛异常；保留兜底但不伪造任何数字。
      setData((current) => ({ ...(current ?? ({} as OverviewData)), failed: error instanceof Error ? error.message : "unknown" }));
    } finally {
      setLoaded(true);
    }
  }, [environmentSnapshot]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 全量环境检测只做一次（昂贵探测不进轮询；内存实时采样由 EnvironmentMemoryCard 负责）。
  const detectEnvironment = useCallback(() => {
    void fetch("/api/environment", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { environment?: EnvironmentRaw }) => {
        const environment = body?.environment;
        if (!environment) return;
        setEnvironmentSnapshot({
          mode: environment.mode?.value ?? "—",
          cpuModel: environment.hardware?.cpu?.model ?? "—",
          memoryTotal: environment.hardware?.memory ? `${Math.round(environment.hardware.memory.totalBytes / 1024 ** 3)} GB` : "—",
          memoryFree: environment.hardware?.memory ? `${Math.round(environment.hardware.memory.freeBytes / 1024 ** 3)} GB` : "—",
          software: (environment.software ?? []).map((entry: { id: string; status: string; version: string | null }) => ({
            id: entry.id, status: entry.status, version: entry.version,
          })),
        });
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    detectEnvironment();
  }, [detectEnvironment]);

  if (!loaded) {
    return (
      <div>
        <PageHeader eyebrow="OPERATIONS" title="Overview" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-20" />)}
        </div>
      </div>
    );
  }

  // null = 后端不可用：显示「—」，绝不显示 0/0 的健康假象。
  const botsOnline = data?.bots == null ? null : data.bots.filter((bot) => bot.connectionState === "online").length;
  const botsTotal = data?.bots?.length ?? null;
  const servers = data?.servers ?? null;
  const localOnline = data?.localTest?.status === "online";
  const localTestUnknown = data?.localTestUnknown === true;
  // NORMAL 模式下 Local MC OFF 是正常状态 —— 不是故障（仅在确实读到观察态时成立）
  const localTestNormalOff = !localTestUnknown && !localOnline && data?.localTest?.desiredState !== "on";

  return (
    <div>
      <PageHeader eyebrow="OPERATIONS" title="Overview">
        Studio 运行总览——所有数字来自真实探测（10s 刷新）。后端不可用时显示「—」而不是 0。
      </PageHeader>

      {data?.failed ? <UiErrorState title="部分数据不可用" detail={data.failed} /> : null}

      {/* Row 1 —— 核心状态 */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Studio Mode" value={data?.environment?.mode ?? "—"} tone="info" href="/runtime" note={undefined} />
        <MetricCard
          label="Local MC"
          value={localTestUnknown ? "—" : localOnline ? "ONLINE" : data?.localTest?.status === "starting" ? "STARTING" : "OFF"}
          tone={localTestUnknown ? "neutral" : localOnline ? "localtest" : localTestNormalOff ? "neutral" : "warning"}
          note={localTestUnknown ? "观察态不可用" : localOnline ? (data?.localTest?.managedByStudio ? "managed by Studio" : undefined) : localTestNormalOff ? "NORMAL 下为正常状态" : undefined}
          href="/servers"
        />
        <MetricCard
          label="Bots Online"
          value={botsOnline === null ? "—" : `${botsOnline} / ${botsTotal ?? 0}`}
          tone={botsOnline !== null && botsOnline > 0 ? "online" : "neutral"}
          href="/bots"
          note={botsOnline === null ? "后端不可用" : undefined}
        />
        <MetricCard
          label="Open Incidents"
          value={data?.incidents === null ? "—" : String(data?.incidents?.open ?? 0)}
          note={data?.incidents === null ? "后端不可用" : (data?.incidents?.critical ?? 0) > 0 ? `${data?.incidents?.critical} critical` : undefined}
          tone={data?.incidents === null ? "neutral" : (data?.incidents?.critical ?? 0) > 0 ? "critical" : (data?.incidents?.open ?? 0) > 0 ? "warning" : "neutral"}
          href="/incidents"
        />
        <Card className="anim-120 hover:border-border-strong">
          <Link href="/ai-spark" className="block p-3">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">
              <Sparkles className="size-3.5 text-ai" aria-hidden /> Spark
            </p>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <SparkStatusBadge state={data?.spark?.state ?? "unknown"} />
              <span className="truncate text-[12px] text-muted-foreground data-mono" title={data?.spark?.model ?? ""}>
                {data?.spark?.model ?? "—"}
              </span>
            </div>
            {data?.spark?.latencyMs != null ? <p className="mt-1 text-[11px] text-subtle-foreground">{data.spark.latencyMs} ms probe</p> : null}
          </Link>
        </Card>
      </div>

      {/* Row 2 —— 主要运行视图 */}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><BotIcon className="size-4" />Bot Fleet</CardTitle>
            <Link href="/bots" className="flex items-center text-[11.5px] text-primary hover:underline">详情<ChevronRight className="size-3" /></Link>
          </CardHeader>
          <CardContent>
            {data?.bots === null ? (
              <p className="py-3 text-center text-xs text-warning">Bot 列表不可用（后端未连接）——不显示 0/0 假象。</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="online"><CheckCircle2 className="size-3" aria-hidden />{botsOnline ?? 0} online</Badge>
                  <Badge tone="neutral"><MinusCircle className="size-3" aria-hidden />{(botsTotal ?? 0) - (botsOnline ?? 0)} other</Badge>
                </div>
                <ul className="mt-3 space-y-1">
                  {(data?.bots ?? []).slice(0, 6).map((bot) => (
                    <li key={bot.botId} className="flex items-center justify-between gap-2 text-[12px]">
                      <span className="data-mono text-muted-foreground">{bot.botId}</span>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="max-w-44 truncate text-subtle-foreground">{bot.currentTask?.title ?? "—"}</span>
                        <Badge tone={bot.connectionState === "online" ? "online" : "neutral"}>{bot.connectionState}</Badge>
                      </span>
                    </li>
                  ))}
                  {(botsTotal ?? 0) === 0 ? <li className="py-2 text-center text-xs text-subtle-foreground">没有已注册的 Bot</li> : null}
                </ul>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity className="size-4" />Incident 聚合</CardTitle>
            <Link href="/incidents" className="flex items-center text-[11.5px] text-primary hover:underline">详情<ChevronRight className="size-3" /></Link>
          </CardHeader>
          <CardContent>
            {data?.incidents === null ? (
              <p className="py-3 text-center text-xs text-warning">Incident 列表不可用（后端未连接）——不显示 0 假象。</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={(data?.incidents?.newLastHour ?? 0) > 0 ? "warning" : "neutral"}>New 1h: {data?.incidents?.newLastHour ?? 0}</Badge>
                  <Badge tone={(data?.incidents?.repeated ?? 0) > 0 ? "warning" : "neutral"}>Repeated: {data?.incidents?.repeated ?? 0}</Badge>
                </div>
                <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Top Layers（按后端确定性分类聚合的 occurrence 数）</p>
                <ul className="mt-1 space-y-1">
                  {(data?.incidents?.topLayers ?? []).map(({ layer, occurrences }) => (
                    <li key={layer}>
                      <Link href={`/incidents?layer=${encodeURIComponent(layer)}`} className="flex items-center justify-between rounded-[5px] px-2 py-1 text-[12px] text-muted-foreground anim-120 hover:bg-hover hover:text-foreground">
                        <span>{layer}</span>
                        <span className="data-mono">{occurrences}</span>
                      </Link>
                    </li>
                  ))}
                  {(data?.incidents?.topLayers?.length ?? 0) === 0 ? <li className="px-2 py-2 text-xs text-subtle-foreground">没有 Incident</li> : null}
                </ul>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Server className="size-4" />Server Connections</CardTitle>
            <Link href="/servers" className="flex items-center text-[11.5px] text-primary hover:underline">详情<ChevronRight className="size-3" /></Link>
          </CardHeader>
          <CardContent>
            {servers === null ? (
              <p className="py-3 text-center text-xs text-warning">服务器连接列表不可用（后端未连接）。</p>
            ) : (
              <ul className="space-y-1">
                {servers.map((server) => (
                  <li key={server.endpoint} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="data-mono truncate text-muted-foreground" title={server.endpoint}>{server.endpoint}</span>
                    <span className="flex gap-1">
                      <Badge tone={server.counts.ready > 0 ? "online" : "neutral"}>{server.counts.ready} ready</Badge>
                      {server.counts.failed > 0 ? <Badge tone="failed">{server.counts.failed} failed</Badge> : null}
                    </span>
                  </li>
                ))}
                {servers.length === 0 ? (
                  <li className="py-2 text-xs text-subtle-foreground">没有已连接的 External Server（Local Test 见 Servers 页）</li>
                ) : null}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 3 —— 近期活动 / 待处理 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" />Action Required
              {dismissedCount > 0 ? (
                <button
                  type="button"
                  className="ml-auto text-[11px] text-subtle-foreground underline-offset-2 hover:underline"
                  onClick={() => setDismissedIds([])}
                  data-testid="action-required-restore"
                >
                  已忽略 {dismissedCount}（点击恢复）
                </button>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(visibleCritical.length) === 0 ? (
              <p className="py-3 text-center text-xs text-subtle-foreground">
                {dismissedCount > 0 && (data?.incidents?.recentCritical?.length ?? 0) > 0
                  ? "全部条目已忽略（点上方恢复）"
                  : "没有 Critical / 高频重复 Issue 需要处理"}
              </p>
            ) : (
              <ul className="space-y-1">
                {visibleCritical.map((issue) => (
                  <li key={issue.incidentId} className="group relative">
                    <Link href={`/incidents?focus=${issue.incidentId}`} className="flex items-center justify-between gap-2 rounded-[5px] px-2 py-1.5 anim-120 hover:bg-hover">
                      <span className="flex min-w-0 items-center gap-2">
                        <Badge tone="failed">{issue.incidentId}</Badge>
                        <span className="truncate text-[12px] text-muted-foreground data-mono">{issue.code}</span>
                      </span>
                      <span className="flex items-center gap-2 text-[11px] text-subtle-foreground">
                        <Badge tone="neutral">×{issue.count}</Badge>
                        <span>{issue.layer}</span>
                      </span>
                    </Link>
                    <button
                      type="button"
                      title="忽略此条（新出现的问题不受影响）"
                      aria-label={`忽略 ${issue.incidentId}`}
                      className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded px-1 text-xs text-subtle-foreground hover:text-foreground group-hover:block"
                      onClick={() => setDismissedIds((ids) => [...ids, issue.incidentId])}
                      data-testid={`action-required-dismiss-${issue.incidentId}`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Cpu className="size-4" />Host</CardTitle><Button variant="ghost" size="sm" onClick={detectEnvironment}>重新检测</Button></CardHeader>
          <CardContent>
            <div className="space-y-1.5 text-[12.5px]">
              <div className="flex justify-between"><span className="text-subtle-foreground">CPU</span><span className="data-mono">{data?.environment?.cpuModel ?? "—"}</span></div>
              <EnvironmentMemoryCard />
              <div className="flex justify-between"><span className="text-subtle-foreground">Mode</span><span className="data-mono">{data?.environment?.mode ?? "—"}</span></div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {(data?.environment?.software ?? []).map((entry) => (
                <Badge key={entry.id} tone={entry.status === "available" ? "online" : "neutral"}>{entry.id}{entry.version ? ` ${entry.version}` : ""}</Badge>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-4 text-muted-foreground">趋势图（Incident 1h/24h/7d、Spark latency P50/P95）需要后端时序通道——已记录缺口，不伪造。</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MetricCard({
  label, value, tone, note, href,
}: {
  label: string;
  value: string;
  tone: "info" | "online" | "warning" | "critical" | "neutral" | "localtest";
  note: string | undefined;
  href: string;
}) {
  const content = (
    <Card className="anim-120 hover:border-border-strong">
      <div className="p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">{label}</p>
        <p
          className={cn(
            "mt-1 text-xl font-semibold leading-7 data-mono",
            tone === "online" && "text-success",
            tone === "warning" && "text-warning",
            tone === "critical" && "text-critical",
            tone === "info" && "text-primary",
            tone === "localtest" && "text-localtest",
            tone === "neutral" && "text-muted-foreground",
          )}
        >
          {value}
        </p>
        {note ? <p className="mt-0.5 text-[11px] leading-4 text-subtle-foreground">{note}</p> : null}
      </div>
    </Card>
  );
  return <Link href={href} className="block">{content}</Link>;
}
