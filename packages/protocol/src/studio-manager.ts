import { z } from "zod";

import { botIdentitySchema, identifierSchema, minecraftVersionStringSchema } from "./bot-messages.js";

const timestampSchema = z.string().datetime({ offset: true });

export const studioAiProviderSchema = z.enum(["vllm", "ollama", "openai-compatible"]);
export const studioAiStateSchema = z.enum([
  "connected",
  "degraded",
  "unavailable",
  "misconfigured",
  "disabled",
]);

export const studioAiStatusV1Schema = z
  .object({
    state: studioAiStateSchema,
    source: z.enum(["explicit", "discovered", "disabled"]),
    provider: studioAiProviderSchema.nullable(),
    baseUrl: z.string().url().max(2_048).nullable(),
    model: z.string().trim().min(1).max(256).nullable(),
    models: z.array(z.string().trim().min(1).max(256)).max(64),
    latencyMs: z.number().int().nonnegative().max(120_000).nullable(),
    lastCheckedAt: timestampSchema,
    message: z.string().trim().min(1).max(300),
    /**
     * P0-5 并发可观测性（可选，向后兼容）：configured = 显式配置值；
     * effective = 实际生效值；capacityProfileSource 说明依据
     * （measured@N 实测 / explicit-config 显式 / conservative-default 保守默认）。
     */
    concurrency: z
      .object({
        configuredMaxConcurrency: z.number().int().min(1).max(64),
        effectiveMaxConcurrency: z.number().int().min(1).max(64),
        capacityProfileSource: z.string().trim().min(1).max(120),
        testedConcurrency: z.number().int().min(0).max(64).nullable(),
        testedAt: timestampSchema.nullable(),
        testedModel: z.string().trim().min(1).max(256).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const studioManagedBotProcessStateSchema = z.enum([
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);

export const studioMinecraftAuthSchema = z.enum(["offline", "online"]);

export const studioManagedBotV1Schema = z
  .object({
    botId: botIdentitySchema,
    username: z
      .string()
      .min(3)
      .max(16)
      .regex(/^[A-Za-z0-9_]+$/u),
    serverHost: z.string().trim().min(1).max(253),
    serverPort: z.number().int().min(1).max(65_535),
    /** World generation identifier; omitted when unknown, independent of dimension. */
    worldId: identifierSchema.optional(),
    minecraftVersion: z.union([z.literal("auto"), minecraftVersionStringSchema]),
    /** Authentication mode; omitted by legacy clients and defaults to offline. */
    auth: studioMinecraftAuthSchema.optional(),
    /** 外部公网服务器（无规则服）用途；缺省 = 本地/局域网 managed。 */
    purpose: z.literal("anarchy").optional(),
    /** Authenticated Java profile UUID, normalized to lowercase compact hex. */
    gameProfileId: z.string().regex(/^[a-f0-9]{32}$/u).optional(),
    /** TCP 目的地址覆盖（可选）；握手 hostname 恒为 serverHost。 */
    connectHost: z.string().trim().min(1).max(253).optional(),
    processState: studioManagedBotProcessStateSchema,
    pid: z.number().int().positive().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    lastError: z.string().trim().min(1).max(500).nullable(),
    /** P0-2 退出分类：最近一次进程退出的显式语义与证据（未退出过则缺省）。 */
    exit: z
      .object({
        classification: z.enum([
          "EXPECTED_STOP",
          "EXPECTED_RESTART",
          "GRACEFUL_SHUTDOWN",
          "FORCED_STOP_TIMEOUT",
          "STARTUP_FAILURE",
          "EXTERNAL_TERMINATION",
          "UNEXPECTED_CRASH",
        ]),
        requestedAction: z.enum(["stop", "restart"]).nullable(),
        requestedBy: z.string().trim().min(1).max(120).nullable(),
        requestedAt: timestampSchema.nullable(),
        shutdownDeadlineMs: z.number().int().min(0).nullable(),
        forcedKillAt: timestampSchema.nullable(),
        pid: z.number().int().nullable(),
        exitCode: z.number().int().nullable(),
        exitSignal: z.string().trim().min(1).max(16).nullable(),
        ready: z.boolean(),
        uptimeMs: z.number().int().min(0).nullable(),
        observedAt: timestampSchema,
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const studioManagerStatusV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    generatedAt: timestampSchema,
    ai: studioAiStatusV1Schema,
    bots: z.array(studioManagedBotV1Schema).max(16),
    /** manager 进程 ownership 身份（local test server labels / 元数据）。 */
    sessionId: z.string().min(1).max(120).optional(),
    capabilities: z
      .object({
        createBot: z.boolean(),
        maxBots: z.number().int().min(0).max(16),
        /** capability honesty：前端按这里声明渲染（可选，向后兼容）。 */
        incidentExport: z
          .object({
            json: z.boolean(),
            markdown: z.boolean(),
            zipBundle: z.boolean(),
            repairPrompt: z.boolean(),
          })
          .strict()
          .optional(),
        localTestServer: z
          .object({
            start: z.boolean(),
            stop: z.boolean(),
            restart: z.boolean(),
            resetWorld: z.boolean(),
            logs: z.boolean(),
          })
          .strict()
          .optional(),
        incidentQuery: z
          .object({
            filters: z.boolean(),
            issueOccurrences: z.boolean(),
            occurrenceDetail: z.boolean(),
            statusTransition: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    /** IncidentStore writer 健康（信息性 passthrough）。 */
    incidents: z.record(z.string(), z.unknown()).nullable().optional(),
    /** Round 7/8 起 manager 即返回的字段（dashboard 只做展示投影，不在此强类型化）。 */
    gameplayPolicy: z.unknown().optional(),
    compatibility: z.unknown().optional(),
  })
  .strict();

const studioCreateBotFields = {
    schemaVersion: z.literal("1.0"),
    serverHost: z.string().trim().min(1).max(253),
    serverPort: z.number().int().min(1).max(65_535),
    /** Explicit world generation identity; do not infer from game dimension. */
    worldId: identifierSchema.optional(),
    minecraftVersion: z.union([z.literal("auto"), minecraftVersionStringSchema]),
    /** TCP 目的地址覆盖（可选）；握手 hostname 恒为 serverHost。 */
    connectHost: z.string().trim().min(1).max(253).optional(),
    /** 外部公网服务器（无规则服）：公网地址必须显式声明该用途才放行。 */
    purpose: z.literal("anarchy").optional(),
};
const studioUsernameSchema = z.string().min(3).max(16).regex(/^[A-Za-z0-9_]+$/u);

export const studioCreateBotRequestV1Schema = z.union([
  z.object({
    ...studioCreateBotFields,
    /** Omitted by legacy clients; Manager defaults to offline. */
    auth: z.literal("offline").optional(),
    username: studioUsernameSchema,
  }).strict(),
  z.object({
    ...studioCreateBotFields,
    auth: z.literal("online"),
    /** Opaque lookup key only; never a Microsoft email, password or game name. */
    accountRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
    /** Legacy claimed name is accepted but never used to bind online identity. */
    username: studioUsernameSchema.optional(),
  }).strict(),
]);

export const studioManagedBotResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    generatedAt: timestampSchema,
    bot: studioManagedBotV1Schema,
  })
  .strict();

export const studioManagerErrorCodeSchema = z.enum([
  "MANAGER_NOT_CONFIGURED",
  "MANAGER_UNAVAILABLE",
  "AUTH_REQUIRED",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "BOT_LIMIT_REACHED",
  "BOT_CONFLICT",
  "BOT_NOT_FOUND",
  "BOT_START_FAILED",
  "INTERNAL_ERROR",
]);

export const studioManagerErrorV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    error: z
      .object({
        code: studioManagerErrorCodeSchema,
        message: z.string().trim().min(1).max(300),
      })
      .strict(),
  })
  .strict();

export type StudioAiStatusV1 = z.infer<typeof studioAiStatusV1Schema>;
export type StudioManagedBotV1 = z.infer<typeof studioManagedBotV1Schema>;
export type StudioManagerStatusV1 = z.infer<typeof studioManagerStatusV1Schema>;
export type StudioCreateBotRequestV1 = z.infer<
  typeof studioCreateBotRequestV1Schema
>;
export type StudioMinecraftAuth = z.infer<typeof studioMinecraftAuthSchema>;
export type StudioManagedBotResponseV1 = z.infer<
  typeof studioManagedBotResponseV1Schema
>;
export type StudioManagerErrorCode = z.infer<
  typeof studioManagerErrorCodeSchema
>;
