import type { ControlLinkCapability } from "@minecraft-studio/protocol";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUIRED_CAPABILITIES = new Set<ControlLinkCapability>([
  "bot.read",
  "bot.stop",
]);

export type ControlLinkClientConfig = Readonly<{
  clientId: string;
  keyId: string;
  secretSha256: string;
  capabilities: readonly ControlLinkCapability[];
}>;

export type ControlLinkRuntimeConfig = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
  clients: ControlLinkClientConfig[];
}>;

export type ControlLinkConfigErrorCode =
  | "CONTROL_LINK_HOST_INVALID"
  | "CONTROL_LINK_PORT_INVALID"
  | "CONTROL_LINK_CLIENTS_REQUIRED"
  | "CONTROL_LINK_CLIENTS_INVALID";

export class ControlLinkConfigError extends Error {
  readonly code: ControlLinkConfigErrorCode;

  constructor(code: ControlLinkConfigErrorCode, message: string) {
    super(message);
    this.name = "ControlLinkConfigError";
    this.code = code;
  }
}

export function loadControlLinkConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ControlLinkRuntimeConfig {
  const host = environment.COORDINATOR_CONTROL_LINK_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new ControlLinkConfigError(
      "CONTROL_LINK_HOST_INVALID",
      "Coordinator Control Link only permits an explicit loopback bind.",
    );
  }

  const clientsJson = environment.COORDINATOR_CONTROL_LINK_CLIENTS_JSON;
  if (!clientsJson) {
    throw new ControlLinkConfigError(
      "CONTROL_LINK_CLIENTS_REQUIRED",
      "COORDINATOR_CONTROL_LINK_CLIENTS_JSON is required.",
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(clientsJson);
  } catch {
    throw new ControlLinkConfigError(
      "CONTROL_LINK_CLIENTS_INVALID",
      "COORDINATOR_CONTROL_LINK_CLIENTS_JSON is not valid JSON.",
    );
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
    throw new ControlLinkConfigError(
      "CONTROL_LINK_CLIENTS_INVALID",
      "Control Link configuration must contain between 1 and 64 clients.",
    );
  }

  const clientIds = new Set<string>();
  const keyIds = new Set<string>();
  const secretHashes = new Set<string>();
  const clients = input.map((value) => {
    const client = parseClient(value);
    if (
      clientIds.has(client.clientId) ||
      keyIds.has(client.keyId) ||
      secretHashes.has(client.secretSha256)
    ) {
      throw new ControlLinkConfigError(
        "CONTROL_LINK_CLIENTS_INVALID",
        "Control Link client IDs, key IDs, and secret hashes must be unique.",
      );
    }
    clientIds.add(client.clientId);
    keyIds.add(client.keyId);
    secretHashes.add(client.secretSha256);
    return client;
  });

  return {
    host,
    port: parsePort(environment.COORDINATOR_CONTROL_LINK_PORT),
    clients,
  };
}

function parseClient(value: unknown): ControlLinkClientConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidClients("Each Control Link client must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    "capabilities,clientId,keyId,secretSha256"
  ) {
    throw invalidClients(
      "Control Link client contains missing or unknown fields.",
    );
  }
  if (
    typeof record.clientId !== "string" ||
    !IDENTIFIER_PATTERN.test(record.clientId) ||
    typeof record.keyId !== "string" ||
    !IDENTIFIER_PATTERN.test(record.keyId) ||
    typeof record.secretSha256 !== "string" ||
    !Array.isArray(record.capabilities)
  ) {
    throw invalidClients("Control Link client identity fields are invalid.");
  }
  const secretSha256 = record.secretSha256.toLowerCase();
  if (!SHA256_PATTERN.test(secretSha256)) {
    throw invalidClients(
      "Control Link client secretSha256 must be a SHA-256 hex digest.",
    );
  }
  const capabilities = record.capabilities;
  if (
    capabilities.length !== REQUIRED_CAPABILITIES.size ||
    capabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        !REQUIRED_CAPABILITIES.has(capability as ControlLinkCapability),
    ) ||
    new Set(capabilities).size !== capabilities.length
  ) {
    throw invalidClients(
      "Control Link clients require unique bot.read and bot.stop capabilities.",
    );
  }
  return {
    clientId: record.clientId,
    keyId: record.keyId,
    secretSha256,
    capabilities: capabilities as ControlLinkCapability[],
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 3_221;
  if (!/^[0-9]+$/u.test(value)) {
    throw new ControlLinkConfigError(
      "CONTROL_LINK_PORT_INVALID",
      "Coordinator Control Link port is invalid.",
    );
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ControlLinkConfigError(
      "CONTROL_LINK_PORT_INVALID",
      "Coordinator Control Link port is outside the allowed range.",
    );
  }
  return port;
}

function invalidClients(message: string): ControlLinkConfigError {
  return new ControlLinkConfigError("CONTROL_LINK_CLIENTS_INVALID", message);
}
