import { loadStudioManagerConfig } from "@/lib/studio-manager-client";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const incoming = new URL(request.url); const params = new URLSearchParams();
  for (const key of ["from", "to", "botIds"]) { const value = incoming.searchParams.get(key); if (value) params.set(key, value); }
  try {
    const config = loadStudioManagerConfig();
    const response = await fetch(`${config.baseUrl}/v1/diagnostics/export?${params}`, { headers: { Authorization: `Bearer ${config.token}` }, cache: "no-store", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) return NextResponse.json(await response.json().catch(() => ({ status: "export_failed" })), { status: response.status });
    return new NextResponse(response.body, { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": response.headers.get("content-disposition") ?? "attachment; filename=bot-diagnostics.zip", "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ status: "unreachable", message: error instanceof Error ? error.message : "unknown" }, { status: 503 }); }
}
