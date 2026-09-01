import { loadStudioManagerConfig } from "@/lib/studio-manager-client";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/incidents/export?scope=…&format=… —— 批量导出代理（流式透传）。 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") ?? "";
  const format = url.searchParams.get("format") ?? "json";
  if (!/^[a-z0-9:,-]{1,512}$/iu.test(scope)) {
    return NextResponse.json({ status: "bad_request", message: "invalid scope" }, { status: 400 });
  }
  try {
    const config = loadStudioManagerConfig();
    const response = await fetch(`${config.baseUrl}/v1/incidents/export?scope=${encodeURIComponent(scope)}&format=${encodeURIComponent(format)}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
      return NextResponse.json(
        { status: "export_failed", message: detail.error?.message ?? `HTTP ${response.status}` },
        { status: response.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return new NextResponse(response.body, {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/octet-stream",
        ...(response.headers.get("content-disposition")
          ? { "Content-Disposition": response.headers.get("content-disposition")! }
          : {}),
        "Cache-Control": "no-store",
      },
    });
  } catch (cause) {
    return NextResponse.json(
      { status: "unreachable", message: cause instanceof Error ? cause.message : "unknown" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
