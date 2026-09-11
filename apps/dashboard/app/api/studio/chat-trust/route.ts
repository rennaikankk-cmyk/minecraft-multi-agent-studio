import { type NextRequest, NextResponse } from "next/server";

import {
  loadStudioManagerConfig,
  StudioManagerClientError,
} from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

function managerUrl(config: ReturnType<typeof loadStudioManagerConfig>): string {
  return `${config.baseUrl}/v1/chat-trust`;
}

function authHeaders(config: ReturnType<typeof loadStudioManagerConfig>): Record<string, string> {
  return { Authorization: `Bearer ${config.token}` };
}

export async function GET() {
  const config = loadStudioManagerConfig();
  if (!config) {
    return NextResponse.json({ detail: "manager not configured" }, { status: 503 });
  }
  try {
    const response = await fetch(managerUrl(config), {
      headers: authHeaders(config),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(
        { detail: (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${response.status}` },
        { status: 502 },
      );
    }
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "manager unreachable" },
      { status: 502 },
    );
  }
}

export async function PUT(request: NextRequest) {
  // 写面守卫：与 stop-bot / skill-release 同纪律。
  if (request.headers.get("x-studio-action") !== "chat-trust") {
    return NextResponse.json({ detail: "missing x-studio-action header" }, { status: 403 });
  }
  const config = loadStudioManagerConfig();
  if (!config) {
    return NextResponse.json({ detail: "manager not configured" }, { status: 503 });
  }
  const body = await request.json().catch(() => null);
  if (body === null || !Array.isArray(body)) {
    return NextResponse.json({ detail: "policies must be an array" }, { status: 400 });
  }
  if (JSON.stringify(body).length > 256 * 1024) {
    return NextResponse.json({ detail: "payload too large" }, { status: 413 });
  }
  try {
    const response = await fetch(managerUrl(config), {
      method: "PUT",
      headers: { ...authHeaders(config), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const parsed = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(
        { detail: (parsed as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${response.status}` },
        { status: response.status === 400 ? 400 : 502 },
      );
    }
    return NextResponse.json(parsed, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof StudioManagerClientError) {
      return NextResponse.json({ detail: error.message }, { status: 502 });
    }
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "manager unreachable" },
      { status: 502 },
    );
  }
}
