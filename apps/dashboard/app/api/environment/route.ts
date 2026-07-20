import { randomUUID } from "node:crypto";

import { detectEnvironment } from "@minecraft-studio/environment";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = randomUUID();

  try {
    const environment = await detectEnvironment();
    return NextResponse.json(
      { requestId, environment },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Environment detection failed", {
      requestId,
      error: error instanceof Error ? error.message : "unknown_error",
    });

    return NextResponse.json(
      {
        requestId,
        error: {
          code: "ENVIRONMENT_DETECTION_FAILED",
          message: "无法读取当前设备环境，请查看服务端日志。",
        },
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
