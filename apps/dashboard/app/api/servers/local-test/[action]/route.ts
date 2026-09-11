import { NextResponse } from "next/server";

import { isSameOriginAction } from "@/lib/same-origin-guard";
import { loadStudioManagerConfig } from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(["start", "stop", "restart", "reset"]);

/** POST /api/servers/local-test/:action —— lifecycle 操作（返回 operationId，非乐观成功）。 */
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ status: "bad_request", message: "action 必须是 start|stop|restart|reset" }, { status: 400 });
  }
  // 严格调用点：保持原有「Sec-Fetch-Site 必须显式 same-origin」强度。
  if (!isSameOriginAction(request, `local-test-${action}`, { requireFetchSite: true })) {
    return NextResponse.json({ status: "forbidden", message: "需要 same-origin + X-Studio-Action。" }, { status: 403 });
  }
  let body: { confirmWorldIdentity?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  try {
    const config = loadStudioManagerConfig();
    const response = await fetch(`${config.baseUrl}/v1/servers/local-test/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const detail = await response.json();
    if (!response.ok) {
      return NextResponse.json(
        { status: "rejected", message: detail.error?.message ?? `HTTP ${response.status}` },
        { status: response.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ status: "ok", operationId: detail.operationId ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return NextResponse.json(
      { status: "unreachable", message: cause instanceof Error ? cause.message : "unknown" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
