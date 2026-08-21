import { randomUUID } from "node:crypto";

import {
  dashboardApiErrorV1Schema,
  dashboardGoalRequestV1Schema,
  dashboardGoalResponseV1Schema,
  type DashboardApiErrorCode,
} from "@minecraft-studio/protocol";
import { type NextRequest, NextResponse } from "next/server";

import {
  DashboardControlError,
  loadDashboardControlConfig,
  requestDashboardGoal,
} from "@/lib/control-api-client";
import { dashboardLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const GOAL_WINDOW_MS = 60_000;
const GOAL_ATTEMPT_LIMIT = 30;
const MAX_GOAL_BODY_BYTES = 16_384;
let goalWindowStartedAt = 0;
let goalAttemptCount = 0;

export async function POST(request: NextRequest) {
  const responseRequestId = randomUUID();
  if (!isSameOriginAction(request)) {
    return errorResponse(responseRequestId, 403, "INVALID_REQUEST", "目标只能从本机控制台提交。");
  }
  if (!allowGoalAttempt(Date.now())) {
    return errorResponse(responseRequestId, 429, "RATE_LIMITED", "目标提交过于频繁，请稍后再试。");
  }
  if (!isJsonRequest(request)) {
    return errorResponse(responseRequestId, 415, "INVALID_REQUEST", "目标请求必须使用 JSON。");
  }

  let input: unknown;
  try {
    input = await readBoundedJson(request);
  } catch (cause) {
    if (cause instanceof GoalBodyError && cause.reason === "too_large") {
      return errorResponse(responseRequestId, 413, "INVALID_REQUEST", "目标请求正文过大。");
    }
    return errorResponse(responseRequestId, 400, "INVALID_REQUEST", "目标请求不是有效 JSON。");
  }
  const parsed = dashboardGoalRequestV1Schema.safeParse(input);
  if (!parsed.success) {
    return errorResponse(responseRequestId, 400, "INVALID_REQUEST", "目标请求字段无效。");
  }

  try {
    const config = loadDashboardControlConfig();
    const result = await requestDashboardGoal(config, parsed.data);
    return NextResponse.json(
      dashboardGoalResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: responseRequestId,
        data: result,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    const error = normalizeError(cause);
    dashboardLogger.warn("dashboard_goal_failed", {
      traceId: parsed.data.requestId,
      taskId: parsed.data.requestId,
      botId: parsed.data.botId,
      skillId: null,
      modelName: null,
      code: error.code,
      upstreamCode: error.upstreamCode,
    });
    return errorResponse(
      responseRequestId,
      error.httpStatus,
      error.code,
      error.message,
    );
  }
}

function allowGoalAttempt(now: number): boolean {
  if (now - goalWindowStartedAt >= GOAL_WINDOW_MS) {
    goalWindowStartedAt = now;
    goalAttemptCount = 0;
  }
  goalAttemptCount += 1;
  return goalAttemptCount <= GOAL_ATTEMPT_LIMIT;
}

function isSameOriginAction(request: NextRequest): boolean {
  if (request.headers.get("x-studio-action") !== "submit-goal") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || !host || (fetchSite !== null && fetchSite !== "same-origin")) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isJsonRequest(request: NextRequest): boolean {
  return request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase() === "application/json";
}

async function readBoundedJson(request: NextRequest): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) throw new GoalBodyError("invalid");
    const byteLength = Number(declaredLength);
    if (!Number.isSafeInteger(byteLength)) throw new GoalBodyError("invalid");
    if (byteLength > MAX_GOAL_BODY_BYTES) throw new GoalBodyError("too_large");
  }
  if (!request.body) throw new GoalBodyError("invalid");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_GOAL_BODY_BYTES) {
        try {
          await reader.cancel("goal_body_too_large");
        } catch {
          // The byte cap still applies when the underlying stream refuses cancellation.
        }
        throw new GoalBodyError("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const bytes = Buffer.concat(chunks, totalBytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (cause) {
    if (cause instanceof GoalBodyError) throw cause;
    throw new GoalBodyError("invalid");
  }
}

class GoalBodyError extends Error {
  constructor(readonly reason: "invalid" | "too_large") {
    super(reason);
    this.name = "GoalBodyError";
  }
}

function normalizeError(cause: unknown): {
  code: DashboardApiErrorCode;
  message: string;
  httpStatus: number;
  upstreamCode: string | null;
} {
  if (cause instanceof DashboardControlError) {
    return {
      code: cause.code,
      message: cause.message,
      httpStatus: cause.httpStatus,
      upstreamCode: cause.upstreamCode,
    };
  }
  return {
    code: "GOAL_FAILED",
    message: "目标未能提交给 Coordinator。",
    httpStatus: 502,
    upstreamCode: null,
  };
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
