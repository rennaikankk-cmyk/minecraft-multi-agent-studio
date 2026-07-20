import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { ControlApiPermission } from "@minecraft-studio/protocol";

const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const APPLICATION_PROTOCOL = "minecraft-studio.v1";
const AUTH_PROTOCOL_PREFIX = "auth.";
const ALLOWED_PERMISSIONS = new Set<ControlApiPermission>([
  "bot.read",
  "bot.position.read",
]);

export type ApiPrincipalConfig = Readonly<{
  subject: string;
  tokenSha256: string;
  permissions: readonly ControlApiPermission[];
}>;

export type ApiPrincipal = Readonly<{
  subject: string;
  permissions: ReadonlySet<ControlApiPermission>;
}>;

type StoredPrincipal = {
  digest: Buffer;
  principal: ApiPrincipal;
};

export class TokenAuthenticator {
  private readonly principals: StoredPrincipal[];

  constructor(configs: readonly ApiPrincipalConfig[]) {
    if (configs.length === 0 || configs.length > 1_000) {
      throw new TypeError("Control API requires between 1 and 1000 principals.");
    }

    const subjects = new Set<string>();
    const hashes = new Set<string>();
    this.principals = configs.map((config) => {
      if (!SUBJECT_PATTERN.test(config.subject) || subjects.has(config.subject)) {
        throw new TypeError("Control API principal subject is invalid or duplicated.");
      }
      const normalizedHash = config.tokenSha256.toLowerCase();
      if (!SHA256_PATTERN.test(normalizedHash) || hashes.has(normalizedHash)) {
        throw new TypeError("Control API token hash is invalid or duplicated.");
      }
      const permissions = new Set(config.permissions);
      if (
        permissions.size === 0 ||
        permissions.size !== config.permissions.length ||
        [...permissions].some((permission) => !ALLOWED_PERMISSIONS.has(permission))
      ) {
        throw new TypeError("Control API permissions must be nonempty and unique.");
      }
      subjects.add(config.subject);
      hashes.add(normalizedHash);
      return {
        digest: Buffer.from(normalizedHash, "hex"),
        principal: { subject: config.subject, permissions },
      };
    });
  }

  authenticate(request: IncomingMessage): ApiPrincipal | null {
    const headerToken = bearerToken(request.headers.authorization);
    const protocolToken = websocketProtocolToken(
      request.headers["sec-websocket-protocol"],
    );
    const token = headerToken ?? protocolToken;
    if (!token || token.length < 32 || token.length > 512) return null;

    const digest = createHash("sha256").update(token, "utf8").digest();
    let match: ApiPrincipal | null = null;
    for (const stored of this.principals) {
      if (timingSafeEqual(digest, stored.digest)) match = stored.principal;
    }
    return match;
  }
}

export function websocketProtocols(header: string | string[] | undefined): string[] {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function hasSupportedWebSocketProtocol(
  header: string | string[] | undefined,
): boolean {
  return websocketProtocols(header).includes(APPLICATION_PROTOCOL);
}

export function applicationWebSocketProtocol(): string {
  return APPLICATION_PROTOCOL;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  return match?.[1] ?? null;
}

function websocketProtocolToken(
  header: string | string[] | undefined,
): string | null {
  const authProtocol = websocketProtocols(header).find((protocol) =>
    protocol.startsWith(AUTH_PROTOCOL_PREFIX),
  );
  if (!authProtocol) return null;
  const encoded = authProtocol.slice(AUTH_PROTOCOL_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,700}$/u.test(encoded)) return null;
  try {
    const token = Buffer.from(encoded, "base64url").toString("utf8");
    return Buffer.from(token, "utf8").toString("base64url") === encoded
      ? token
      : null;
  } catch {
    return null;
  }
}
