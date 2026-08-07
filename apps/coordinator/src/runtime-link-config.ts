const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type RuntimeLinkPeerConfig = Readonly<{
  keyId: string;
  botId: string;
  secretSha256: string;
}>;

export type RuntimeLinkRuntimeConfig = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
  peers: RuntimeLinkPeerConfig[];
}>;

export type RuntimeLinkConfigErrorCode =
  | "RUNTIME_LINK_HOST_INVALID"
  | "RUNTIME_LINK_PORT_INVALID"
  | "RUNTIME_LINK_AUTH_REQUIRED"
  | "RUNTIME_LINK_AUTH_INVALID";

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
): RuntimeLinkRuntimeConfig {
  const host = environment.COORDINATOR_RUNTIME_LINK_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_HOST_INVALID",
      "Coordinator Runtime Link only permits an explicit loopback bind.",
    );
  }

  const port = parsePort(environment.COORDINATOR_RUNTIME_LINK_PORT);
  const peersJson = environment.COORDINATOR_RUNTIME_LINK_PEERS_JSON;
  if (!peersJson) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_AUTH_REQUIRED",
      "COORDINATOR_RUNTIME_LINK_PEERS_JSON is required.",
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(peersJson);
  } catch {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_AUTH_INVALID",
      "COORDINATOR_RUNTIME_LINK_PEERS_JSON is not valid JSON.",
    );
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > 1_000) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_AUTH_INVALID",
      "Runtime Link auth must contain between 1 and 1000 peers.",
    );
  }

  const keyIds = new Set<string>();
  const botIds = new Set<string>();
  const secretHashes = new Set<string>();
  const peers = input.map((value) => {
    const peer = parsePeer(value);
    if (
      keyIds.has(peer.keyId) ||
      botIds.has(peer.botId) ||
      secretHashes.has(peer.secretSha256)
    ) {
      throw new RuntimeLinkConfigError(
        "RUNTIME_LINK_AUTH_INVALID",
        "Runtime Link peer key IDs, Bot IDs, and secret hashes must be unique.",
      );
    }
    keyIds.add(peer.keyId);
    botIds.add(peer.botId);
    secretHashes.add(peer.secretSha256);
    return peer;
  });

  return { host, port, peers };
}

function parsePeer(value: unknown): RuntimeLinkPeerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_AUTH_INVALID",
      "Each Runtime Link peer must be an object.",
    );
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "botId,keyId,secretSha256") {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_AUTH_INVALID",
      "Runtime Link peer contains missing or unknown fields.",
    );
  }
  if (
    typeof record.keyId !== "string" ||
    !IDENTIFIER_PATTERN.test(record.keyId) ||
    typeof record.botId !== "string" ||
    !IDENTIFIER_PATTERN.test(record.botId) ||
    typeof record.secretSha256 !== "string"
  ) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_AUTH_INVALID",
      "Runtime Link peer identity fields are invalid.",
    );
  }
  const secretSha256 = record.secretSha256.toLowerCase();
  if (!SHA256_PATTERN.test(secretSha256)) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_AUTH_INVALID",
      "Runtime Link peer secretSha256 must be a SHA-256 hex digest.",
    );
  }
  return {
    keyId: record.keyId,
    botId: record.botId,
    secretSha256,
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 3220;
  if (!/^[0-9]+$/u.test(value)) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_PORT_INVALID",
      "Coordinator Runtime Link port is invalid.",
    );
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RuntimeLinkConfigError(
      "RUNTIME_LINK_PORT_INVALID",
      "Coordinator Runtime Link port is outside the allowed range.",
    );
  }
  return port;
}
