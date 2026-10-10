import { CONTROL_LINK_PATH } from "@minecraft-studio/protocol";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type CoordinatorLinkClientConfig = Readonly<{
  url: string;
  clientId: string;
  keyId: string;
  secret: string;
  handshakeTimeoutMs: number;
  livenessTimeoutMs: number;
  stopTimeoutMs: number;
  reconnect: Readonly<{
    baseDelayMs: number;
    maxDelayMs: number;
  }>;
  maxPendingStops: number;
  /** goal 通道容量；与服务端同名配置对应，避免 stop 上限隐式钳制 goal。 */
  maxPendingGoals: number;
  maxSocketBufferedBytes: number;
}>;

export type CoordinatorLinkConfigErrorCode =
  | "COORDINATOR_LINK_URL_REQUIRED"
  | "COORDINATOR_LINK_URL_INVALID"
  | "COORDINATOR_LINK_CLIENT_ID_REQUIRED"
  | "COORDINATOR_LINK_CLIENT_ID_INVALID"
  | "COORDINATOR_LINK_KEY_ID_REQUIRED"
  | "COORDINATOR_LINK_KEY_ID_INVALID"
  | "COORDINATOR_LINK_SECRET_REQUIRED"
  | "COORDINATOR_LINK_SECRET_INVALID";

export class CoordinatorLinkConfigError extends Error {
  constructor(
    readonly code: CoordinatorLinkConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CoordinatorLinkConfigError";
  }
}

export function loadCoordinatorLinkConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CoordinatorLinkClientConfig {
  const url = parseUrl(environment.CONTROL_API_COORDINATOR_LINK_URL);
  const clientId = parseIdentifier(
    environment.CONTROL_API_COORDINATOR_LINK_CLIENT_ID,
    "CLIENT_ID",
  );
  const keyId = parseIdentifier(
    environment.CONTROL_API_COORDINATOR_LINK_KEY_ID,
    "KEY_ID",
  );
  const secret = environment.CONTROL_API_COORDINATOR_LINK_SECRET;
  if (!secret) {
    throw new CoordinatorLinkConfigError(
      "COORDINATOR_LINK_SECRET_REQUIRED",
      "CONTROL_API_COORDINATOR_LINK_SECRET is required.",
    );
  }
  if (
    secret.length < 32 ||
    secret.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(secret)
  ) {
    throw new CoordinatorLinkConfigError(
      "COORDINATOR_LINK_SECRET_INVALID",
      "CONTROL_API_COORDINATOR_LINK_SECRET must contain 32 to 512 non-control characters.",
    );
  }

  return {
    url,
    clientId,
    keyId,
    secret,
    handshakeTimeoutMs: 5_000,
    livenessTimeoutMs: 75_000,
    stopTimeoutMs: 17_000,
    reconnect: { baseDelayMs: 250, maxDelayMs: 8_000 },
    maxPendingStops: 128,
    maxPendingGoals: 128,
    maxSocketBufferedBytes: 256 * 1_024,
  };
}

function parseUrl(value: string | undefined): string {
  if (!value) {
    throw new CoordinatorLinkConfigError(
      "COORDINATOR_LINK_URL_REQUIRED",
      "CONTROL_API_COORDINATOR_LINK_URL is required.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CoordinatorLinkConfigError(
      "COORDINATOR_LINK_URL_INVALID",
      "CONTROL_API_COORDINATOR_LINK_URL is not a valid URL.",
    );
  }
  if (
    parsed.protocol !== "ws:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") ||
    parsed.port === "" ||
    parsed.pathname !== CONTROL_LINK_PATH ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new CoordinatorLinkConfigError(
      "COORDINATOR_LINK_URL_INVALID",
      "Coordinator Link URL must be an explicit loopback ws URL for /v1/control-link.",
    );
  }
  return parsed.toString();
}

function parseIdentifier(
  value: string | undefined,
  field: "CLIENT_ID" | "KEY_ID",
): string {
  if (!value) {
    throw new CoordinatorLinkConfigError(
      `COORDINATOR_LINK_${field}_REQUIRED`,
      `CONTROL_API_COORDINATOR_LINK_${field} is required.`,
    );
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new CoordinatorLinkConfigError(
      `COORDINATOR_LINK_${field}_INVALID`,
      `CONTROL_API_COORDINATOR_LINK_${field} is invalid.`,
    );
  }
  return value;
}
