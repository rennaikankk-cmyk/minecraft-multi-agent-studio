import { randomUUID } from "node:crypto";

import {
  dashboardApiErrorV1Schema,
  dashboardBotListResponseV1Schema,
  type DashboardApiErrorCode,
} from "@minecraft-studio/protocol";
import { NextResponse } from "next/server";

import {
  DashboardControlError,
  fetchDashboardBots,
  loadDashboardControlConfig,
} from "@/lib/control-api-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = randomUUID();
  try {
    const config = loadDashboardControlConfig();
    const result = await fetchDashboardBots(config);
    const body = dashboardBotListResponseV1Schema.parse({
      schemaVersion: "1.0",
      requestId,
      data: {
        source: "control-api",
        generatedAt: result.generatedAt,
        bots: result.bots,
        capabilities: {
          stopConfirmationConfigured: config.stopConfirmationSha256 !== null,
        },
      },
    });
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const error = normalizeError(cause);
    console.error("Dashboard Control API read failed", {
      requestId,
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
  if (cause instanceof DashboardControlError) return cause;
  return {
    code: "INVALID_CONTROL_RESPONSE",
    message: "机器人状态接口返回了无法识别的数据。",
  };
}
