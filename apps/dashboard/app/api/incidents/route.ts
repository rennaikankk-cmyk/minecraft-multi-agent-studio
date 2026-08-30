import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  loadStudioManagerConfig,
  StudioManagerClientError,
} from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

/** GET /api/incidents —— 代理 Studio Manager 的 Incident 列表（token 只在服务端）。 */
export async function GET() {
  try {
    const config = loadStudioManagerConfig();
    const response = await fetch(`${config.baseUrl}/v1/incidents`, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return NextResponse.json(
        { status: "unreachable", message: `Studio Manager HTTP ${response.status}` },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const body = (await response.json()) as { issues?: unknown[] };
    return NextResponse.json(
      { status: "ok", issues: body.issues ?? [] },
      { headers: { "Cache-Control": "no-store", "X-Request-Id": randomUUID() } },
    );
  } catch (cause) {
    if (cause instanceof StudioManagerClientError && cause.code === "MANAGER_NOT_CONFIGURED") {
      return NextResponse.json(
        { status: "not_configured", message: "Studio Manager 未配置。" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { status: "unreachable", message: cause instanceof Error ? cause.message : "unknown" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

