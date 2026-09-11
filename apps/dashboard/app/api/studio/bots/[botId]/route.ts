import { studioManagerErrorV1Schema } from "@minecraft-studio/protocol";
import { type NextRequest, NextResponse } from "next/server";

import { isSameOriginAction } from "@/lib/same-origin-guard";
import {
  deleteStudioManagedBot,
  loadStudioManagerConfig,
  StudioManagerClientError,
} from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ botId: string }> },
) {
  // F-B3：删除是不可逆写操作，必须与 stop-bot 同等强度（同源 Origin+Host）。
  if (!isSameOriginAction(request, "delete-bot")) {
    return errorResponse("INVALID_REQUEST", "Bot 只能从本机控制台删除。", 403);
  }
  const { botId } = await context.params;
  try {
    await deleteStudioManagedBot(loadStudioManagerConfig(), botId);
    return NextResponse.json(
      { schemaVersion: "1.0", deleted: botId },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    const error =
      cause instanceof StudioManagerClientError
        ? cause
        : new StudioManagerClientError(
            "INTERNAL_ERROR",
            "Studio Manager 无法删除 Bot。",
            502,
          );
    return errorResponse(error.code, error.message, error.httpStatus);
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
