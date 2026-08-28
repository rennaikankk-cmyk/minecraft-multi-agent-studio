import {
  studioManagedBotResponseV1Schema,
} from "@minecraft-studio/protocol";
import { type NextRequest, NextResponse } from "next/server";

import {
  loadStudioManagerConfig,
  stopStudioManagedBot,
  StudioManagerClientError,
} from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ botId: string }> },
) {
  if (!isSameOriginAction(request)) {
    return errorResponse("INVALID_REQUEST", "Bot 只能从本机控制台停止。", 403);
  }
  const { botId } = await context.params;
  try {
    const result = await stopStudioManagedBot(
      loadStudioManagerConfig(),
      botId,
    );
    return NextResponse.json(studioManagedBotResponseV1Schema.parse(result), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (cause) {
    const error =
      cause instanceof StudioManagerClientError
        ? cause
        : new StudioManagerClientError(
            "INTERNAL_ERROR",
            "Studio Manager 无法停止 Bot。",
            502,
          );
    return errorResponse(error.code, error.message, error.httpStatus);
  }
}

function isSameOriginAction(request: NextRequest): boolean {
  return request.headers.get("x-studio-action") === "stop-bot";
}

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
