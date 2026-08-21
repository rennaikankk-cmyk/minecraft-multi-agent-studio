export type LocalAIConfig = Readonly<{
  enabled: boolean;
  provider: LocalAIProvider;
  baseUrl: string | null;
  model: string | null;
  maxConcurrency: number;
  maxQueue: number;
  perBotConcurrency: number;
  requestTimeoutMs: number;
}>;

export type LocalAIProvider = "ollama" | "vllm";

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
  const provider = localAIProvider(env.LOCAL_AI_PROVIDER);
  if (!rawUrl && !rawModel) {
    return {
      enabled: false,
      provider,
      baseUrl: null,
      model: null,
      maxConcurrency: 4,
      maxQueue: 64,
      perBotConcurrency: 1,
      requestTimeoutMs: 30_000,
    };
  }
  if (!rawUrl || !rawModel) {
    throw new LocalAIConfigError(
      "LOCAL_AI_CONFIG_INCOMPLETE",
      "LOCAL_AI_HUB_URL and LOCAL_AI_MODEL must be configured together.",
    );
  }

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
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u.test(rawModel)) {
    throw new LocalAIConfigError(
      "LOCAL_AI_MODEL_INVALID",
      "Local AI model identifier is invalid.",
    );
  }

  const maxConcurrency = integer(env.AI_MAX_CONCURRENCY, 4, 1, 64);
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
    model: rawModel,
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
