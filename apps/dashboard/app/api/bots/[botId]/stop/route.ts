import { randomUUID } from "node:crypto";

import {
  dashboardApiErrorV1Schema,
  dashboardStopRequestV1Schema,
  dashboardStopResponseV1Schema,
  identifierSchema,
  type DashboardApiErrorCode,
} from "@minecraft-studio/protocol";
import { type NextRequest, NextResponse } from "next/server";

import {
  DashboardControlError,
  loadDashboardControlConfig,
  requestDashboardBotStop,
  verifyStopConfirmation,
} from "@/lib/control-api-client";
import { dashboardLogger } from "@/lib/logger";
import { isSameOriginAction } from "@/lib/same-origin-guard";

const STOP_WINDOW_MS = 60_000;
const STOP_ATTEMPT_LIMIT = 10;
let stopWindowStartedAt = 0;
let stopAttemptCount = 0;

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ botId: string }> },
) {
  const responseRequestId = randomUUID();
  if (!allowStopAttempt(Date.now())) {
    return errorResponse(responseRequestId, 429, "RATE_LIMITED", "停止确认尝试过于频繁，请稍后再试。");
  }
  if (!isSameOriginAction(request, "stop-bot")) {
    return errorResponse(responseRequestId, 403, "CONFIRMATION_REQUIRED", "停止操作必须从本机控制台确认。");
  }

  const { botId } = await context.params;
  if (!identifierSchema.safeParse(botId).success) {
    return errorResponse(responseRequestId, 400, "INVALID_REQUEST", "机器人标识无效。");
  }

  let value: unknown;
  try {
    const text = await request.text();
    if (text.length > 512) throw new Error("body_too_large");
    value = JSON.parse(text) as unknown;
  } catch {
    return errorResponse(responseRequestId, 400, "INVALID_REQUEST", "停止请求格式无效。");
  }
  const input = dashboardStopRequestV1Schema.safeParse(value);
  if (!input.success) {
    return errorResponse(responseRequestId, 400, "INVALID_REQUEST", "停止请求格式无效。");
  }

  try {
    const config = loadDashboardControlConfig();
    if (!verifyStopConfirmation(config, input.data.confirmationCode)) {
      return errorResponse(responseRequestId, 403, "CONFIRMATION_REQUIRED", "停止确认码不正确。");
    }
    dashboardLogger.info("dashboard_stop_requested", {
      traceId: input.data.requestId,
      taskId: null,
      botId,
      skillId: null,
      modelName: null,
    });
    const result = await requestDashboardBotStop(
      config,
      botId,
      input.data.requestId,
    );
    const body = dashboardStopResponseV1Schema.parse({
      schemaVersion: "1.0",
      requestId: responseRequestId,
      data: result.data,
    });
    dashboardLogger.info("dashboard_stop_result", {
      traceId: result.data.traceId,
      taskId: null,
      botId,
      skillId: null,
      modelName: null,
      commandId: result.data.commandId,
      outcome: result.data.outcome,
    });
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const error = cause instanceof DashboardControlError
      ? { code: cause.code, message: cause.message }
      : { code: "STOP_FAILED" as const, message: "停止结果无法确认。" };
    dashboardLogger.warn("dashboard_stop_failed", {
      traceId: input.data.requestId,
      taskId: null,
      botId,
      skillId: null,
      modelName: null,
      code: error.code,
    });
    return errorResponse(
      responseRequestId,
      error.code === "DASHBOARD_CONTROL_NOT_CONFIGURED" ? 503 : 502,
      error.code,
      error.message,
    );
  }
}

function allowStopAttempt(now: number): boolean {
  if (now - stopWindowStartedAt >= STOP_WINDOW_MS) {
    stopWindowStartedAt = now;
    stopAttemptCount = 0;
  }
  stopAttemptCount += 1;
  return stopAttemptCount <= STOP_ATTEMPT_LIMIT;
}

function errorResponse(
  requestId: string,
  status: number,
  code: DashboardApiErrorCode,
  message: string,
) {
  return NextResponse.json(
    dashboardApiErrorV1Schema.parse({
      schemaVersion: "1.0",
      requestId,
      error: { code, message },
    }),
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
