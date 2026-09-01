"use client";

// Runtime 页 —— 组件健康/能力矩阵/writer 健康（全部真实数据：
// /api/studio/status（manager status + capabilities + incidents writer health）
// + /api/incidents/health）。
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, Skeleton, UiErrorState, KeyValueRow } from "@/components/ui/primitives";
import { RefreshCw } from "lucide-react";

interface RuntimeStatusView {
  generatedAt: string;
  sessionId: string;
  capabilities: Record<string, unknown>;
  incidents: Record<string, unknown> | null;
  bots: Array<{ botId: string; processState: string; pid: number | null }>;
}

export default function RuntimePage() {
  const [status, setStatus] = useState<RuntimeStatusView | null>(null);
  const [writer, setWriter] = useState<Record<string, unknown> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    setPending(true);
    try {
      const [statusRes, writerRes] = await Promise.all([
        fetch("/api/studio/status", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/incidents/health", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      ]);
      setStatus(statusRes ?? null);
      setWriter(writerRes?.writer ?? null);
      setFailed(statusRes?.error?.message ?? null);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "unknown");
    } finally {
      setLoaded(true);
      setPending(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const writerHealth = (writer ?? status?.incidents) as Record<string, unknown> | null;

  return (
    <div>
      <PageHeader
        eyebrow="SYSTEM · RUNTIME"
        title="Runtime"
        actions={
          <Button variant="ghost" size="icon" aria-label="刷新" onClick={() => void refresh()} disabled={pending}>
            <RefreshCw className={pending ? "animate-spin" : undefined} />
          </Button>
        }
      >
        组件健康、能力矩阵与 Incident writer 状态（observed 数据，非 session 配置）。
      </PageHeader>

      {!loaded ? (
        <Skeleton className="h-40 w-full" />
      ) : failed && !status ? (
        <UiErrorState title="Runtime 状态不可用" detail={failed} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Studio Manager</CardTitle><Badge tone="online">observed</Badge></CardHeader>
            <CardContent className="space-y-2">
              <KeyValueRow label="Manager session" value={status?.sessionId ?? "—"} />
              <KeyValueRow label="生成时间" value={status?.generatedAt ?? "—"} />
              <KeyValueRow label="Bot 进程" value={`${(status?.bots ?? []).filter((bot) => bot.processState === "running").length}/${(status?.bots ?? []).length} running`} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Incident Writer 健康</CardTitle>
              {writerHealth ? (
                <Badge tone={writerHealth.diskPressure ? "degraded" : Number(writerHealth.droppedWriteCount ?? 0) > 0 ? "warning" : "online"}>
                  {writerHealth.diskPressure ? "DISK PRESSURE" : Number(writerHealth.droppedWriteCount ?? 0) > 0 ? "DEGRADED" : "HEALTHY"}
                </Badge>
              ) : null}
            </CardHeader>
            <CardContent>
              {writerHealth ? (
                <div className="space-y-2">
                  <KeyValueRow label="flush 次数" value={String(writerHealth.flushCount ?? "—")} />
                  <KeyValueRow label="store 大小" value={`${Math.round(Number(writerHealth.approxStoreBytes ?? 0) / 1024)} KB / ${Math.round(Number(writerHealth.maxDiskBytes ?? 0) / 1024 / 1024)} MB`} />
                  <KeyValueRow label="dropped writes" value={String(writerHealth.droppedWriteCount ?? 0)} />
                  <KeyValueRow label="quarantined" value={String(writerHealth.quarantinedCount ?? 0)} />
                  <KeyValueRow label="backup restored" value={String(writerHealth.restoredFromBackupCount ?? 0)} />
                  <KeyValueRow label="lifetime/retained occurrences" value={`${writerHealth.lifetimeOccurrences ?? "—"} / ${writerHealth.retainedOccurrences ?? "—"}`} />
                  <KeyValueRow label="pinned issues" value={String(writerHealth.pinnedIssueCount ?? "—")} />
                </div>
              ) : (
                <UiErrorState title="writer health 不可用" />
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>能力矩阵（capability truth）</CardTitle></CardHeader>
            <CardContent>
              <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(status?.capabilities ?? {}).map(([group, value]) => (
                  <li key={group} className="rounded-[6px] border border-border-subtle bg-elevated px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wider text-subtle-foreground">{group}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {typeof value === "object" && value !== null
                        ? Object.entries(value as Record<string, unknown>).map(([key, on]) => (
                            <Badge key={key} tone={on ? "online" : "neutral"}>{key}{on ? "" : " ✕"}</Badge>
                          ))
                        : <Badge tone={value ? "online" : "neutral"}>{String(value)}</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
