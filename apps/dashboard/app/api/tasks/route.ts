import { randomUUID } from "node:crypto";

import {
  dashboardApiErrorV1Schema,
  dashboardTaskListResponseV1Schema,
  taskHistoryListQueryV1Schema,
  type DashboardApiErrorCode,
  type TaskHistoryListQueryV1,
} from "@minecraft-studio/protocol";
import { NextResponse } from "next/server";

import {
  DashboardControlError,
  fetchDashboardTasks,
  loadDashboardControlConfig,
} from "@/lib/control-api-client";
import { dashboardLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const MAX_TASK_HISTORY_LIMIT = 32;

export async function GET(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const query = parseQuery(new URL(request.url));
  if (!query) {
    return errorResponse(requestId, 400, "INVALID_REQUEST", "任务历史查询参数无效。");
  }
  try {
    const data = await fetchDashboardTasks(loadDashboardControlConfig(), query);
    const body = dashboardTaskListResponseV1Schema.parse({
      schemaVersion: "1.0",
      requestId,
      data: { ...data, source: "control-api" },
    });
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const error = normalizeError(cause);
    dashboardLogger.warn("dashboard_task_history_failed", {
      traceId: requestId,
      taskId: null,
      botId: query.botId,
      skillId: null,
      modelName: null,
      code: error.code,
    });
    return errorResponse(requestId, error.httpStatus, error.code, error.message);
  }
}

function parseQuery(url: URL): TaskHistoryListQueryV1 | null {
  const allowed = new Set(["limit", "cursor", "status", "botId"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  }
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/u.test(rawLimit)) return null;
  if (rawLimit !== null && Number(rawLimit) > MAX_TASK_HISTORY_LIMIT) return null;
  const parsed = taskHistoryListQueryV1Schema.safeParse({
    limit: rawLimit === null ? 25 : Number(rawLimit),
    cursor: url.searchParams.get("cursor"),
    status: url.searchParams.get("status"),
    botId: url.searchParams.get("botId"),
  });
  return parsed.success ? parsed.data : null;
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
