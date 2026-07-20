import type { ControlApiPermission } from "@minecraft-studio/protocol";

import type { ApiPrincipalConfig } from "./auth.js";

const PERMISSIONS = new Set<ControlApiPermission>([
  "bot.read",
  "bot.position.read",
]);

export type ControlApiRuntimeConfig = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
  staleAfterMs: number;
  principals: ApiPrincipalConfig[];
  requestLimitPerMinute: number;
  handshakeLimitPerMinute: number;
  maxConnectionsPerSubject: number;
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
  return {
    host,
    port: integerEnvironment(environment.CONTROL_API_PORT, 3210, 1, 65_535),
    staleAfterMs: integerEnvironment(
      environment.CONTROL_API_STALE_AFTER_MS,
      15_000,
      1_000,
      300_000,
    ),
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
