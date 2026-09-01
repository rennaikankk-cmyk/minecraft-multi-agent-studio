"use client";

// 全局状态 hook：header/sidebar 共用一次轮询（10s 分类频率，不触发 Spark generation）。
import { useCallback, useEffect, useState } from "react";

export interface GlobalStatus {
  studioMode: "NORMAL" | "LOCAL_TEST" | "E2E" | "UNKNOWN";
  localTest: { status: "online" | "starting" | "not_running" | "unknown"; managedByStudio: boolean } | null;
  bots: { online: number; total: number };
  incidents: { open: number; critical: number };
  spark: { state: string; model: string | null; latencyMs: number | null } | null;
  lastRefreshAt: string | null;
  stale: boolean;
}

const EMPTY: GlobalStatus = {
  studioMode: "UNKNOWN",
  localTest: null,
  bots: { online: 0, total: 0 },
  incidents: { open: 0, critical: 0 },
  spark: null,
  lastRefreshAt: null,
  stale: false,
};

const POLL_MS = 10_000;

export function useGlobalStatus(): GlobalStatus {
  const [status, setStatus] = useState<GlobalStatus>(EMPTY);

  const refresh = useCallback(async () => {
    try {
      const [studioRes, localRes, botsRes, incidentsRes] = await Promise.all([
        fetch("/api/studio/status", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        fetch("/api/servers/local-test", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        fetch("/api/bots", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        fetch("/api/incidents?limit=1&status=open", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      ]);
      const bots = (botsRes?.data?.bots ?? botsRes?.bots ?? []) as Array<{ connectionState?: string }>;
      const issues = (incidentsRes?.issues ?? []) as Array<{ maxSeverity?: string }>;
      const resource = localRes?.resource ?? null;
      setStatus({
        studioMode: typeof studioRes?.capabilities === "object" && studioRes?.sessionId
          ? (resource?.desiredState === "on" || resource?.status === "online" ? "LOCAL_TEST" : "NORMAL")
          : "UNKNOWN",
        localTest: resource
          ? {
              status: resource.status === "online" ? "online" : resource.status === "starting" ? "starting" : resource.status === "not_running" ? "not_running" : "unknown",
              managedByStudio: Boolean(resource.managedByStudio),
            }
          : null,
        bots: {
          online: bots.filter((bot) => bot.connectionState === "online").length,
          total: bots.length,
        },
        incidents: {
          open: incidentsRes?.total ?? issues.length,
          critical: issues.filter((issue) => issue.maxSeverity === "CRITICAL").length,
        },
        spark: studioRes?.ai
          ? { state: studioRes.ai.state, model: studioRes.ai.model, latencyMs: studioRes.ai.latencyMs }
          : null,
        lastRefreshAt: new Date().toISOString(),
        stale: false,
      });
    } catch {
      setStatus((current) => ({ ...current, stale: true, lastRefreshAt: new Date().toISOString() }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return status;
}
