import { NextResponse } from "next/server";

import {
  fetchGapConsole,
  loadSharedStateConfig,
} from "@/lib/shared-state-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await fetchGapConsole(loadSharedStateConfig());
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
