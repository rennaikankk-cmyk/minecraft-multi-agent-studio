import { NextResponse } from "next/server";

import {
  fetchSharedStateView,
  loadSharedStateConfig,
} from "@/lib/shared-state-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await fetchSharedStateView(loadSharedStateConfig());
  if (result.status === "ok") {
    return NextResponse.json(result.view, { headers: { "Cache-Control": "no-store" } });
  }
  if (result.status === "not_configured") {
    return NextResponse.json(
      { status: "not_configured", message: "未配置 STUDIO_SHARED_STATE_URL；Coordinator 共享状态不可读。" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { status: "unreachable", message: `Coordinator 共享状态不可达：${result.detail}` },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
