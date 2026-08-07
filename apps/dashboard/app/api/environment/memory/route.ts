import { randomUUID } from "node:crypto";

import { captureMemorySample } from "@minecraft-studio/environment";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const requestId = randomUUID();

  try {
    const sample = captureMemorySample();
    return NextResponse.json(
      { requestId, sample },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    console.error("Environment memory capture failed", {
      requestId,
      code: "ENVIRONMENT_MEMORY_CAPTURE_FAILED",
    });
    return NextResponse.json(
      {
        requestId,
        error: {
          code: "ENVIRONMENT_MEMORY_CAPTURE_FAILED",
          message: "无法读取当前设备内存状态。",
        },
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
