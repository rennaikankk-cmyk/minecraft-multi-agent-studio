"use client";

import {
  aiNodeMetricsHttpResponseV1Schema,
  type AiNodeMetricsSnapshotV1,
} from "@minecraft-studio/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const POLL_INTERVAL_MS = 5_000;
const HISTORY_LIMIT = 720;
const RANGES = [
  { label: "1m", milliseconds: 60_000 },
  { label: "5m", milliseconds: 5 * 60_000 },
  { label: "15m", milliseconds: 15 * 60_000 },
  { label: "1h", milliseconds: 60 * 60_000 },
] as const;

type RangeLabel = (typeof RANGES)[number]["label"];

export function AiNodeDashboard() {
  const [snapshot, setSnapshot] = useState<AiNodeMetricsSnapshotV1 | null>(null);
  const [history, setHistory] = useState<AiNodeMetricsSnapshotV1[]>([]);
  const [range, setRange] = useState<RangeLabel>("5m");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const activeController = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    try {
      const response = await fetch("/api/ai/metrics", {
        cache: "no-store",
        signal: controller.signal,
      });
      const value: unknown = await response.json();
      const parsed = aiNodeMetricsHttpResponseV1Schema.safeParse(value);
      if (!response.ok || !parsed.success) {
        throw new Error("AI 节点指标暂时不可用");
      }
      const next = parsed.data.data;
      setSnapshot(next);
      setHistory((current) => {
        const withoutDuplicate = current.filter(({ sampledAt }) => sampledAt !== next.sampledAt);
        return [...withoutDuplicate, next]
          .sort((left, right) => Date.parse(left.sampledAt) - Date.parse(right.sampledAt))
          .slice(-HISTORY_LIMIT);
      });
      setError("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "AI 节点指标暂时不可用");
    } finally {
      if (activeController.current === controller) activeController.current = null;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      activeController.current?.abort();
    };
  }, [refresh]);

  const selectedHistory = useMemo(() => {
    const milliseconds = RANGES.find(({ label }) => label === range)!.milliseconds;
    const latest = history.length > 0
      ? Date.parse(history.at(-1)!.sampledAt)
      : Date.now();
    return history.filter(({ sampledAt }) => Date.parse(sampledAt) >= latest - milliseconds);
  }, [history, range]);

  return (
    <section className="aiNodeSection" aria-labelledby="ai-node-title" data-testid="ai-node-dashboard">
      <div className="sectionHeading aiNodeHeading">
        <div>
          <span>LOCAL AI HUB</span>
          <h3 id="ai-node-title">{snapshot?.nodeName ?? "MSI DGX Spark"}</h3>
        </div>
        <div className="aiNodeActions">
          <span className={`streamBadge ${snapshot?.status === "online" ? "live" : snapshot?.status === "starting" ? "connecting" : "error"}`}>
            <i />{snapshot?.status === "online" ? "在线" : snapshot?.status === "starting" ? "启动中" : loading ? "采集中" : "离线"}
          </span>
          <button className="refreshButton compact" type="button" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <div className="errorPanel" role="alert">
          <strong>AI 节点指标不可用</strong>
          <span>{error}；不会显示模拟性能数据。</span>
        </div>
      ) : null}

      <div className="aiMetricGrid">
        <Metric label="后端 / 版本" value={snapshot ? `${snapshot.backend} · ${snapshot.backendVersion ?? "版本未知"}` : "—"} />
        <Metric label="模型" value={snapshot?.models.join(", ") || "—"} />
        <Metric label="量化" value={snapshot?.quantization ?? "未由运行配置声明"} />
        <Metric label="Prompt tok/s" value={formatNumber(snapshot?.promptTokensPerSecond)} />
        <Metric label="Generation tok/s" value={formatNumber(snapshot?.generationTokensPerSecond)} />
        <Metric label="单请求 Generation tok/s" value="见 Bot 详情中的真实请求指标" />
        <Metric label="运行 / 等待" value={snapshot ? `${formatNumber(snapshot.runningRequests)} / ${formatNumber(snapshot.waitingRequests)}` : "—"} />
        <Metric label="最大并发" value={formatNumber(snapshot?.maxConcurrency)} />
        <Metric label="KV Cache" value={formatPercent(snapshot?.kvCacheUsagePercent)} />
        <Metric label="网络 RTT" value={formatMs(snapshot?.networkRttMs)} />
        <Metric label="TTFT P50 / P95 / P99" value={formatPercentiles(snapshot?.ttft)} />
        <Metric label="TPOT P50 / P95 / P99" value={formatPercentiles(snapshot?.tpot)} />
        <Metric label="端到端 P95" value={formatMs(snapshot?.endToEndLatency.p95Ms)} />
        <Metric label="错误率" value={snapshot?.errorRate == null ? "指标未提供" : `${(snapshot.errorRate * 100).toFixed(2)}%`} />
      </div>

      <div className="trendToolbar">
        <div><span>TRENDS</span><strong>浏览器会话内采样趋势</strong></div>
        <div className="rangeButtons" aria-label="趋势时间范围">
          {RANGES.map(({ label }) => (
            <button
              className={range === label ? "active" : ""}
              key={label}
              type="button"
              onClick={() => setRange(label)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="trendGrid">
        <TrendCard label="Prompt tok/s" samples={selectedHistory} select={(value) => value.promptTokensPerSecond} />
        <TrendCard label="Generation tok/s" samples={selectedHistory} select={(value) => value.generationTokensPerSecond} />
        <TrendCard label="运行并发" samples={selectedHistory} select={(value) => value.runningRequests} />
        <TrendCard label="等待队列" samples={selectedHistory} select={(value) => value.waitingRequests} />
        <TrendCard label="TTFT P95 ms" samples={selectedHistory} select={(value) => value.ttft.p95Ms} />
        <TrendCard label="KV Cache %" samples={selectedHistory} select={(value) => value.kvCacheUsagePercent} />
        <TrendCard label="网络 RTT ms" samples={selectedHistory} select={(value) => value.networkRttMs} />
        <TrendCard label="错误率 %" samples={selectedHistory} select={(value) => value.errorRate == null ? null : value.errorRate * 100} />
      </div>

      <p className="aiMetricFootnote">
        采集来源：Spark `/health`、`/v1/models`、`/metrics`。缺失字段保持“不可用”；
        趋势仅保留当前浏览器会话收到的最近 1 小时样本。
      </p>
    </section>
  );
}

function Metric({ label, value }: Readonly<{ label: string; value: string }>) {
  return <article className="aiMetric"><span>{label}</span><strong>{value}</strong></article>;
}

function TrendCard({
  label,
  samples,
  select,
}: Readonly<{
  label: string;
  samples: readonly AiNodeMetricsSnapshotV1[];
  select: (value: AiNodeMetricsSnapshotV1) => number | null;
}>) {
  const values = samples.map(select).filter((value): value is number => value !== null);
  const points = chartPoints(values);
  return (
    <article className="trendCard">
      <span>{label}</span>
      <strong>{values.length === 0 ? "—" : formatNumber(values.at(-1))}</strong>
      <svg viewBox="0 0 180 52" role="img" aria-label={`${label} 趋势`}>
        <line x1="0" y1="51" x2="180" y2="51" />
        {points ? <polyline points={points} /> : null}
      </svg>
      <small>{values.length} 个有效样本</small>
    </article>
  );
}

function chartPoints(values: readonly number[]): string | null {
  if (values.length === 0) return null;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = Math.max(maximum - minimum, 1);
  return values.map((value, index) => {
    const x = values.length === 1 ? 90 : (index / (values.length - 1)) * 180;
    const y = 48 - ((value - minimum) / spread) * 44;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function formatNumber(value: number | null | undefined): string {
  return value == null ? "—" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function formatMs(value: number | null | undefined): string {
  return value == null ? "—" : `${formatNumber(value)} ms`;
}

function formatPercent(value: number | null | undefined): string {
  return value == null ? "—" : `${formatNumber(value)}%`;
}

function formatPercentiles(value: AiNodeMetricsSnapshotV1["ttft"] | undefined): string {
  return value ? [value.p50Ms, value.p95Ms, value.p99Ms].map((item) => item == null ? "—" : `${formatNumber(item)} ms`).join(" / ") : "—";
}
