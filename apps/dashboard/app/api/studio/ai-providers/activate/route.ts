import { studioManagerErrorV1Schema } from "@minecraft-studio/protocol";
import { type NextRequest, NextResponse } from "next/server";

import {
  activateAiProvider,
  loadStudioManagerConfig,
  StudioManagerClientError,
} from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256;

export async function POST(request: NextRequest) {
  if (!isSameOriginAction(request, "ai-provider-activate")) {
    return errorResponse("INVALID_REQUEST", "AI provider 只能从本机控制台激活。", 403);
  }
  let id = "";
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new Error();
    id = String((JSON.parse(body) as { id?: unknown }).id ?? "");
  } catch {
    return errorResponse("INVALID_REQUEST", "激活请求不是有效 JSON。", 400);
  }
  if (!/^aip-[0-9a-f]{4,32}$/u.test(id)) {
    return errorResponse("INVALID_REQUEST", "AI provider 档案 ID 无效。", 400);
  }
  try {
    const result = await activateAiProvider(loadStudioManagerConfig(), id);
    return NextResponse.json(
      { schemaVersion: "1.0", ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    const error =
      cause instanceof StudioManagerClientError
        ? cause
        : new StudioManagerClientError("INTERNAL_ERROR", "AI provider 无法激活。", 502);
    return errorResponse(error.code, error.message, error.httpStatus);
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

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    studioManagerErrorV1Schema.parse({
      schemaVersion: "1.0",
      error: { code: code as never, message },
    }),
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
