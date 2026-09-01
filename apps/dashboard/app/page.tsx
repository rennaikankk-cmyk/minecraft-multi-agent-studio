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
  bots: Array<{ botId: string; username?: string; connectionState: string; currentTask?: { title: string | null } | null }>;
  incidents: {
    open: number;
    critical: number;
    newLastHour: number;
    repeated: number;
    topLayers: Array<{ layer: string; occurrences: number }>;
    recentCritical: Array<{ incidentId: string; type: string; code: string; layer: string; lastSeenAt: string; count: number }>;
  } | null;
  servers: Array<{ endpoint: string; counts: { ready: number; failed: number } }>;
  environment: EnvironmentView | null;
  failed: string | null;
}

export default function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [studioRes, localRes, botsRes, incidentsRes, serversRes] = await Promise.all([
        fetch("/api/studio/status", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        fetch("/api/servers/local-test", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        fetch("/api/bots", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        fetch("/api/incidents?limit=100", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        fetch("/api/servers", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      ]);
      const bots = (botsRes?.data?.bots ?? []) as OverviewData["bots"];
      const issues = (incidentsRes?.issues ?? []) as Array<{
        incidentId: string; type: string; primaryFailureCode: string; suspectedLayer: string;
        status: string; maxSeverity: string; firstSeenAt: string; lastSeenAt: string; occurrenceCount: number;
      }>;
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      const open = issues.filter((issue) => issue.status === "open" || issue.status === "investigating");
      const layerCounts = new Map<string, number>();
      for (const issue of issues) {
        layerCounts.set(issue.suspectedLayer, (layerCounts.get(issue.suspectedLayer) ?? 0) + issue.occurrenceCount);
      }
      const environment = environmentSnapshot;
      setData({
        spark: studioRes?.ai ?? null,
        localTest: localRes?.resource ?? null,
        bots,
        incidents: {
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
        servers: (serversRes?.servers ?? []) as OverviewData["servers"],
        environment: environment
          ? {
              mode: environment.mode?.value ?? "—",
              cpuModel: environment.hardware?.cpu?.model ?? "—",
              memoryTotal: environment.hardware?.memory ? `${Math.round(environment.hardware.memory.totalBytes / 1024 ** 3)} GB` : "—",
              memoryFree: environment.hardware?.memory ? `${Math.round(environment.hardware.memory.freeBytes / 1024 ** 3)} GB` : "—",
              software: (environment.software ?? []).map((entry: { id: string; status: string; version: string | null }) => ({
                id: entry.id, status: entry.status, version: entry.version,
              })),
            }
          : null,
        failed: null,
      });
    } catch (error) {
      setData((current) => ({ ...(current ?? ({} as OverviewData)), failed: error instanceof Error ? error.message : "unknown" }));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 全量环境检测只做一次（昂贵探测不进轮询；内存实时采样由 EnvironmentMemoryCard 负责）
  const [environmentSnapshot, setEnvironmentSnapshot] = useState<EnvironmentView | null>(null);
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

  const botsOnline = (data?.bots ?? []).filter((bot) => bot.connectionState === "online").length;
  const localOnline = data?.localTest?.status === "online";
  // NORMAL 模式下 Local MC OFF 是正常状态 —— 不是故障
  const localTestNormalOff = !localOnline && data?.localTest?.desiredState !== "on";

  return (
    <div>
      <PageHeader eyebrow="OPERATIONS" title="Overview">
        Studio 运行总览——所有数字来自真实探测（10s 刷新）。
      </PageHeader>

      {data?.failed ? <UiErrorState title="部分数据不可用" detail={data.failed} /> : null}

      {/* Row 1 —— 核心状态 */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Studio Mode" value={data?.environment?.mode ?? "—"} tone="info" href="/runtime" />
        <MetricCard
          label="Local MC"
          value={localOnline ? "ONLINE" : data?.localTest?.status === "starting" ? "STARTING" : "OFF"}
          tone={localOnline ? "localtest" : localTestNormalOff ? "neutral" : "warning"}
          note={localOnline ? (data?.localTest?.managedByStudio ? "managed by Studio" : undefined) : localTestNormalOff ? "NORMAL 下为正常状态" : undefined}
          href="/servers"
        />
        <MetricCard label="Bots Online" value={`${botsOnline} / ${data?.bots.length ?? 0}`} tone={botsOnline > 0 ? "online" : "neutral"} href="/bots" />
        <MetricCard
          label="Open Incidents"
          value={String(data?.incidents?.open ?? 0)}
          note={(data?.incidents?.critical ?? 0) > 0 ? `${data?.incidents?.critical} critical` : undefined}
          tone={(data?.incidents?.critical ?? 0) > 0 ? "critical" : (data?.incidents?.open ?? 0) > 0 ? "warning" : "neutral"}
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
            <div className="flex flex-wrap gap-2">
              <Badge tone="online"><CheckCircle2 className="size-3" aria-hidden />{botsOnline} online</Badge>
              <Badge tone="neutral"><MinusCircle className="size-3" aria-hidden />{(data?.bots.length ?? 0) - botsOnline} other</Badge>
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
              {(data?.bots.length ?? 0) === 0 ? <li className="py-2 text-center text-xs text-subtle-foreground">没有已注册的 Bot</li> : null}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity className="size-4" />Incident 聚合</CardTitle>
            <Link href="/incidents" className="flex items-center text-[11.5px] text-primary hover:underline">详情<ChevronRight className="size-3" /></Link>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Badge tone={(data?.incidents?.newLastHour ?? 0) > 0 ? "warning" : "neutral"}>New 1h: {data?.incidents?.newLastHour ?? 0}</Badge>
              <Badge tone={(data?.incidents?.repeated ?? 0) > 0 ? "warning" : "neutral"}>Repeated: {data?.incidents?.repeated ?? 0}</Badge>
            </div>
            <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Top Layers（后端分类，非默认归咎 Skill）</p>
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Server className="size-4" />Server Connections</CardTitle>
            <Link href="/servers" className="flex items-center text-[11.5px] text-primary hover:underline">详情<ChevronRight className="size-3" /></Link>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {(data?.servers ?? []).map((server) => (
                <li key={server.endpoint} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="data-mono truncate text-muted-foreground" title={server.endpoint}>{server.endpoint}</span>
                  <span className="flex gap-1">
                    <Badge tone={server.counts.ready > 0 ? "online" : "neutral"}>{server.counts.ready} ready</Badge>
                    {server.counts.failed > 0 ? <Badge tone="failed">{server.counts.failed} failed</Badge> : null}
                  </span>
                </li>
              ))}
              {(data?.servers?.length ?? 0) === 0 ? (
                <li className="py-2 text-xs text-subtle-foreground">没有已连接的 External Server（Local Test 见 Servers 页）</li>
              ) : null}
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* Row 3 —— 近期活动 / 待处理 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="size-4 text-warning" />Action Required</CardTitle></CardHeader>
          <CardContent>
            {(data?.incidents?.recentCritical?.length ?? 0) === 0 ? (
              <p className="py-3 text-center text-xs text-subtle-foreground">没有 Critical / 高频重复 Issue 需要处理</p>
            ) : (
              <ul className="space-y-1">
                {(data?.incidents?.recentCritical ?? []).map((issue) => (
                  <li key={issue.incidentId}>
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
            <p className="mt-3 text-[11px] text-subtle-foreground">趋势图（Incident 1h/24h/7d、Spark latency P50/P95）需要后端时序通道——已记录缺口，不伪造。</p>
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
  note?: string;
  href: string;
}) {
  const content = (
    <Card className="anim-120 hover:border-border-strong">
      <div className="p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">{label}</p>
        <p
          className={cn(
            "mt-1 truncate text-xl font-semibold data-mono",
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
        {note ? <p className="mt-0.5 text-[11px] text-subtle-foreground">{note}</p> : null}
      </div>
    </Card>
  );
  return <Link href={href} className="block">{content}</Link>;
}
