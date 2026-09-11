import { type NextRequest, NextResponse } from "next/server";

import { isSameOriginAction } from "@/lib/same-origin-guard";
import {
  fetchLessons,
  loadSharedStateConfig,
  requestLessonReview,
} from "@/lib/shared-state-client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const serverProfileId = new URL(request.url).searchParams.get("serverProfileId") ?? "";
  if (serverProfileId.length === 0) {
    return NextResponse.json(
      { status: "unreachable", detail: "serverProfileId required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const result = await fetchLessons(loadSharedStateConfig(), serverProfileId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  // 复盘触发是写面（F-B3：同源 Origin+Host，不再是「只查自定义头」）。
  if (!isSameOriginAction(request, "lesson-review")) {
    return NextResponse.json(
      { status: "rejected", detail: "missing x-studio-action header" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const body = await request.json().catch(() => null) as { serverProfileId?: string } | null;
  if (typeof body?.serverProfileId !== "string" || body.serverProfileId.length === 0) {
    return NextResponse.json(
      { status: "rejected", detail: "serverProfileId required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const result = await requestLessonReview(loadSharedStateConfig(), body.serverProfileId);
  return NextResponse.json(result, {
    status: result.status === "ok" ? 202 : result.status === "rejected" ? 409 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
