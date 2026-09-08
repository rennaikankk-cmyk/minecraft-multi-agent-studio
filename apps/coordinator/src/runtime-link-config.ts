import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MINECRAFT_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const RUNTIME_LINK_PEERS_MAX_BYTES = 256 * 1_024;

export type RuntimeLinkPeerConfig = Readonly<{
  keyId: string;
  botId: string;
  secretSha256: string;
}>;

export type RuntimeLinkRuntimeConfig = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
  botStaleAfterMs: number;
  peers: RuntimeLinkPeerConfig[];
  /** Managed key-to-username assignments; configured keys/hashes remain the trust root. */
  peersPath?: string;
  /** Explicit subset managed by the file; other peers retain their static binding. */
  managedKeyIds?: string[];
}>;

export type RuntimeLinkConfigErrorCode =
  | "RUNTIME_LINK_HOST_INVALID"
  | "RUNTIME_LINK_PORT_INVALID"
  | "RUNTIME_LINK_AUTH_REQUIRED"
  | "RUNTIME_LINK_AUTH_INVALID"
  | "COORDINATOR_BOT_STALE_AFTER_MS_INVALID";

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

  const peersPath = environment.COORDINATOR_RUNTIME_LINK_PEERS_PATH !== undefined
    ? parsePeersPath(environment.COORDINATOR_RUNTIME_LINK_PEERS_PATH) : undefined;
  let managedKeyIds: string[] | undefined;
  if (environment.COORDINATOR_RUNTIME_LINK_MANAGED_KEY_IDS_JSON !== undefined) {
    try {
      managedKeyIds = [...resolveManagedRuntimeLinkKeyIds(
        JSON.parse(environment.COORDINATOR_RUNTIME_LINK_MANAGED_KEY_IDS_JSON) as unknown, keyIds, peersPath)];
    } catch {
      throw new RuntimeLinkConfigError("RUNTIME_LINK_AUTH_INVALID", "Runtime Link managed key IDs are invalid.");
    }
  }
  return {
    host,
    port,
    botStaleAfterMs: parseBotStaleAfterMs(
      environment.COORDINATOR_BOT_STALE_AFTER_MS,
    ),
    peers,
    ...(peersPath !== undefined ? { peersPath } : {}),
    ...(managedKeyIds !== undefined ? { managedKeyIds } : {}),
  };
}

export function resolveManagedRuntimeLinkKeyIds(
  input: unknown, authorizedKeyIds: ReadonlySet<string>, peersPath?: string,
): ReadonlySet<string> {
  // Compatibility for the original file-only option: the file owns all keys.
  // Launchers mixing managed slots with external peers must declare the subset.
  if (input === undefined) return new Set(peersPath === undefined ? [] : authorizedKeyIds);
  if (!Array.isArray(input) || input.length > 1_000 || (input.length > 0 && !peersPath) ||
    input.some((keyId) => typeof keyId !== "string" || !IDENTIFIER_PATTERN.test(keyId) || !authorizedKeyIds.has(keyId)) ||
    new Set(input).size !== input.length) {
    throw new RuntimeLinkConfigError("RUNTIME_LINK_AUTH_INVALID", "Runtime Link managed key IDs are invalid.");
  }
  return new Set(input as string[]);
}

function parsePeersPath(value: string): string {
  if (!value.trim() || !path.isAbsolute(value) || value.includes("\0")) {
    throw new RuntimeLinkConfigError("RUNTIME_LINK_AUTH_INVALID", "Runtime Link managed peer path must be absolute.");
  }
  return value;
}

/** Fresh bounded file read: missing/corrupt mappings never fall back to static Bot IDs. */
export function readManagedRuntimeLinkPeers(
  peersPath: string,
  authorizedPeers: ReadonlyMap<string, RuntimeLinkPeerConfig>,
  managedKeyIds: ReadonlySet<string> = new Set(authorizedPeers.keys()),
): ReadonlyMap<string, RuntimeLinkPeerConfig> {
  let fd: number | undefined;
  try {
    fd = openSync(parsePeersPath(peersPath), "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > RUNTIME_LINK_PEERS_MAX_BYTES) throw new Error("invalid file size/type");
    // The extra byte also catches a file growing after fstat. Never allocate
    // from a size supplied by the file, or read unbounded data via readFile.
    const buffer = Buffer.alloc(RUNTIME_LINK_PEERS_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = readSync(fd, buffer, length, buffer.length - length, null);
      if (bytes === 0) break;
      length += bytes;
    }
    if (length > RUNTIME_LINK_PEERS_MAX_BYTES) throw new Error("file too large");
    const raw = JSON.parse(buffer.toString("utf8", 0, length)) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid envelope");
    const envelope = raw as Record<string, unknown>;
    if (Object.keys(envelope).sort().join(",") !== "peers,schemaVersion" || envelope.schemaVersion !== "1.0" ||
      !Array.isArray(envelope.peers) || envelope.peers.length > 1_000) throw new Error("invalid envelope");
    const peers = new Map<string, RuntimeLinkPeerConfig>();
    const usernames = new Set([...authorizedPeers.values()]
      .filter((peer) => !managedKeyIds.has(peer.keyId)).map((peer) => peer.botId.toLowerCase()));
    const hashes = new Set<string>();
    for (const entry of envelope.peers) {
      const peer = parsePeer(entry);
      const authorized = authorizedPeers.get(peer.keyId);
      const username = peer.botId.toLowerCase();
      if (!authorized || !managedKeyIds.has(peer.keyId) || peer.secretSha256 !== authorized.secretSha256 || peers.has(peer.keyId) ||
        usernames.has(username) || hashes.has(peer.secretSha256) ||
        // Existing persisted slot aliases retain only their original key binding.
        // A rename must always be a valid Minecraft username.
        (!MINECRAFT_USERNAME_PATTERN.test(peer.botId) && peer.botId !== authorized.botId)) {
        throw new Error("unapproved or duplicated peer");
      }
      peers.set(peer.keyId, peer);
      usernames.add(username);
      hashes.add(peer.secretSha256);
    }
    return peers;
  } catch {
    throw new RuntimeLinkConfigError("RUNTIME_LINK_AUTH_INVALID", "Runtime Link managed peer bindings are unavailable or invalid.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
    !(IDENTIFIER_PATTERN.test(record.botId) || MINECRAFT_USERNAME_PATTERN.test(record.botId)) ||
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

function parseBotStaleAfterMs(value: string | undefined): number {
  if (value === undefined || value === "") return 15_000;
  if (!/^[0-9]+$/u.test(value)) {
    throw new RuntimeLinkConfigError(
      "COORDINATOR_BOT_STALE_AFTER_MS_INVALID",
      "COORDINATOR_BOT_STALE_AFTER_MS must be an integer.",
    );
  }
  const milliseconds = Number(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1_000 ||
    milliseconds > 300_000
  ) {
    throw new RuntimeLinkConfigError(
      "COORDINATOR_BOT_STALE_AFTER_MS_INVALID",
      "COORDINATOR_BOT_STALE_AFTER_MS must be between 1000 and 300000.",
    );
  }
  return milliseconds;
}
