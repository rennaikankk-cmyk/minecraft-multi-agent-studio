import { isIP } from "node:net";

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { isMineflayerTestedVersion } from "./version-compatibility.js";

const MAX_PROFILE_BYTES = 64 * 1024;

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

function hostMatchesScope(host: string, scope: "loopback" | "private-lan"): boolean {
  if (isLoopbackHost(host)) return true;
  if (scope === "loopback") return false;

  return (
    isPrivateIpv4(host) ||
    isPrivateIpv6(host) ||
    host.toLowerCase() === "host.docker.internal"
  );
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
    purpose: z.literal("isolated-test"),
    networkScope: z.enum(["loopback", "private-lan"]),
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
      .regex(/^[A-Za-z0-9_]+$/u),
    auth: z.literal("offline"),
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
    if (profile.reconnect.baseDelayMs > profile.reconnect.maxDelayMs) {
      context.addIssue({
        code: "custom",
        path: ["reconnect", "baseDelayMs"],
        message: "baseDelayMs cannot exceed maxDelayMs.",
      });
    }
  });

export type ServerProfile = z.infer<typeof serverProfileSchema>;

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
