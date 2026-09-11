"use client";

// 全局状态 hook：header/sidebar 共用一次轮询（10s 分类频率，不触发 Spark generation）。
// F-B4：数据装载与「后端不可用」判定收敛到 lib/dashboard-status.ts —— 失败时
// 对应字段为 null 且 stale=true，不再生成 0/0 的假健康态。
import { useCallback, useEffect, useState } from "react";

import {
  loadDashboardStatus,
  toGlobalStatusView,
  type GlobalStatusView,
} from "@/lib/dashboard-status";

export type { GlobalStatusView as GlobalStatus };

const EMPTY: GlobalStatusView = {
  studioMode: "UNKNOWN",
  localTest: null,
  localTestUnknown: false,
  bots: null,
  incidents: null,
  spark: null,
  lastRefreshAt: null,
  stale: false,
};

const POLL_MS = 10_000;

export function useGlobalStatus(): GlobalStatusView {
  const [status, setStatus] = useState<GlobalStatusView>(EMPTY);

  const refresh = useCallback(async () => {
    // loadDashboardStatus 对每个数据源独立兜底，不会抛异常。
    const snapshot = await loadDashboardStatus();
    setStatus(toGlobalStatusView(snapshot, new Date().toISOString()));
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return status;
}
