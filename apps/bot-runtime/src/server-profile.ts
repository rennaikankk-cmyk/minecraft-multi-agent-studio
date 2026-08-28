import { isIP } from "node:net";

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { isMineflayerTestedVersion } from "./version-compatibility.js";

const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_COMBAT_WHITELIST_ENTRIES = 256;
const MINECRAFT_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/u;
const COMPACT_UUID_PATTERN = /^[0-9a-f]{32}$/u;
const HYPHENATED_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function normalizedUuid(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}

function rejectNormalizedDuplicates(
  values: readonly string[],
  normalize: (value: string) => string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const normalized = normalize(value);
    if (seen.has(normalized)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "Combat whitelist entries must be unique after normalization.",
      });
      continue;
    }
    seen.add(normalized);
  }
}

const combatWhitelistUsernameSchema = z
  .string()
  .regex(MINECRAFT_USERNAME_PATTERN);

const combatWhitelistUuidSchema = z.string().refine(
  (value) => {
    const lower = value.toLowerCase();
    return (
      COMPACT_UUID_PATTERN.test(lower) || HYPHENATED_UUID_PATTERN.test(lower)
    );
  },
  { message: "Combat whitelist UUID must be compact or canonically hyphenated." },
);

export const serverProfileCombatConfigSchema = z
  .object({
    enabled: z.boolean(),
    stance: z.enum(["preserve-life", "expendable"]),
    whitelist: z
      .object({
        usernames: z
          .array(combatWhitelistUsernameSchema)
          .max(MAX_COMBAT_WHITELIST_ENTRIES)
          .superRefine((values, context) =>
            rejectNormalizedDuplicates(
              values,
              (value) => value.toLowerCase(),
              context,
            ),
          ),
        uuids: z
          .array(combatWhitelistUuidSchema)
          .max(MAX_COMBAT_WHITELIST_ENTRIES)
          .superRefine((values, context) =>
            rejectNormalizedDuplicates(values, normalizedUuid, context),
          ),
      })
      .strict(),
  })
  .strict();

/**
 * A profile created by the Desktop Manager targets an operator-owned real
 * server. It remains distinct from the disposable isolated-test profile so
 * test-only policy probing cannot be enabled accidentally on a managed bot.
 */
export const serverProfilePurposeSchema = z.enum([
  "isolated-test",
  "managed",
  /**
   * 无规则（anarchy）服务器：对抗开挂玩家，强度优先。允许公网地址；
   * 导航默认切到 ANARCHY 档（沿途挖掘/疾跑/跑酷/搭高）。
   */
  "anarchy",
]);

/**
 * 导航档位。safe = 反作弊兼容立场（不沿途挖掘、不跑酷、限下落）；
 * anarchy = 无规则服强度优先，全部放开（仅保留防活埋/防引液两条例外，
 * 它们是存活安全，不是反作弊让步）。
 */
export const serverProfileNavigationSchema = z.enum(["safe", "anarchy"]);

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;

  if (isIP(normalized) === 4) {
    return normalized.startsWith("127.");
  }

  return false;
}

function isPrivateIpv4(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const octets = host.split(".").map(Number);
  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) return false;

  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isPrivateIpv6(host: string): boolean {
  if (isIP(host) !== 6) return false;
  const normalized = host.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized)
  );
}

function hostMatchesScope(
  host: string,
  scope: "loopback" | "private-lan" | "public",
): boolean {
  if (isLoopbackHost(host)) return true;
  if (scope === "loopback") return false;
  if (scope === "public") return true;

  return (
    isPrivateIpv4(host) ||
    isPrivateIpv6(host) ||
    host.toLowerCase() === "host.docker.internal"
  );
}

function isResolvablePublicHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  // IPv4 / IPv6 字面量或 DNS 名（排除内网保留名）。公网由调用方显式声明，
  // 这里只挡明显写错的东西（空串、带协议前缀、带空格）。
  if (/^https?:\/\//u.test(normalized)) return false;
  return /^[a-z0-9.:\-]+$/u.test(normalized);
}

export const serverProfileSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    botId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    purpose: serverProfilePurposeSchema,
    networkScope: z.enum(["loopback", "private-lan", "public"]),
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    minecraftVersion: z.union([
      z.literal("auto"),
      z
        .string()
        .min(1)
        .max(64)
        .refine(isMineflayerTestedVersion, {
          message:
            "Fixed minecraftVersion must be explicitly tested by the installed Mineflayer version.",
        }),
    ]),
    username: z
      .string()
      .min(3)
      .max(16)
      .regex(MINECRAFT_USERNAME_PATTERN),
    auth: z.literal("offline"),
    combat: serverProfileCombatConfigSchema.optional(),
    /** 导航档位；缺省 safe。anarchy purpose 建议配 anarchy（也可手动选 safe）。 */
    navigation: serverProfileNavigationSchema.optional(),
    statusIntervalMs: z.number().int().min(250).max(30_000),
    heartbeatIntervalMs: z.number().int().min(1_000).max(60_000),
    stopGracePeriodMs: z.number().int().min(0).max(30_000),
    reconnect: z
      .object({
        enabled: z.boolean(),
        maxAttempts: z.number().int().min(0).max(20),
        baseDelayMs: z.number().int().min(500).max(60_000),
        maxDelayMs: z.number().int().min(500).max(300_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (!hostMatchesScope(profile.host, profile.networkScope)) {
      context.addIssue({
        code: "custom",
        path: ["host"],
        message: "Host must be loopback or a private LAN address allowed by networkScope.",
      });
    }
    if (
      profile.networkScope === "public" &&
      profile.purpose !== "anarchy"
    ) {
      context.addIssue({
        code: "custom",
        path: ["networkScope"],
        message: "Public network scope is only permitted for anarchy-purpose profiles.",
      });
    }
    if (
      profile.networkScope === "public" &&
      !isResolvablePublicHost(profile.host)
    ) {
      context.addIssue({
        code: "custom",
        path: ["host"],
        message: "Public host must be a bare IPv4/IPv6 literal or DNS name.",
      });
    }
    if (profile.reconnect.baseDelayMs > profile.reconnect.maxDelayMs) {
      context.addIssue({
        code: "custom",
        path: ["reconnect", "baseDelayMs"],
        message: "baseDelayMs cannot exceed maxDelayMs.",
      });
    }
  });

export type ServerProfile = z.infer<typeof serverProfileSchema>;
export type ServerProfilePurpose = z.infer<typeof serverProfilePurposeSchema>;
export type ServerProfileCombatConfig = z.infer<
  typeof serverProfileCombatConfigSchema
>;

export type ServerProfileErrorCode =
  | "SERVER_PROFILE_REQUIRED"
  | "SERVER_PROFILE_UNREADABLE"
  | "SERVER_PROFILE_NOT_REGULAR_FILE"
  | "SERVER_PROFILE_TOO_LARGE"
  | "SERVER_PROFILE_INVALID_JSON"
  | "SERVER_PROFILE_INVALID";

export class ServerProfileError extends Error {
  readonly code: ServerProfileErrorCode;

  constructor(code: ServerProfileErrorCode, message: string) {
    super(message);
    this.name = "ServerProfileError";
    this.code = code;
  }
}

export async function loadServerProfile(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ServerProfile> {
  const configuredPath = environment.BOT_SERVER_PROFILE_PATH?.trim();
  if (!configuredPath) {
    throw new ServerProfileError(
      "SERVER_PROFILE_REQUIRED",
      "BOT_SERVER_PROFILE_PATH is required; no Minecraft connection was attempted.",
    );
  }

  const absolutePath = path.resolve(configuredPath);
  let canonicalPath: string;
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    canonicalPath = await realpath(absolutePath);
    fileStat = await stat(canonicalPath);
  } catch {
    throw new ServerProfileError(
      "SERVER_PROFILE_UNREADABLE",
      "The configured ServerProfile does not exist or cannot be read.",
    );
  }
  if (!fileStat.isFile()) {
    throw new ServerProfileError(
      "SERVER_PROFILE_NOT_REGULAR_FILE",
      "The configured ServerProfile path is not a regular file.",
    );
  }
  if (fileStat.size > MAX_PROFILE_BYTES) {
    throw new ServerProfileError(
      "SERVER_PROFILE_TOO_LARGE",
      "The ServerProfile exceeds the 64 KiB safety limit.",
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(await readFile(canonicalPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ServerProfileError(
        "SERVER_PROFILE_INVALID_JSON",
        "The ServerProfile is not valid JSON.",
      );
    }
    throw new ServerProfileError(
      "SERVER_PROFILE_UNREADABLE",
      "The configured ServerProfile cannot be read.",
    );
  }

  const parsed = serverProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw new ServerProfileError(
      "SERVER_PROFILE_INVALID",
      `The ServerProfile failed validation: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}
