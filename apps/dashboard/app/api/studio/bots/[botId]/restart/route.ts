import {
  studioManagedBotResponseV1Schema,
  studioManagerErrorV1Schema,
} from "@minecraft-studio/protocol";
import { type NextRequest, NextResponse } from "next/server";

import {
  loadStudioManagerConfig,
  restartStudioManagedBot,
  StudioManagerClientError,
} from "@/lib/studio-manager-client";
import { isSameOriginAction } from "@/lib/same-origin-guard";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ botId: string }> },
) {
  if (!isSameOriginAction(request, "restart-bot")) {
    return errorResponse("INVALID_REQUEST", "Bot 只能从本机控制台重启。", 403);
  }
  const { botId } = await context.params;
  try {
    const result = await restartStudioManagedBot(
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
            "Studio Manager 无法重启 Bot。",
            502,
          );
    return errorResponse(error.code, error.message, error.httpStatus);
  }
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
