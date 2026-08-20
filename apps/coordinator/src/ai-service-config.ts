import {
  loadAISchedulerConfig,
  type AISchedulerConfig,
} from "@minecraft-studio/ai-router";

export type CoordinatorAIServiceConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      providerName: string;
      baseUrl: string;
      model: string;
      apiKey: string;
      scheduler: AISchedulerConfig;
      maxTokens: number;
      temperature: number;
      timeoutMs: number;
    }>;

export class CoordinatorAIConfigError extends Error {
  readonly code = "COORDINATOR_AI_CONFIG_INVALID";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "CoordinatorAIConfigError";
  }
}

export function loadCoordinatorAIServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): CoordinatorAIServiceConfig {
  const enabled = booleanValue(env.COORDINATOR_AI_ENABLED, false);
  if (!enabled) return Object.freeze({ enabled: false });
  if ((env.AI_PROVIDER ?? "openai-compatible") !== "openai-compatible") {
    throw new CoordinatorAIConfigError("AI_PROVIDER must be openai-compatible.");
  }
  const baseUrl = required(env, "AI_BASE_URL");
  validateBaseUrl(baseUrl);
  const apiKey = required(env, "AI_API_KEY");
  if (apiKey.length < 16) {
    throw new CoordinatorAIConfigError("AI_API_KEY must contain at least 16 characters.");
  }
  let scheduler: AISchedulerConfig;
  try {
    scheduler = loadAISchedulerConfig(env);
  } catch (cause) {
    throw new CoordinatorAIConfigError("AI scheduler configuration is invalid.", { cause });
  }
  return Object.freeze({
    enabled: true,
    providerName: identifier(env.AI_PROVIDER_NAME ?? "spark-vllm", "AI_PROVIDER_NAME"),
    baseUrl,
    model: required(env, "AI_MODEL"),
    apiKey,
    scheduler,
    maxTokens: positiveInteger(env.AI_MAX_TOKENS, 512, "AI_MAX_TOKENS"),
    temperature: numberRange(env.AI_TEMPERATURE, 0.2, 0, 2, "AI_TEMPERATURE"),
    timeoutMs: positiveInteger(env.AI_REQUEST_TIMEOUT_MS, 30_000, "AI_REQUEST_TIMEOUT_MS"),
  });
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CoordinatorAIConfigError("COORDINATOR_AI_ENABLED must be true or false.");
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new CoordinatorAIConfigError(`${name} must be configured.`);
  return value;
}

function identifier(value: string, name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value)) {
    throw new CoordinatorAIConfigError(`${name} must be a bounded identifier.`);
  }
  return value;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CoordinatorAIConfigError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function numberRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new CoordinatorAIConfigError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function validateBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new CoordinatorAIConfigError("AI_BASE_URL must be an absolute URL.", { cause });
  }
  if (!(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:") ||
      url.username || url.password || url.search || url.hash) {
    throw new CoordinatorAIConfigError("AI_BASE_URL contains unsupported URL components.");
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new CoordinatorAIConfigError(
      "Plain HTTP AI_BASE_URL is allowed only for loopback or RFC1918 IPv4 hosts.",
    );
  }
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}
