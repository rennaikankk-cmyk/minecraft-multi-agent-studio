import { type NextRequest, NextResponse } from "next/server";

import {
  createReleaseDraft,
  loadSharedStateConfig,
  releaseOperatorDecision,
} from "@/lib/shared-state-client";

export const dynamic = "force-dynamic";

/** 写操作统一 X-Studio-Action 守卫（与 stop-bot 同纪律）。 */
function isReleaseAction(request: NextRequest): boolean {
  return request.headers.get("x-studio-action") === "skill-release";
}

export async function POST(request: NextRequest) {
  if (!isReleaseAction(request)) {
    return NextResponse.json(
      { status: "rejected", detail: "missing x-studio-action header" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const body = await request.json().catch(() => null) as {
    action?: string;
    gapFingerprint?: string;
    releaseId?: string;
    decision?: "promote-canary" | "promote-active" | "revoke";
    operator?: string;
    note?: string;
  } | null;
  const config = loadSharedStateConfig();
  if (body?.action === "create-draft" && typeof body.gapFingerprint === "string") {
    const result = await createReleaseDraft(config, body.gapFingerprint);
    return NextResponse.json(result, {
      status: result.status === "ok" ? 200 : result.status === "rejected" ? 409 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (
    body?.action === "operator-decision" &&
    typeof body.releaseId === "string" &&
    (body.decision === "promote-canary" || body.decision === "promote-active" || body.decision === "revoke") &&
    typeof body.operator === "string" && body.operator.trim().length > 0
  ) {
    const result = await releaseOperatorDecision(config, {
      releaseId: body.releaseId,
      decision: body.decision,
      operator: body.operator.trim(),
      ...(typeof body.note === "string" && body.note.length > 0 ? { note: body.note } : {}),
    });
    return NextResponse.json(result, {
      status: result.status === "ok" ? 200 : result.status === "rejected" ? 409 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return NextResponse.json(
    { status: "rejected", detail: "invalid_request" },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
