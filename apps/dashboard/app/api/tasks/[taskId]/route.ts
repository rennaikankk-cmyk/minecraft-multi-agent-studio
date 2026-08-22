import { randomUUID } from "node:crypto";

import {
  dashboardApiErrorV1Schema,
  dashboardTaskDetailResponseV1Schema,
  type DashboardApiErrorCode,
} from "@minecraft-studio/protocol";
import { NextResponse } from "next/server";

import {
  DashboardControlError,
  fetchDashboardTaskDetail,
  loadDashboardControlConfig,
} from "@/lib/control-api-client";
import { dashboardLogger } from "@/lib/logger";

const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { taskId } = await context.params;
  if (!TASK_ID_PATTERN.test(taskId)) {
    return errorResponse(requestId, 400, "INVALID_REQUEST", "任务标识无效。");
  }
  try {
    const data = await fetchDashboardTaskDetail(
      loadDashboardControlConfig(),
      taskId,
    );
    const body = dashboardTaskDetailResponseV1Schema.parse({
      schemaVersion: "1.0",
      requestId,
      data: { ...data, source: "control-api" },
    });
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const error = normalizeError(cause);
    dashboardLogger.warn("dashboard_task_detail_failed", {
      traceId: requestId,
      taskId,
      botId: null,
      skillId: null,
      modelName: null,
      code: error.code,
    });
    return errorResponse(requestId, error.httpStatus, error.code, error.message);
  }
}

function normalizeError(cause: unknown): {
  code: DashboardApiErrorCode;
  message: string;
  httpStatus: number;
} {
  if (cause instanceof DashboardControlError) {
    return {
      code: cause.code,
      message: cause.message,
      httpStatus: cause.httpStatus,
    };
  }
  return {
    code: "TASK_HISTORY_UNAVAILABLE",
    message: "任务历史后端当前不可用。",
    httpStatus: 503,
  };
}

function errorResponse(
  requestId: string,
  status: number,
  code: DashboardApiErrorCode,
  message: string,
): Response {
  return NextResponse.json(
    dashboardApiErrorV1Schema.parse({
      schemaVersion: "1.0",
      requestId,
      error: { code, message },
    }),
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
