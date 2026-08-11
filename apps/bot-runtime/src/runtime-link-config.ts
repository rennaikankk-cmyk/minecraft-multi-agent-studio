const RUNTIME_LINK_PATH = "/v1/runtime-link";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export type RuntimeLinkClientConfig = Readonly<{
  url: string;
  keyId: string;
  secret: string;
  handshakeTimeoutMs: number;
  telemetryAckTimeoutMs: number;
  reconnect: Readonly<{
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  }>;
  queue: Readonly<{
    maxMessages: number;
    maxBytes: number;
    maxSocketBufferedBytes: number;
  }>;
}>;

export type RuntimeLinkConfigErrorCode =
  | "RUNTIME_LINK_URL_REQUIRED"
  | "RUNTIME_LINK_URL_INVALID"
  | "RUNTIME_LINK_KEY_ID_REQUIRED"
  | "RUNTIME_LINK_KEY_ID_INVALID"
  | "RUNTIME_LINK_SECRET_REQUIRED"
  | "RUNTIME_LINK_SECRET_INVALID";

export class RuntimeLinkConfigError extends Error {
  readonly code: RuntimeLinkConfigErrorCode;

  constructor(code: RuntimeLinkConfigErrorCode, message: string) {
    super(message);
    this.name = "RuntimeLinkConfigError";
    this.code = code;
  }
}

export function loadRuntimeLinkConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeLinkClientConfig {
  const url = parseRuntimeLinkUrl(environment.BOT_RUNTIME_LINK_URL);
  const keyId = environment.BOT_RUNTIME_LINK_KEY_ID;
  if (!keyId) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_KEY_ID_REQUIRED",
      "BOT_RUNTIME_LINK_KEY_ID is required.",
    );
  }
  if (
    keyId.length > 128 ||
    !IDENTIFIER_PATTERN.test(keyId)
  ) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_KEY_ID_INVALID",
      "BOT_RUNTIME_LINK_KEY_ID is outside the allowed identifier boundary.",
    );
  }

  const secret = environment.BOT_RUNTIME_LINK_SECRET;
  if (!secret) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_SECRET_REQUIRED",
      "BOT_RUNTIME_LINK_SECRET is required.",
    );
  }
  if (
    secret.length < 32 ||
    secret.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(secret)
  ) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_SECRET_INVALID",
      "BOT_RUNTIME_LINK_SECRET must contain 32 to 512 non-control characters.",
    );
  }

  return {
    url,
    keyId,
    secret,
    handshakeTimeoutMs: 5_000,
    telemetryAckTimeoutMs: 5_000,
    reconnect: {
      maxAttempts: 8,
      baseDelayMs: 250,
      maxDelayMs: 8_000,
    },
    queue: {
      maxMessages: 128,
      maxBytes: 512 * 1_024,
      maxSocketBufferedBytes: 256 * 1_024,
    },
  };
}

function parseRuntimeLinkUrl(value: string | undefined): string {
  if (!value) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_URL_REQUIRED",
      "BOT_RUNTIME_LINK_URL is required.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_URL_INVALID",
      "BOT_RUNTIME_LINK_URL is not a valid URL.",
    );
  }

  const loopbackHost =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    parsed.protocol !== "ws:" ||
    !loopbackHost ||
    parsed.port === "" ||
    parsed.pathname !== RUNTIME_LINK_PATH ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_URL_INVALID",
      "BOT_RUNTIME_LINK_URL must be an explicit loopback ws URL for /v1/runtime-link.",
    );
  }

  return parsed.toString();
}
