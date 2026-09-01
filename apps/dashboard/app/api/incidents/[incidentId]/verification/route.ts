import { NextResponse } from "next/server";

import { loadStudioManagerConfig } from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

function isSameOriginAction(request: Request, action: string): boolean {
  if (request.headers.get("x-studio-action") !== action) return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host && request.headers.get("sec-fetch-site") === "same-origin";
  } catch {
    return false;
  }
}

/** POST /api/incidents/:id/verification —— 请求验证 / 记录验证结果。 */
export async function POST(request: Request, context: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await context.params;
  if (!/^INC-[0-9]{4,}$/.test(incidentId)) {
    return NextResponse.json({ status: "bad_request" }, { status: 400 });
  }
  if (!isSameOriginAction(request, "incident-verification")) {
    return NextResponse.json({ status: "forbidden", message: "需要 same-origin + X-Studio-Action。" }, { status: 403 });
  }
  let body: { action?: unknown; result?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ status: "bad_request" }, { status: 400 });
  }
  try {
    const config = loadStudioManagerConfig();
    const response = await fetch(`${config.baseUrl}/v1/incidents/${incidentId}/verification`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: body.action, result: body.result }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const detail = await response.json();
    if (!response.ok) {
      return NextResponse.json(
        { status: "rejected", message: detail.error?.message ?? `HTTP ${response.status}` },
        { status: response.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ status: "ok", issue: detail.issue ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return NextResponse.json(
      { status: "unreachable", message: cause instanceof Error ? cause.message : "unknown" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
