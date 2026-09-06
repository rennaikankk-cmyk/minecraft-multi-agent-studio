export type LocalAIConfig = Readonly<{
  enabled: boolean;
  provider: LocalAIProvider;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  maxConcurrency: number;
  maxQueue: number;
  perBotConcurrency: number;
  requestTimeoutMs: number;
}>;

export type LocalAIProvider = "ollama" | "vllm";

/**
 * 保守默认不是运行值或混合业务 SLO。当前模型的 1/2/3/4 短测与聊天期限
 * 失败见 docs/spark-strategy-v1/TAKEOVER_RESULTS_2026-09-06.md。
 * 实际值仍由 AI_MAX_CONCURRENCY 和启动装配决定，不能从 Bot 数推导。
 */
export const DEFAULT_MAX_CONCURRENCY = 2;
export const CONSERVATIVE_DEFAULT_NOTE = "conservative-default: concurrency=2; actual configuration and shared-load latency require separate verification";

export type LocalAIConfigErrorCode =
  | "LOCAL_AI_CONFIG_INCOMPLETE"
  | "LOCAL_AI_URL_INVALID"
  | "LOCAL_AI_MODEL_INVALID"
  | "LOCAL_AI_PROVIDER_INVALID"
  | "LOCAL_AI_LIMIT_INVALID";

export class LocalAIConfigError extends Error {
  constructor(readonly code: LocalAIConfigErrorCode, message: string) {
    super(message);
    this.name = "LocalAIConfigError";
  }
}

export function loadLocalAIConfig(
  env: NodeJS.ProcessEnv = process.env,
): LocalAIConfig {
  const rawUrl = env.LOCAL_AI_HUB_URL?.trim() ?? "";
  const rawModel = env.LOCAL_AI_MODEL?.trim() ?? "";
  const rawApiKey = env.LOCAL_AI_API_KEY?.trim() ?? "";
  const provider = localAIProvider(env.LOCAL_AI_PROVIDER);
  if (rawApiKey.length > 4_096) {
    throw new LocalAIConfigError(
      "LOCAL_AI_LIMIT_INVALID",
      "Local AI API key is too long.",
    );
  }
  if (!rawUrl && !rawModel) {
    return {
      enabled: false,
      provider,
      baseUrl: null,
      model: null,
      apiKey: null,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      maxQueue: 64,
      perBotConcurrency: 1,
      requestTimeoutMs: 30_000,
    };
  }
  if (!rawUrl) {
    throw new LocalAIConfigError(
      "LOCAL_AI_CONFIG_INCOMPLETE",
      "LOCAL_AI_MODEL is configured without LOCAL_AI_HUB_URL; both must be present.",
    );
  }
  // URL-only 是合法配置：模型在启动时经 /v1/models 发现并按统一规则选择
  // （恰好一个 → 自动；多个 → fail closed 需显式配置；见 resolveModel）。

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LocalAIConfigError("LOCAL_AI_URL_INVALID", "Local AI URL is invalid.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new LocalAIConfigError(
      "LOCAL_AI_URL_INVALID",
      "Local AI URL must be an explicit HTTP(S) origin without credentials or a path.",
    );
  }
  if (rawModel && !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u.test(rawModel)) {
    throw new LocalAIConfigError(
      "LOCAL_AI_MODEL_INVALID",
      "Local AI model identifier is invalid.",
    );
  }

  const maxConcurrency = integer(env.AI_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY, 1, 64);
  const maxQueue = integer(env.AI_MAX_QUEUE, 64, 1, 10_000);
  const perBotConcurrency = integer(
    env.AI_PER_BOT_CONCURRENCY,
    1,
    1,
    maxConcurrency,
  );
  const requestTimeoutMs = integer(
    env.AI_REQUEST_TIMEOUT_MS,
    30_000,
    10,
    10 * 60_000,
  );
  return {
    enabled: true,
    provider,
    baseUrl: url.origin,
    model: rawModel || null,
    apiKey: rawApiKey || null,
    maxConcurrency,
    maxQueue,
    perBotConcurrency,
    requestTimeoutMs,
  };
}

function localAIProvider(raw: string | undefined): LocalAIProvider {
  const provider = raw?.trim().toLowerCase() || "vllm";
  if (provider === "ollama" || provider === "vllm") return provider;
  throw new LocalAIConfigError(
    "LOCAL_AI_PROVIDER_INVALID",
    "Local AI provider must be ollama or vllm.",
  );
}

function integer(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LocalAIConfigError(
      "LOCAL_AI_LIMIT_INVALID",
      "Local AI scheduler limit is outside the allowed range.",
    );
  }
  return value;
}
