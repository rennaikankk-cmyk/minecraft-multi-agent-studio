import {
  studioCreateBotRequestV1Schema,
  studioManagedBotResponseV1Schema,
  studioManagerErrorV1Schema,
} from "@minecraft-studio/protocol";
import { type NextRequest, NextResponse } from "next/server";

import {
  createStudioManagedBot,
  loadStudioManagerConfig,
  StudioManagerClientError,
} from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4_096;

export async function POST(request: NextRequest) {
  if (!isSameOriginAction(request, "create-bot")) {
    return errorResponse("INVALID_REQUEST", "Bot 只能从本机控制台创建。", 403);
  }
  if (
    request.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return errorResponse("INVALID_REQUEST", "Bot 创建请求必须使用 JSON。", 415);
  }
  let input: unknown;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new Error();
    input = JSON.parse(body) as unknown;
  } catch {
    return errorResponse("INVALID_REQUEST", "Bot 创建请求不是有效 JSON。", 400);
  }
  const parsed = studioCreateBotRequestV1Schema.safeParse(input);
  if (!parsed.success) {
    return errorResponse("INVALID_REQUEST", "Bot 创建请求字段无效。", 400);
  }
  try {
    const result = await createStudioManagedBot(
      loadStudioManagerConfig(),
      parsed.data,
    );
    return NextResponse.json(studioManagedBotResponseV1Schema.parse(result), {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (cause) {
    return clientErrorResponse(cause);
  }
}

function isSameOriginAction(request: NextRequest, action: string): boolean {
  if (request.headers.get("x-studio-action") !== action) return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || !host || (fetchSite !== null && fetchSite !== "same-origin")) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function clientErrorResponse(cause: unknown) {
  const error =
    cause instanceof StudioManagerClientError
      ? cause
      : new StudioManagerClientError(
          "INTERNAL_ERROR",
          "Studio Manager 无法创建 Bot。",
          502,
        );
  return errorResponse(error.code, error.message, error.httpStatus);
}

function errorResponse(
  code: StudioManagerClientError["code"],
  message: string,
  status: number,
) {
  return NextResponse.json(
    studioManagerErrorV1Schema.parse({
      schemaVersion: "1.0",
      error: { code, message },
    }),
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
