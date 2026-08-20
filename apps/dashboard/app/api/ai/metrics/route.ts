import { randomUUID } from "node:crypto";

import {
  aiNodeMetricsHttpResponseV1Schema,
  dashboardApiErrorV1Schema,
  type DashboardApiErrorCode,
} from "@minecraft-studio/protocol";
import { NextResponse } from "next/server";

import {
  DashboardControlError,
  fetchDashboardAiMetrics,
  loadDashboardControlConfig,
} from "@/lib/control-api-client";
import { dashboardLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = randomUUID();
  try {
    const snapshot = await fetchDashboardAiMetrics(loadDashboardControlConfig());
    return NextResponse.json(
      aiNodeMetricsHttpResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId,
        data: snapshot,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    const error = normalizeError(cause);
    dashboardLogger.error("dashboard_ai_metrics_failed", {
      traceId: requestId,
      taskId: null,
      botId: null,
      skillId: null,
      modelName: null,
      code: error.code,
    });
    return NextResponse.json(
      dashboardApiErrorV1Schema.parse({
        schemaVersion: "1.0",
        requestId,
        error,
      }),
      {
        status: error.code === "DASHBOARD_CONTROL_NOT_CONFIGURED" ? 503 : 502,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

function normalizeError(cause: unknown): {
  code: DashboardApiErrorCode;
  message: string;
} {
  if (cause instanceof DashboardControlError) {
    return { code: cause.code, message: cause.message };
  }
  return {
    code: "INVALID_CONTROL_RESPONSE",
    message: "AI 节点指标接口返回了无法识别的数据。",
  };
}
