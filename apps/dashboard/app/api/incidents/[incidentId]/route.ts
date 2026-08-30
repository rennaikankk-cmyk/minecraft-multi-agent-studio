import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { loadStudioManagerConfig, StudioManagerClientError } from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await context.params;
  if (!/^INC-[0-9]{4}$/.test(incidentId)) {
    return NextResponse.json({ status: "bad_request" }, { status: 400 });
  }
  try {
    const config = loadStudioManagerConfig();
    const response = await fetch(`${config.baseUrl}/v1/incidents/${incidentId}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) {
      return NextResponse.json({ status: "not_found" }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!response.ok) {
      return NextResponse.json({ status: "unreachable", message: `HTTP ${response.status}` }, { headers: { "Cache-Control": "no-store" } });
    }
    const body = (await response.json()) as { issue?: unknown; occurrences?: unknown[] };
    return NextResponse.json(
      { status: "ok", issue: body.issue ?? null, occurrences: body.occurrences ?? [] },
      { headers: { "Cache-Control": "no-store", "X-Request-Id": randomUUID() } },
    );
  } catch (cause) {
    if (cause instanceof StudioManagerClientError && cause.code === "MANAGER_NOT_CONFIGURED") {
      return NextResponse.json({ status: "not_configured", message: "Studio Manager 未配置。" }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ status: "unreachable", message: cause instanceof Error ? cause.message : "unknown" }, { headers: { "Cache-Control": "no-store" } });
  }
}
