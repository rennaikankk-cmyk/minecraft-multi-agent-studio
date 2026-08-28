import { z } from "zod";

import { identifierSchema, minecraftVersionStringSchema } from "./bot-messages.js";

const timestampSchema = z.string().datetime({ offset: true });

export const studioAiProviderSchema = z.enum(["vllm", "ollama"]);
export const studioAiStateSchema = z.enum([
  "connected",
  "unavailable",
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
  })
  .strict();

export const studioManagedBotProcessStateSchema = z.enum([
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);

export const studioManagedBotV1Schema = z
  .object({
    botId: identifierSchema,
    username: z
      .string()
      .min(3)
      .max(16)
      .regex(/^[A-Za-z0-9_]+$/u),
    serverHost: z.string().trim().min(1).max(253),
    serverPort: z.number().int().min(1).max(65_535),
    minecraftVersion: z.union([z.literal("auto"), minecraftVersionStringSchema]),
    processState: studioManagedBotProcessStateSchema,
    pid: z.number().int().positive().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    lastError: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export const studioManagerStatusV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    generatedAt: timestampSchema,
    ai: studioAiStatusV1Schema,
    bots: z.array(studioManagedBotV1Schema).max(16),
    capabilities: z
      .object({
        createBot: z.boolean(),
        maxBots: z.number().int().min(0).max(16),
      })
      .strict(),
  })
  .strict();

export const studioCreateBotRequestV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    username: z
      .string()
      .min(3)
      .max(16)
      .regex(/^[A-Za-z0-9_]+$/u),
    serverHost: z.string().trim().min(1).max(253),
    serverPort: z.number().int().min(1).max(65_535),
    minecraftVersion: z.union([z.literal("auto"), minecraftVersionStringSchema]),
  })
  .strict();

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
export type StudioManagedBotResponseV1 = z.infer<
  typeof studioManagedBotResponseV1Schema
>;
export type StudioManagerErrorCode = z.infer<
  typeof studioManagerErrorCodeSchema
>;
