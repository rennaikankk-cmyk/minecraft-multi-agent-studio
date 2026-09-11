import {
  studioCreateBotRequestV1Schema,
  studioManagedBotResponseV1Schema,
  studioManagerErrorV1Schema,
  studioManagerStatusV1Schema,
  type StudioCreateBotRequestV1,
  type StudioManagedBotResponseV1,
  type StudioManagerErrorCode,
  type StudioManagerStatusV1,
} from "@minecraft-studio/protocol";

const TOKEN_PATTERN = /^[^\u0000-\u001f\u007f]{32,512}$/u;
const MANAGED_BOT_ID_PATTERN = /^(?:[A-Za-z0-9_]{3,16}|studio-bot-[0-9]{2})$/u;

export type StudioManagerConfig = Readonly<{
  baseUrl: string;
  token: string;
}>;

export class StudioManagerClientError extends Error {
  constructor(
    readonly code: StudioManagerErrorCode,
    message: string,
    readonly httpStatus = defaultStatus(code),
  ) {
    super(message);
    this.name = "StudioManagerClientError";
  }
}

export function loadStudioManagerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): StudioManagerConfig {
  const rawUrl = environment.DASHBOARD_STUDIO_MANAGER_URL?.trim() ?? "";
  const token = environment.DASHBOARD_STUDIO_MANAGER_TOKEN ?? "";
  if (!rawUrl || !TOKEN_PATTERN.test(token)) {
    throw new StudioManagerClientError(
      "MANAGER_NOT_CONFIGURED",
      "本地 Studio Manager 尚未配置。",
      503,
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalidManagerConfig();
  }
  if (
    url.protocol !== "http:" ||
    !isLoopbackHost(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw invalidManagerConfig();
  }
  return { baseUrl: url.origin, token };
}

export async function fetchStudioManagerStatus(
  config: StudioManagerConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<StudioManagerStatusV1> {
  const value = await requestJson(
    config,
    "/v1/status",
    { method: "GET" },
    fetchImplementation,
  );
  const parsed = studioManagerStatusV1Schema.safeParse(value);
  if (!parsed.success) throw invalidManagerResponse();
  return parsed.data;
}

export async function createStudioManagedBot(
  config: StudioManagerConfig,
  input: StudioCreateBotRequestV1,
  fetchImplementation: typeof fetch = fetch,
): Promise<StudioManagedBotResponseV1> {
  const request = studioCreateBotRequestV1Schema.parse(input);
  const value = await requestJson(
    config,
    "/v1/bots",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(request.auth === "online" ? 35_000 : 5_000),
    },
    fetchImplementation,
  );
  const parsed = studioManagedBotResponseV1Schema.safeParse(value);
  if (!parsed.success) throw invalidManagerResponse();
  return parsed.data;
}

export async function stopStudioManagedBot(
  config: StudioManagerConfig,
  botId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<StudioManagedBotResponseV1> {
  if (!MANAGED_BOT_ID_PATTERN.test(botId)) {
    throw new StudioManagerClientError(
      "INVALID_REQUEST",
      "本地 Bot 标识无效。",
      400,
    );
  }
  const value = await requestJson(
    config,
    `/v1/bots/${encodeURIComponent(botId)}/stop`,
    { method: "POST" },
    fetchImplementation,
  );
  const parsed = studioManagedBotResponseV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.bot.botId !== botId) {
    throw invalidManagerResponse();
  }
  return parsed.data;
}

export async function deleteStudioManagedBot(
  config: StudioManagerConfig,
  botId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  if (!MANAGED_BOT_ID_PATTERN.test(botId)) {
    throw new StudioManagerClientError(
      "INVALID_REQUEST",
      "本地 Bot 标识无效。",
      400,
    );
  }
  await requestJson(
    config,
    `/v1/bots/${encodeURIComponent(botId)}`,
    { method: "DELETE", signal: AbortSignal.timeout(5_000) },
    fetchImplementation,
  );
}

export async function restartStudioManagedBot(
  config: StudioManagerConfig,
  botId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<StudioManagedBotResponseV1> {
  if (!MANAGED_BOT_ID_PATTERN.test(botId)) {
    throw new StudioManagerClientError(
      "INVALID_REQUEST",
      "本地 Bot 标识无效。",
      400,
    );
  }
  const value = await requestJson(
    config,
    `/v1/bots/${encodeURIComponent(botId)}/restart`,
    { method: "POST" },
    fetchImplementation,
  );
  const parsed = studioManagedBotResponseV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.bot.botId !== botId) {
    throw invalidManagerResponse();
  }
  return parsed.data;
}

async function requestJson(
  config: StudioManagerConfig,
  pathname: string,
  init: RequestInit,
  fetchImplementation: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(`${config.baseUrl}${pathname}`, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(5_000),
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...init.headers,
      },
    });
  } catch {
    throw new StudioManagerClientError(
      "MANAGER_UNAVAILABLE",
      "无法连接本机 Studio Manager。",
      503,
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw invalidManagerResponse();
  }
  if (!response.ok) {
    const parsed = studioManagerErrorV1Schema.safeParse(value);
    if (!parsed.success) throw invalidManagerResponse();
    throw new StudioManagerClientError(
      parsed.data.error.code,
      publicManagerMessage(parsed.data.error.code),
      normalizeStatus(response.status),
    );
  }
  return value;
}

function publicManagerMessage(code: StudioManagerErrorCode): string {
  switch (code) {
    case "BOT_LIMIT_REACHED":
      return "本地 Bot 槽位已用完。";
    case "BOT_CONFLICT":
      return "同一服务器上已经配置了同名 Bot。";
    case "BOT_NOT_FOUND":
      return "未找到该本地 Bot。";
    case "BOT_START_FAILED":
      return "Bot 配置已保存，但 Runtime 启动失败。";
    case "INVALID_REQUEST":
      return "本地 Bot 请求字段无效。";
    case "NOT_FOUND":
      return "目标资源不存在。";
    case "AUTH_REQUIRED":
      return "管理连接或正版账号身份验证失败，请检查本机认证配置。";
    default:
      return "Studio Manager 无法完成请求。";
  }
}

function invalidManagerConfig(): StudioManagerClientError {
  return new StudioManagerClientError(
    "MANAGER_NOT_CONFIGURED",
    "Studio Manager 必须配置为显式回环 HTTP 地址。",
    503,
  );
}

function invalidManagerResponse(): StudioManagerClientError {
  return new StudioManagerClientError(
    "INTERNAL_ERROR",
    "Studio Manager 返回了无法识别的数据。",
    502,
  );
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function normalizeStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 502;
}

function defaultStatus(code: StudioManagerErrorCode): number {
  if (code === "INVALID_REQUEST") return 400;
  if (code === "BOT_NOT_FOUND") return 404;
  if (code === "BOT_CONFLICT" || code === "BOT_LIMIT_REACHED") return 409;
  if (code === "MANAGER_NOT_CONFIGURED" || code === "MANAGER_UNAVAILABLE") {
    return 503;
  }
  return 502;
}

/* ---------------------------------------------------------------------------
 * AI provider profiles（模型与 API）：本地推理 / OpenAI 兼容云端 / 中转站。
 * 密钥只存 manager 侧文件；本客户端永远不回传密钥明文（hasApiKey 布尔）。
 * ------------------------------------------------------------------------- */

const AI_PROVIDER_ID_PATTERN = /^aip-[0-9a-f]{4,32}$/u;

export type AiProviderType =
  | "local-vllm"
  | "local-ollama"
  | "openai-compatible";

export type AiProviderProfile = Readonly<{
  id: string;
  name: string;
  type: AiProviderType;
  baseUrl: string;
  model: string | null;
  hasApiKey: boolean;
  structuredOutput: string;
  createdAt: string | null;
  updatedAt: string | null;
}>;

export type AiProviderList = Readonly<{
  schemaVersion: string;
  activeProfileId: string | null;
  profiles: readonly AiProviderProfile[];
}>;

export type AiProviderSaveInput = Readonly<{
  id?: string;
  name: string;
  type: AiProviderType;
  baseUrl: string;
  model: string;
  apiKey?: string;
  structuredOutput?: string;
}>;

function parseAiProviderList(value: unknown): AiProviderList {
  if (!value || typeof value !== "object") throw invalidManagerResponse();
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.profiles)) throw invalidManagerResponse();
  return {
    schemaVersion: "1.0",
    activeProfileId:
      typeof input.activeProfileId === "string" ? input.activeProfileId : null,
    profiles: input.profiles.map((raw) => {
      if (!raw || typeof raw !== "object") throw invalidManagerResponse();
      const profile = raw as Record<string, unknown>;
      return {
        id: String(profile.id ?? ""),
        name: String(profile.name ?? ""),
        type: String(profile.type ?? "") as AiProviderType,
        baseUrl: String(profile.baseUrl ?? ""),
        model: profile.model === null || profile.model === undefined ? null : String(profile.model),
        hasApiKey: Boolean(profile.hasApiKey),
        structuredOutput: String(profile.structuredOutput ?? "none"),
        createdAt: profile.createdAt === null || profile.createdAt === undefined ? null : String(profile.createdAt),
        updatedAt: profile.updatedAt === null || profile.updatedAt === undefined ? null : String(profile.updatedAt),
      };
    }),
  };
}

export async function fetchAiProviders(
  config: StudioManagerConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<AiProviderList> {
  const value = await requestJson(
    config,
    "/v1/ai/providers",
    { method: "GET" },
    fetchImplementation,
  );
  return parseAiProviderList(value);
}

export async function saveAiProvider(
  config: StudioManagerConfig,
  input: AiProviderSaveInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<AiProviderProfile> {
  if (input.id !== undefined && !AI_PROVIDER_ID_PATTERN.test(input.id)) {
    throw new StudioManagerClientError("INVALID_REQUEST", "AI provider 档案 ID 无效。", 400);
  }
  const value = await requestJson(
    config,
    "/v1/ai/providers",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5_000),
    },
    fetchImplementation,
  );
  const [saved] = parseAiProviderList({ profiles: [value] }).profiles;
  if (!saved) throw invalidManagerResponse();
  return saved;
}

export async function activateAiProvider(
  config: StudioManagerConfig,
  profileId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<{ restartRequired: boolean }> {
  if (!AI_PROVIDER_ID_PATTERN.test(profileId)) {
    throw new StudioManagerClientError("INVALID_REQUEST", "AI provider 档案 ID 无效。", 400);
  }
  const value = await requestJson(
    config,
    `/v1/ai/providers/${profileId}/activate`,
    {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    },
    fetchImplementation,
  );
  if (!value || typeof value !== "object") throw invalidManagerResponse();
  return { restartRequired: Boolean((value as Record<string, unknown>).restartRequired) };
}

export async function deleteAiProvider(
  config: StudioManagerConfig,
  profileId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  if (!AI_PROVIDER_ID_PATTERN.test(profileId)) {
    throw new StudioManagerClientError("INVALID_REQUEST", "AI provider 档案 ID 无效。", 400);
  }
  await requestJson(
    config,
    `/v1/ai/providers/${profileId}`,
    { method: "DELETE", signal: AbortSignal.timeout(5_000) },
    fetchImplementation,
  );
}

/** 整组重启 Studio 服务（start-studio 注入的回调；202=已受理）。 */
export async function restartStudioServices(
  config: StudioManagerConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<{ accepted: boolean }> {
  const value = await requestJson(
    config,
    "/v1/studio/restart",
    { method: "POST" },
    fetchImplementation,
  );
  const restart = (value as { restart?: { status?: string } } | null)?.restart;
  return { accepted: restart?.status === "accepted" };
}
