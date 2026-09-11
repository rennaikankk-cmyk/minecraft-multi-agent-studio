import { type NextRequest, NextResponse } from "next/server";

import {
  loadStudioManagerConfig,
  restartStudioServices,
  StudioManagerClientError,
} from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

/** 写面统一 X-Studio-Action 守卫（与 stop-bot / skill-release 同纪律）。 */
function isRestartAction(request: NextRequest): boolean {
  return request.headers.get("x-studio-action") === "studio-restart";
}

export async function POST(request: NextRequest) {
  if (!isRestartAction(request)) {
    return NextResponse.json(
      { ok: false, error: "MISSING_ACTION_HEADER" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const result = await restartStudioServices(loadStudioManagerConfig());
    return NextResponse.json(
      { ok: result.accepted },
      { status: result.accepted ? 202 : 502, headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    const error =
      cause instanceof StudioManagerClientError
        ? cause
        : new StudioManagerClientError("INTERNAL_ERROR", "Studio 重启请求失败。", 502);
    return NextResponse.json(
      { ok: false, error: { code: error.code, message: error.message } },
      { status: error.httpStatus, headers: { "Cache-Control": "no-store" } },
    );
  }
}
