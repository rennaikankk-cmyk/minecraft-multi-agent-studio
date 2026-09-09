import { studioManagerErrorV1Schema } from "@minecraft-studio/protocol";
import { type NextRequest, NextResponse } from "next/server";

import {
  deleteAiProvider,
  fetchAiProviders,
  loadStudioManagerConfig,
  saveAiProvider,
  StudioManagerClientError,
  type AiProviderSaveInput,
  type AiProviderType,
} from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_192;
const AI_PROVIDER_TYPES: readonly string[] = ["local-vllm", "local-ollama", "openai-compatible"];

export async function GET() {
  try {
    const list = await fetchAiProviders(loadStudioManagerConfig());
    return NextResponse.json(list, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return clientErrorResponse(cause, "AI provider 档案无法读取。");
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginAction(request, "ai-provider-save")) {
    return errorResponse("INVALID_REQUEST", "AI provider 只能从本机控制台保存。", 403);
  }
  const input = await parseBody(request);
  if (!isValidSaveInput(input)) {
    return errorResponse("INVALID_REQUEST", "AI provider 字段无效。", 400);
  }
  try {
    const saved = await saveAiProvider(loadStudioManagerConfig(), input);
    return NextResponse.json(saved, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return clientErrorResponse(cause, "AI provider 无法保存。");
  }
}

export async function DELETE(request: NextRequest) {
  if (!isSameOriginAction(request, "ai-provider-delete")) {
    return errorResponse("INVALID_REQUEST", "AI provider 只能从本机控制台删除。", 403);
  }
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^aip-[0-9a-f]{4,32}$/u.test(id)) {
    return errorResponse("INVALID_REQUEST", "AI provider 档案 ID 无效。", 400);
  }
  try {
    await deleteAiProvider(loadStudioManagerConfig(), id);
    return NextResponse.json(
      { schemaVersion: "1.0", deleted: id },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    return clientErrorResponse(cause, "AI provider 无法删除。");
  }
}

async function parseBody(request: NextRequest): Promise<AiProviderSaveInput | null> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return null;
  }
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return null;
    return JSON.parse(body) as AiProviderSaveInput;
  } catch {
    return null;
  }
}

function isValidSaveInput(input: AiProviderSaveInput | null): input is AiProviderSaveInput {
  if (!input || typeof input !== "object") return false;
  if (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.length > 64) return false;
  if (!AI_PROVIDER_TYPES.includes(input.type)) return false;
  if (typeof input.baseUrl !== "string" || input.baseUrl.length > 2_048) return false;
  if (typeof input.model !== "string" || input.model.length > 256) return false;
  if (input.apiKey !== undefined && (typeof input.apiKey !== "string" || input.apiKey.length > 4_096)) return false;
  if (
    input.structuredOutput !== undefined &&
    !["none", "json_object", "json_schema", "tool"].includes(input.structuredOutput)
  ) {
    return false;
  }
  return true;
}

function isSameOriginAction(request: NextRequest, action: string): boolean {
  if (request.headers.get("x-studio-action") !== action) return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || !host || (fetchSite !== null && fetchSite !== "same-origin")) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function clientErrorResponse(cause: unknown, fallback: string) {
  const error =
    cause instanceof StudioManagerClientError
      ? cause
      : new StudioManagerClientError("INTERNAL_ERROR", fallback, 502);
  return errorResponse(error.code, error.message, error.httpStatus);
}

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    studioManagerErrorV1Schema.parse({
      schemaVersion: "1.0",
      error: { code: code as never, message },
    }),
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
