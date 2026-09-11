import { type NextRequest, NextResponse } from "next/server";

import { isSameOriginAction } from "@/lib/same-origin-guard";
import {
  loadStudioManagerConfig,
  restartStudioServices,
  StudioManagerClientError,
} from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // 写面统一同源守卫（F-B3：与 stop-bot / goals 同一实现，不再是「只查自定义头」）。
  if (!isSameOriginAction(request, "studio-restart")) {
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
