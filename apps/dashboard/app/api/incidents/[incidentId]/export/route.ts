import { loadStudioManagerConfig } from "@/lib/studio-manager-client";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/incidents/:id/export?format=json|markdown|zip|repair-prompt —— 单 Incident 导出代理。 */
export async function GET(request: Request, context: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await context.params;
  if (!/^INC-[0-9]{4,}$/.test(incidentId)) {
    return NextResponse.json({ status: "bad_request" }, { status: 400 });
  }
  const format = new URL(request.url).searchParams.get("format") ?? "json";
  if (!["json", "markdown", "zip", "repair-prompt"].includes(format)) {
    return NextResponse.json({ status: "bad_request" }, { status: 400 });
  }
  try {
    const config = loadStudioManagerConfig();
    const response = await fetch(`${config.baseUrl}/v1/incidents/${incidentId}/export?format=${format}`, {
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
