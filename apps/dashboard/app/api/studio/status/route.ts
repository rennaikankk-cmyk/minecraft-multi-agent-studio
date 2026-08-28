import {
  studioManagerErrorV1Schema,
  studioManagerStatusV1Schema,
} from "@minecraft-studio/protocol";
import { NextResponse } from "next/server";

import {
  fetchStudioManagerStatus,
  loadStudioManagerConfig,
  StudioManagerClientError,
} from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await fetchStudioManagerStatus(loadStudioManagerConfig());
    return NextResponse.json(studioManagerStatusV1Schema.parse(status), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (cause) {
    return managerErrorResponse(cause);
  }
}

function managerErrorResponse(cause: unknown) {
  const error =
    cause instanceof StudioManagerClientError
      ? cause
      : new StudioManagerClientError(
          "INTERNAL_ERROR",
          "Studio Manager 状态无法读取。",
          502,
        );
  return NextResponse.json(
    studioManagerErrorV1Schema.parse({
      schemaVersion: "1.0",
      error: { code: error.code, message: error.message },
    }),
    { status: error.httpStatus, headers: { "Cache-Control": "no-store" } },
  );
}
