import { compatibleChatEndpoint, type CloudStructuredOutput } from "@minecraft-studio/ai-router";

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
  /** Cloud-only controlled contract and finite per-request budget. */
  structuredOutput?: CloudStructuredOutput;
  maxOutputTokens?: number;
  maxAttempts?: number;
  apiKeyRef?: string;
}>;

export type LocalAIProvider = "ollama" | "vllm" | "openai-compatible";

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
  const rawUrl = (env.AI_BASE_URL ?? env.LOCAL_AI_HUB_URL)?.trim() ?? "";
  const rawModel = (env.AI_MODEL ?? env.LOCAL_AI_MODEL)?.trim() ?? "";
  const provider = localAIProvider(env.AI_PROVIDER ?? (env.AI_BASE_URL ? "openai-compatible" : env.LOCAL_AI_PROVIDER));
  const cloud = provider === "openai-compatible";
  const apiKeyRef = env.AI_API_KEY_ENV?.trim();
  if (apiKeyRef && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(apiKeyRef)) {
    throw new LocalAIConfigError("LOCAL_AI_CONFIG_INCOMPLETE", "AI_API_KEY_ENV must reference a backend environment variable.");
  }
  // A new external endpoint must not silently reuse a key left behind for a
  // legacy local server. Legacy cloud configs still use their explicit local keys.
  const rawApiKey = (apiKeyRef ? env[apiKeyRef] : env.AI_API_KEY ?? (cloud && env.AI_BASE_URL ? undefined : env.LOCAL_AI_API_KEY))?.trim() ?? "";
  if (rawApiKey.length > 4_096 || /[\r\n]/u.test(rawApiKey)) {
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
  if (cloud && (!rawModel || !rawApiKey)) {
    throw new LocalAIConfigError("LOCAL_AI_CONFIG_INCOMPLETE", "Cloud API requires an explicit model and backend API key; model discovery is not required or attempted.");
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
    (!cloud && !url.port) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!cloud && url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new LocalAIConfigError(
      "LOCAL_AI_URL_INVALID",
      "Local AI URL must be an explicit HTTP(S) origin without credentials or a path.",
    );
  }
  if (cloud) {
    try { compatibleChatEndpoint(rawUrl); } catch {
      throw new LocalAIConfigError("LOCAL_AI_URL_INVALID", "Cloud endpoint requires HTTPS without embedded credentials or query; loopback HTTP is available for controlled tests.");
    }
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
    baseUrl: cloud ? url.href.replace(/\/+$/u, "") : url.origin,
    model: rawModel || null,
    apiKey: rawApiKey || null,
    maxConcurrency,
    maxQueue,
    perBotConcurrency,
    requestTimeoutMs,
    ...(cloud ? {
      structuredOutput: cloudStructuredOutput(env.AI_STRUCTURED_OUTPUT),
      maxOutputTokens: integer(env.AI_MAX_OUTPUT_TOKENS, 4096, 1, 131072),
      maxAttempts: integer(env.AI_MAX_ATTEMPTS, 2, 1, 5),
      ...(apiKeyRef ? { apiKeyRef } : {}),
    } : {}),
  };
}

function localAIProvider(raw: string | undefined): LocalAIProvider {
  const provider = raw?.trim().toLowerCase() || "vllm";
  if (provider === "ollama" || provider === "vllm") return provider;
  if (["openai-compatible", "openai", "cloud"].includes(provider)) return "openai-compatible";
  throw new LocalAIConfigError(
    "LOCAL_AI_PROVIDER_INVALID",
    "AI provider must be openai-compatible, ollama or vllm.",
  );
}

function cloudStructuredOutput(raw: string | undefined): CloudStructuredOutput {
  const mode = raw?.trim() || "none";
  if (mode === "none" || mode === "json_object" || mode === "json_schema" || mode === "tool") return mode;
  throw new LocalAIConfigError("LOCAL_AI_CONFIG_INCOMPLETE", "AI_STRUCTURED_OUTPUT must match a supported provider contract.");
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
