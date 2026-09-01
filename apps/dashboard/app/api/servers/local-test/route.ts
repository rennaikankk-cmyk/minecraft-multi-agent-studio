import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { loadStudioManagerConfig, StudioManagerClientError } from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

/** GET /api/servers/local-test —— Local Test Server observed state（docker 事实）。 */
export async function GET() {
  try {
    const config = loadStudioManagerConfig();
    const response = await fetch(`${config.baseUrl}/v1/servers/local-test`, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return NextResponse.json({ status: "unreachable", message: `HTTP ${response.status}` }, { headers: { "Cache-Control": "no-store" } });
    }
    const body = (await response.json()) as { resource?: unknown };
    return NextResponse.json(
      { status: "ok", resource: body.resource ?? null },
      { headers: { "Cache-Control": "no-store", "X-Request-Id": randomUUID() } },
    );
  } catch (cause) {
    if (cause instanceof StudioManagerClientError && cause.code === "MANAGER_NOT_CONFIGURED") {
      return NextResponse.json({ status: "not_configured", message: "Studio Manager 未配置。" }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ status: "unreachable", message: cause instanceof Error ? cause.message : "unknown" }, { headers: { "Cache-Control": "no-store" } });
  }
}
