import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  loadCpuResourceManagerConfig,
  type BotRuntimeProcessMode,
  type CpuResourceManagerConfig,
} from "@minecraft-studio/cpu-resource-manager";
import {
  supervisorDeploymentTierSchema,
  type SupervisorBotAssignmentV1,
  type SupervisorDeploymentTier,
} from "@minecraft-studio/protocol";
import { z } from "zod";

import {
  loadRuntimeLinkConfig,
  RuntimeLinkConfigError,
} from "./runtime-link-config.js";
import {
  serverProfileSchema,
  type ServerProfile,
} from "./server-profile.js";

const MAX_CONFIG_BYTES = 256 * 1_024;
const MAX_PROFILE_BYTES = 64 * 1_024;
const ENVIRONMENT_VARIABLE_PATTERN =
  /^BOT_RUNTIME_LINK_SECRET_[A-Z0-9][A-Z0-9_]{0,95}$/u;

const supervisorManifestSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    bots: z
      .array(
        z
          .object({
            botId: z
              .string()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
            profilePath: z
              .string()
              .min(1)
              .max(1_024)
              .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
            deploymentTier: supervisorDeploymentTierSchema,
            runtimeLink: z
              .object({
                url: z.string().min(1).max(2_048),
                keyId: z
                  .string()
                  .min(1)
                  .max(128)
                  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
                secretEnvironmentVariable: z
                  .string()
                  .regex(ENVIRONMENT_VARIABLE_PATTERN),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
    restart: z
      .object({
        maxAttempts: z.number().int().min(0).max(20).default(5),
        windowMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
        baseDelayMs: z.number().int().min(100).max(60_000).default(1_000),
        maxDelayMs: z.number().int().min(100).max(300_000).default(30_000),
        stableAfterMs: z
          .number()
          .int()
          .min(1_000)
          .max(3_600_000)
          .default(60_000),
      })
      .strict()
      .default({
        maxAttempts: 5,
        windowMs: 300_000,
        baseDelayMs: 1_000,
        maxDelayMs: 30_000,
        stableAfterMs: 60_000,
      }),
    ipc: z
      .object({
        handshakeTimeoutMs: z
          .number()
          .int()
          .min(500)
          .max(30_000)
          .default(5_000),
        sendTimeoutMs: z
          .number()
          .int()
          .min(100)
          .max(30_000)
          .default(5_000),
        gracefulShutdownMs: z
          .number()
          .int()
          .min(1_000)
          .max(120_000)
          .default(30_000),
        maxQueuedMessages: z.number().int().min(1).max(256).default(32),
        maxQueuedBytes: z
          .number()
          .int()
          .min(1_024)
          .max(4 * 1_024 * 1_024)
          .default(512 * 1_024),
      })
      .strict()
      .default({
        handshakeTimeoutMs: 5_000,
        sendTimeoutMs: 5_000,
        gracefulShutdownMs: 30_000,
        maxQueuedMessages: 32,
        maxQueuedBytes: 512 * 1_024,
      }),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.restart.baseDelayMs > manifest.restart.maxDelayMs) {
      context.addIssue({
        code: "custom",
        path: ["restart", "baseDelayMs"],
        message: "重启基础延迟不能大于最大延迟。",
      });
    }
    const duplicateBotId = findDuplicate(manifest.bots.map((bot) => bot.botId));
    if (duplicateBotId) {
      context.addIssue({
        code: "custom",
        path: ["bots"],
        message: `Bot ID 重复：${duplicateBotId}`,
      });
    }
    const duplicateKeyId = findDuplicate(
      manifest.bots.map((bot) => bot.runtimeLink.keyId),
    );
    if (duplicateKeyId) {
      context.addIssue({
        code: "custom",
        path: ["bots"],
        message: `Runtime Link keyId 重复：${duplicateKeyId}`,
      });
    }
    const duplicateSecretVariable = findDuplicate(
      manifest.bots.map(
        (bot) => bot.runtimeLink.secretEnvironmentVariable,
      ),
    );
    if (duplicateSecretVariable) {
      context.addIssue({
        code: "custom",
        path: ["bots"],
        message: `Runtime Link 密钥环境变量重复：${duplicateSecretVariable}`,
      });
    }
  });

export type BotSupervisorRestartConfig = Readonly<{
  maxAttempts: number;
  windowMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  stableAfterMs: number;
}>;

export type BotSupervisorIpcConfig = Readonly<{
  handshakeTimeoutMs: number;
  sendTimeoutMs: number;
  gracefulShutdownMs: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
}>;

export type ResolvedSupervisorBot = Readonly<{
  profile: ServerProfile;
  assignment: SupervisorBotAssignmentV1;
}>;

export type BotSupervisorConfig = Readonly<{
  schemaVersion: "1.0";
  sourcePath: string;
  profileRoot: string;
  process: Readonly<{
    mode: BotRuntimeProcessMode;
    botsPerProcess: number;
    autoSize: boolean;
  }>;
  restart: BotSupervisorRestartConfig;
  ipc: BotSupervisorIpcConfig;
  bots: readonly ResolvedSupervisorBot[];
  cpuResourceManager: CpuResourceManagerConfig;
  warnings: readonly string[];
}>;

export type BotSupervisorConfigErrorCode =
  | "SUPERVISOR_CONFIG_REQUIRED"
  | "SUPERVISOR_CONFIG_UNREADABLE"
  | "SUPERVISOR_CONFIG_NOT_REGULAR_FILE"
  | "SUPERVISOR_CONFIG_TOO_LARGE"
  | "SUPERVISOR_CONFIG_INVALID_JSON"
  | "SUPERVISOR_CONFIG_INVALID"
  | "SUPERVISOR_PROFILE_ROOT_REQUIRED"
  | "SUPERVISOR_PROFILE_ROOT_INVALID"
  | "SUPERVISOR_PROFILE_PATH_INVALID"
  | "SUPERVISOR_PROFILE_UNREADABLE"
  | "SUPERVISOR_PROFILE_TOO_LARGE"
  | "SUPERVISOR_PROFILE_INVALID"
  | "SUPERVISOR_PROFILE_IDENTITY_MISMATCH"
  | "SUPERVISOR_RUNTIME_LINK_INVALID";

export class BotSupervisorConfigError extends Error {
  readonly code: BotSupervisorConfigErrorCode;

  constructor(code: BotSupervisorConfigErrorCode, message: string) {
    super(message);
    this.name = "BotSupervisorConfigError";
    this.code = code;
  }
}

export async function loadBotSupervisorConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BotSupervisorConfig> {
  const configuredPath = environment.BOT_SUPERVISOR_CONFIG_PATH?.trim();
  if (!configuredPath) {
    throw new BotSupervisorConfigError(
      "SUPERVISOR_CONFIG_REQUIRED",
      "必须设置 BOT_SUPERVISOR_CONFIG_PATH。",
    );
  }
  const profileRootValue = environment.BOT_SUPERVISOR_PROFILE_ROOT?.trim();
  if (!profileRootValue) {
    throw new BotSupervisorConfigError(
      "SUPERVISOR_PROFILE_ROOT_REQUIRED",
      "必须设置 BOT_SUPERVISOR_PROFILE_ROOT。",
    );
  }

  const source = await readCanonicalFile(
    configuredPath,
    MAX_CONFIG_BYTES,
    "config",
  );
  let input: unknown;
  try {
    input = JSON.parse(source.contents.toString("utf8"));
  } catch {
    throw new BotSupervisorConfigError(
      "SUPERVISOR_CONFIG_INVALID_JSON",
      "Supervisor 配置不是合法 JSON。",
    );
  }
  const parsed = supervisorManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new BotSupervisorConfigError(
      "SUPERVISOR_CONFIG_INVALID",
      `Supervisor 配置校验失败：${parsed.error.issues[0]?.message ?? "未知错误"}`,
    );
  }

  const profileRoot = await resolveProfileRoot(profileRootValue);
  const bots: ResolvedSupervisorBot[] = [];
  const profileIds = new Set<string>();
  for (const bot of parsed.data.bots) {
    const resolved = await resolveBot(bot, profileRoot, environment);
    if (profileIds.has(resolved.profile.id)) {
      throw new BotSupervisorConfigError(
        "SUPERVISOR_PROFILE_INVALID",
        "多个 Bot 不能复用同一个 ServerProfile ID。",
      );
    }
    profileIds.add(resolved.profile.id);
    bots.push(resolved);
  }

  const cpuConfig = loadCpuResourceManagerConfig(environment);
  const warnings = [...cpuConfig.warnings];
  if (cpuConfig.config.botRuntime.mode === "grouped-process") {
    warnings.push("bot_runtime_grouped_process_alias_uses_process_supervisor");
  }

  return Object.freeze({
    schemaVersion: "1.0",
    sourcePath: source.canonicalPath,
    profileRoot,
    process: Object.freeze({ ...cpuConfig.config.botRuntime }),
    restart: Object.freeze({ ...parsed.data.restart }),
    ipc: Object.freeze({ ...parsed.data.ipc }),
    bots: Object.freeze(bots),
    cpuResourceManager: cpuConfig.config,
    warnings: Object.freeze(warnings),
  });
}

async function resolveBot(
  bot: Readonly<{
    botId: string;
    profilePath: string;
    deploymentTier: SupervisorDeploymentTier;
    runtimeLink: Readonly<{
      url: string;
      keyId: string;
      secretEnvironmentVariable: string;
    }>;
  }>,
  profileRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<ResolvedSupervisorBot> {
  if (path.isAbsolute(bot.profilePath)) {
    throw new BotSupervisorConfigError(
      "SUPERVISOR_PROFILE_PATH_INVALID",
      "ServerProfile 路径必须相对于 BOT_SUPERVISOR_PROFILE_ROOT。",
    );
  }
  const profileFile = await readCanonicalFile(
    path.resolve(profileRoot, bot.profilePath),
    MAX_PROFILE_BYTES,
    "profile",
  );
  if (!isPathInside(profileRoot, profileFile.canonicalPath)) {
    throw new BotSupervisorConfigError(
      "SUPERVISOR_PROFILE_PATH_INVALID",
      "ServerProfile 解析后超出允许的配置根目录。",
    );
  }

  let profileInput: unknown;
  try {
    profileInput = JSON.parse(profileFile.contents.toString("utf8"));
  } catch {
    throw new BotSupervisorConfigError(
      "SUPERVISOR_PROFILE_INVALID",
      "ServerProfile 不是合法 JSON。",
    );
  }
  const profileResult = serverProfileSchema.safeParse(profileInput);
  if (!profileResult.success) {
    throw new BotSupervisorConfigError(
      "SUPERVISOR_PROFILE_INVALID",
      `ServerProfile 校验失败：${profileResult.error.issues[0]?.message ?? "未知错误"}`,
    );
  }
  if (profileResult.data.botId !== bot.botId) {
    throw new BotSupervisorConfigError(
      "SUPERVISOR_PROFILE_IDENTITY_MISMATCH",
      "Supervisor Bot ID 与 ServerProfile Bot ID 不一致。",
    );
  }

  let runtimeLink;
  try {
    runtimeLink = loadRuntimeLinkConfig({
      BOT_RUNTIME_LINK_URL: bot.runtimeLink.url,
      BOT_RUNTIME_LINK_KEY_ID: bot.runtimeLink.keyId,
      BOT_RUNTIME_LINK_SECRET:
        environment[bot.runtimeLink.secretEnvironmentVariable],
    });
  } catch (error) {
    if (error instanceof RuntimeLinkConfigError) {
      throw new BotSupervisorConfigError(
        "SUPERVISOR_RUNTIME_LINK_INVALID",
        `Bot ${bot.botId} 的 Runtime Link 配置无效：${error.code}`,
      );
    }
    throw error;
  }

  const assignment: SupervisorBotAssignmentV1 = Object.freeze({
    botId: bot.botId,
    profilePath: profileFile.canonicalPath,
    profileSha256: createHash("sha256")
      .update(profileFile.contents)
      .digest("hex"),
    deploymentTier: bot.deploymentTier,
    runtimeLink: Object.freeze({
      url: runtimeLink.url,
      keyId: runtimeLink.keyId,
      secret: runtimeLink.secret,
    }),
  });
  return Object.freeze({ profile: profileResult.data, assignment });
}

async function resolveProfileRoot(value: string): Promise<string> {
  try {
    const canonicalPath = await realpath(path.resolve(value));
    const information = await stat(canonicalPath);
    if (!information.isDirectory()) throw new Error("not_directory");
    return canonicalPath;
  } catch {
    throw new BotSupervisorConfigError(
      "SUPERVISOR_PROFILE_ROOT_INVALID",
      "BOT_SUPERVISOR_PROFILE_ROOT 不存在、不可读或不是目录。",
    );
  }
}

async function readCanonicalFile(
  value: string,
  maximumBytes: number,
  kind: "config" | "profile",
): Promise<Readonly<{ canonicalPath: string; contents: Buffer }>> {
  let canonicalPath: string;
  let information: Awaited<ReturnType<typeof stat>>;
  try {
    canonicalPath = await realpath(path.resolve(value));
    information = await stat(canonicalPath);
  } catch {
    throw new BotSupervisorConfigError(
      kind === "config"
        ? "SUPERVISOR_CONFIG_UNREADABLE"
        : "SUPERVISOR_PROFILE_UNREADABLE",
      kind === "config"
        ? "Supervisor 配置不存在或不可读。"
        : "ServerProfile 不存在或不可读。",
    );
  }
  if (!information.isFile()) {
    throw new BotSupervisorConfigError(
      kind === "config"
        ? "SUPERVISOR_CONFIG_NOT_REGULAR_FILE"
        : "SUPERVISOR_PROFILE_UNREADABLE",
      kind === "config"
        ? "Supervisor 配置路径不是普通文件。"
        : "ServerProfile 路径不是普通文件。",
    );
  }
  if (information.size > maximumBytes) {
    throw new BotSupervisorConfigError(
      kind === "config"
        ? "SUPERVISOR_CONFIG_TOO_LARGE"
        : "SUPERVISOR_PROFILE_TOO_LARGE",
      kind === "config"
        ? "Supervisor 配置超过 256 KiB 上限。"
        : "ServerProfile 超过 64 KiB 上限。",
    );
  }
  try {
    const contents = await readFile(canonicalPath);
    if (contents.byteLength > maximumBytes) {
      throw new BotSupervisorConfigError(
        kind === "config"
          ? "SUPERVISOR_CONFIG_TOO_LARGE"
          : "SUPERVISOR_PROFILE_TOO_LARGE",
        kind === "config"
          ? "Supervisor 配置超过 256 KiB 上限。"
          : "ServerProfile 超过 64 KiB 上限。",
      );
    }
    return Object.freeze({ canonicalPath, contents });
  } catch (error) {
    if (error instanceof BotSupervisorConfigError) throw error;
    throw new BotSupervisorConfigError(
      kind === "config"
        ? "SUPERVISOR_CONFIG_UNREADABLE"
        : "SUPERVISOR_PROFILE_UNREADABLE",
      kind === "config"
        ? "Supervisor 配置不可读。"
        : "ServerProfile 不可读。",
    );
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function findDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}
