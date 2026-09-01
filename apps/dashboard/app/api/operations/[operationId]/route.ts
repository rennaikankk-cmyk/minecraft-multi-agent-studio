import { NextResponse } from "next/server";

import { loadStudioManagerConfig, StudioManagerClientError } from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

/** GET /api/operations/:id —— lifecycle 操作最终 observed result 轮询。 */
export async function GET(_request: Request, context: { params: Promise<{ operationId: string }> }) {
  const { operationId } = await context.params;
  if (!/^op-[0-9a-z-]{1,64}$/.test(operationId)) {
    return NextResponse.json({ status: "bad_request" }, { status: 400 });
  }
  try {
    const config = loadStudioManagerConfig();
    const response = await fetch(`${config.baseUrl}/v1/operations/${operationId}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      return NextResponse.json({ status: "not_found" }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!response.ok) {
      return NextResponse.json({ status: "unreachable", message: `HTTP ${response.status}` }, { headers: { "Cache-Control": "no-store" } });
    }
    const body = (await response.json()) as { operation?: unknown };
    return NextResponse.json(
      { status: "ok", operation: body.operation ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    if (cause instanceof StudioManagerClientError && cause.code === "MANAGER_NOT_CONFIGURED") {
      return NextResponse.json({ status: "not_configured", message: "Studio Manager 未配置。" }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ status: "unreachable", message: cause instanceof Error ? cause.message : "unknown" }, { headers: { "Cache-Control": "no-store" } });
  }
}
