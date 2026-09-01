import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { loadStudioManagerConfig, StudioManagerClientError } from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

/** GET /api/servers/local-test/logs —— bounded + redacted 服务器日志。 */
export async function GET(request: Request) {
  const tail = new URL(request.url).searchParams.get("tail") ?? "200";
  try {
    const config = loadStudioManagerConfig();
    const response = await fetch(`${config.baseUrl}/v1/servers/local-test/logs?tail=${encodeURIComponent(tail)}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return NextResponse.json({ status: "unavailable", message: `HTTP ${response.status}` }, { headers: { "Cache-Control": "no-store" } });
    }
    const body = (await response.json()) as { tail?: unknown; logs?: unknown };
    return NextResponse.json(
      { status: "ok", tail: body.tail ?? null, logs: body.logs ?? "" },
      { headers: { "Cache-Control": "no-store", "X-Request-Id": randomUUID() } },
    );
  } catch (cause) {
    if (cause instanceof StudioManagerClientError && cause.code === "MANAGER_NOT_CONFIGURED") {
      return NextResponse.json({ status: "not_configured", message: "Studio Manager 未配置。" }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ status: "unreachable", message: cause instanceof Error ? cause.message : "unknown" }, { headers: { "Cache-Control": "no-store" } });
  }
}
