"use client";

import {
  studioManagerErrorV1Schema,
  studioManagerStatusV1Schema,
  type StudioManagerStatusV1,
} from "@minecraft-studio/protocol";
import { useCallback, useEffect, useState } from "react";

const REFRESH_INTERVAL_MS = 5_000;

export function StudioStatusPanel() {
  const [status, setStatus] = useState<StudioManagerStatusV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/studio/status", { cache: "no-store" });
      const value = (await response.json()) as unknown;
      if (!response.ok) {
        const parsed = studioManagerErrorV1Schema.safeParse(value);
        throw new Error(
          parsed.success ? parsed.data.error.message : "Spark 状态接口不可用。",
        );
      }
      const parsed = studioManagerStatusV1Schema.safeParse(value);
      if (!parsed.success) throw new Error("Spark 状态接口返回了无效数据。");
      setStatus(parsed.data);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Spark 状态不可用。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const ai = status?.ai ?? null;
  const endpoint = ai?.baseUrl ? new URL(ai.baseUrl) : null;
  return (
    <section className="sparkPanel" aria-labelledby="spark-status-title">
      <div className="sparkPanelHeader">
        <div>
          <p className="eyebrow">LOCAL AI · SPARK</p>
          <h3 id="spark-status-title">DGX Spark</h3>
        </div>
        <span className={`sparkState ${ai?.state ?? "unavailable"}`}>
          <i />
          {loading
            ? "探测中"
            : ai?.state === "connected"
              ? "READY"
              : ai?.state === "degraded"
                ? "DEGRADED"
                : ai?.state === "misconfigured"
                  ? "MISCONFIGURED"
                  : ai?.state === "disabled"
                    ? "已关闭"
                    : "UNAVAILABLE"}
        </span>
      </div>

      {error && !status ? (
        <div className="sparkError" role="alert">{error}</div>
      ) : (
        <dl className="sparkFacts">
          <div>
            <dt>服务</dt>
            <dd>{endpoint ? `${endpoint.hostname}:${endpoint.port}` : "未发现"}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{ai?.provider?.toUpperCase() ?? "-"}</dd>
          </div>
          <div>
            <dt>模型</dt>
            <dd title={ai?.model ?? undefined}>{ai?.model ?? "-"}</dd>
          </div>
          <div>
            <dt>延迟</dt>
            <dd>{ai?.latencyMs === null || ai?.latencyMs === undefined ? "-" : `${ai.latencyMs} ms`}</dd>
          </div>
        </dl>
      )}
      <div className="sparkPanelFooter">
        <span>{ai?.message ?? (loading ? "正在自动查找 Spark 服务。" : error)}</span>
        <time dateTime={ai?.lastCheckedAt}>
          {ai ? new Date(ai.lastCheckedAt).toLocaleTimeString("zh-CN") : "-"}
        </time>
      </div>
    </section>
  );
}
