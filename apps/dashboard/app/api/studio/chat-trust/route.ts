import { type NextRequest, NextResponse } from "next/server";

import { isSameOriginAction } from "@/lib/same-origin-guard";
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

/**
 * `loadStudioManagerConfig()` 未配置时直接抛 MANAGER_NOT_CONFIGURED（503），
 * 旧代码里的 `if (!config)` 是死分支——真实响应会退化成 500。
 * 统一走这里取值：未配置/配置非法都保持预期的 503。
 */
function loadConfigOrResponse(): { config: ReturnType<typeof loadStudioManagerConfig> } | { response: NextResponse } {
  try {
    return { config: loadStudioManagerConfig() };
  } catch (error) {
    const status = error instanceof StudioManagerClientError ? error.httpStatus : 503;
    return {
      response: NextResponse.json(
        { detail: error instanceof Error ? error.message : "manager not configured" },
        { status },
      ),
    };
  }
}

export async function GET() {
  const loaded = loadConfigOrResponse();
  if ("response" in loaded) return loaded.response;
  const config = loaded.config;
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
  // F-B3：白名单改写是 R4 级写面，守卫与 stop-bot 同一实现（同源 Origin+Host）。
  if (!isSameOriginAction(request, "chat-trust")) {
    return NextResponse.json({ detail: "missing x-studio-action header" }, { status: 403 });
  }
  const loaded = loadConfigOrResponse();
  if ("response" in loaded) return loaded.response;
  const config = loaded.config;
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
