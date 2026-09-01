"use client";

// AI / Spark 页 —— 观察 U9→Spark 推理连接（只读观察，不控制模型进程）。
// 数据：/api/studio/status（manager 对 hub 的真实探测：state/model/models/latency）。
// 深度调度指标（queue/concurrency/breaker）当前仅在 coordinator 结构化日志暴露——
// 页面如实标注 capability 边界，不伪造图表。
import { useCallback, useEffect, useState } from "react";
import { Sparkles, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, Skeleton, UiEmptyState, UiErrorState, KeyValueRow } from "@/components/ui/primitives";
import { SparkStatusBadge } from "@/components/ui/spark-status";

interface AiStatusView {
  state: "connected" | "degraded" | "unavailable" | "misconfigured" | "disabled" | string;
  source: string;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  models: string[];
  latencyMs: number | null;
  lastCheckedAt: string;
  message: string;
}

export default function AiSparkPage() {
  const [status, setStatus] = useState<AiStatusView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    setPending(true);
    try {
      const response = await fetch("/api/studio/status", { cache: "no-store" });
      const body = await response.json();
      if (body?.ai) {
        setStatus(body.ai as AiStatusView);
        setFailed(null);
      } else {
        setFailed(body?.message ?? `HTTP ${response.status}`);
      }
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "unknown");
    } finally {
      setLoaded(true);
      setPending(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div>
      <PageHeader eyebrow="INTELLIGENCE · AI" title="AI / Spark 推理连接">
        U9 主控经生产 AI client 连接 DGX Spark；Spark 只承担模型推理。模型名以 /v1/models 实际返回为准，随时可能更换。
      </PageHeader>

      {!loaded ? (
        <Skeleton className="h-40 w-full" />
      ) : failed && !status ? (
        <UiErrorState title="Spark 状态不可用" detail={failed} />
      ) : !status ? (
        <UiEmptyState title="未配置 Local AI" hint="在 .env.local 配置 LOCAL_AI_HUB_URL 后，此页显示真实连接状态。" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Sparkles className="size-4 text-ai" />节点状态</CardTitle>
              <div className="flex items-center gap-2">
                <SparkStatusBadge state={status.state} />
                <Button variant="ghost" size="icon" aria-label="刷新" onClick={() => void refresh()} disabled={pending}>
                  <RefreshCw className={pending ? "animate-spin" : undefined} />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <KeyValueRow label="State" value={<SparkStatusBadge state={status.state} />} />
              <KeyValueRow label="当前模型" value={status.model ? <span className="data-mono">{status.model}</span> : "—"} />
              <KeyValueRow label="发现来源" value={<span className="data-mono">{status.source}</span>} />
              <KeyValueRow label="Provider" value={status.provider ?? "—"} />
              <KeyValueRow label="Endpoint" value={status.baseUrl ? <span className="data-mono">{status.baseUrl}</span> : "—"} />
              <KeyValueRow label="探测延迟" value={status.latencyMs !== null ? `${status.latencyMs} ms` : "—"} />
              <KeyValueRow label="上次探测" value={status.lastCheckedAt} />
              <KeyValueRow label="消息" value={status.message} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>模型发现（/v1/models 实际返回）</CardTitle></CardHeader>
            <CardContent>
              {status.models.length === 0 ? (
                <UiEmptyState title="未发现模型" hint="hub 在线但未挂牌模型，或节点不可达。" />
              ) : (
                <ul className="space-y-1">
                  {status.models.map((model) => (
                    <li key={model} className="flex items-center justify-between rounded-[6px] border border-border-subtle bg-elevated px-3 py-2">
                      <span className="data-mono text-[12.5px]">{model}</span>
                      {model === status.model ? <Badge tone="ai">SELECTED</Badge> : <Badge tone="neutral">advertised</Badge>}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-[11.5px] leading-relaxed text-subtle-foreground">
                选择规则：显式配置且存在→使用；显式配置但不存在→fail closed；未配置且恰一个→自动；零个→unavailable；多个→fail closed。绝不静默取第一个。
              </p>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>调度与熔断（capability 边界）</CardTitle></CardHeader>
            <CardContent>
              <UiEmptyState
                title="队列深度 / 并发 / 熔断状态：当前经 coordinator 结构化日志暴露（coordinator_ai_health，30s）"
                hint="coordinator→dashboard 的实时指标通道是已记录的缺口；本页不伪造图表。连接级真实数据（state/model/latency/models）如上。"
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
