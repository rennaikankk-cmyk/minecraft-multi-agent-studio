import type { ControlApiPermission } from "@minecraft-studio/protocol";

import type { ApiPrincipalConfig } from "./auth.js";

const PERMISSIONS = new Set<ControlApiPermission>([
  "bot.read",
  "bot.position.read",
  "bot.stop",
  "task.execute",
  "ai.metrics.read",
]);

export type SparkMetricsRuntimeConfig = Readonly<{
  baseUrl: string;
  nodeName: string;
  backend: "vllm" | "openai-compatible";
  quantization?: string;
  apiKey?: string;
  timeoutMs: number;
  maxConcurrency?: number;
}>;

export type ControlApiRuntimeConfig = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
  principals: ApiPrincipalConfig[];
  requestLimitPerMinute: number;
  handshakeLimitPerMinute: number;
  maxConnectionsPerSubject: number;
  sparkMetrics: SparkMetricsRuntimeConfig | null;
}>;

export class ControlApiConfigError extends Error {
  readonly code = "CONTROL_API_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ControlApiConfigError";
  }
}

export function loadControlApiConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ControlApiRuntimeConfig {
  const host = environment.CONTROL_API_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new ControlApiConfigError(
      "Control API only permits an explicit loopback bind in this phase.",
    );
  }

  const authJson = environment.CONTROL_API_AUTH_JSON;
  if (!authJson) {
    throw new ControlApiConfigError("CONTROL_API_AUTH_JSON is required.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    throw new ControlApiConfigError("CONTROL_API_AUTH_JSON is not valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new ControlApiConfigError("CONTROL_API_AUTH_JSON must be an array.");
  }
  if (parsed.length === 0 || parsed.length > 1_000) {
    throw new ControlApiConfigError(
      "CONTROL_API_AUTH_JSON must contain between 1 and 1000 principals.",
    );
  }

  const principals = parsed.map((value) => parsePrincipal(value));
  const sparkMetrics = parseSparkMetricsConfig(environment);
  return {
    host,
    port: integerEnvironment(environment.CONTROL_API_PORT, 3210, 1, 65_535),
    principals,
    requestLimitPerMinute: integerEnvironment(
      environment.CONTROL_API_REQUESTS_PER_MINUTE,
      120,
      1,
      10_000,
    ),
    handshakeLimitPerMinute: integerEnvironment(
      environment.CONTROL_API_HANDSHAKES_PER_MINUTE,
      30,
      1,
      1_000,
    ),
    maxConnectionsPerSubject: integerEnvironment(
      environment.CONTROL_API_MAX_CONNECTIONS,
      5,
      1,
      100,
    ),
    sparkMetrics,
  };
}

function parseSparkMetricsConfig(
  environment: NodeJS.ProcessEnv,
): SparkMetricsRuntimeConfig | null {
  const rawUrl = environment.SPARK_AI_BASE_URL;
  if (rawUrl === undefined || rawUrl === "") return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ControlApiConfigError("SPARK_AI_BASE_URL is invalid.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "/v1" && url.pathname !== "/v1/")
  ) {
    throw new ControlApiConfigError("SPARK_AI_BASE_URL must be an HTTP(S) origin or its /v1 root.");
  }
  const backend = environment.SPARK_AI_BACKEND ?? "vllm";
  if (backend !== "vllm" && backend !== "openai-compatible") {
    throw new ControlApiConfigError("SPARK_AI_BACKEND is invalid.");
  }
  const apiKey = environment.SPARK_AI_API_KEY?.trim() || undefined;
  if (apiKey !== undefined && (apiKey.length < 16 || apiKey.length > 4_096)) {
    throw new ControlApiConfigError("SPARK_AI_API_KEY length is invalid.");
  }
  if (!isLoopbackHost(url.hostname) && apiKey === undefined) {
    throw new ControlApiConfigError(
      "SPARK_AI_API_KEY is required for a non-loopback metrics endpoint.",
    );
  }
  const maxConcurrencyValue = environment.AI_MAX_CONCURRENCY;
  return {
    baseUrl: rawUrl,
    nodeName: boundedText(environment.SPARK_AI_NODE_NAME ?? "MSI DGX Spark", 1, 128),
    backend,
    ...(environment.SPARK_AI_QUANTIZATION === undefined ||
      environment.SPARK_AI_QUANTIZATION === ""
      ? {}
      : { quantization: boundedText(environment.SPARK_AI_QUANTIZATION, 1, 128) }),
    ...(apiKey === undefined ? {} : { apiKey }),
    timeoutMs: integerEnvironment(environment.SPARK_METRICS_TIMEOUT_MS, 5_000, 100, 60_000),
    ...(maxConcurrencyValue === undefined || maxConcurrencyValue === ""
      ? {}
      : { maxConcurrency: integerEnvironment(maxConcurrencyValue, 10, 1, 1_000) }),
  };
}

function parsePrincipal(value: unknown): ApiPrincipalConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlApiConfigError("Control API principal must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "permissions,subject,tokenSha256") {
    throw new ControlApiConfigError("Control API principal has unknown fields.");
  }
  if (
    typeof record.subject !== "string" ||
    typeof record.tokenSha256 !== "string" ||
    !Array.isArray(record.permissions) ||
    !record.permissions.every(
      (permission): permission is ControlApiPermission =>
        typeof permission === "string" &&
        PERMISSIONS.has(permission as ControlApiPermission),
    )
  ) {
    throw new ControlApiConfigError("Control API principal fields are invalid.");
  }
  return {
    subject: record.subject,
    tokenSha256: record.tokenSha256,
    permissions: record.permissions,
  };
}

function integerEnvironment(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]+$/u.test(value)) {
    throw new ControlApiConfigError("Control API numeric setting is invalid.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ControlApiConfigError("Control API numeric setting is out of range.");
  }
  return parsed;
}

function boundedText(value: string, minimum: number, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ControlApiConfigError("Control API text setting is invalid.");
  }
  return normalized;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname === "[::1]" || hostname === "::1";
}
