import { z } from "zod";

import {
  botConnectionStateSchema,
  botPositionSchema,
  identifierSchema,
  minecraftVersionCompatibilitySchema,
  taskStatusSchema,
} from "./bot-messages.js";

const timestampSchema = z.string().datetime({ offset: true });

export const controlApiPermissionSchema = z.enum([
  "bot.read",
  "bot.position.read",
  "bot.stop",
]);

export const publicBotSummaryV1Schema = z
  .object({
    botId: identifierSchema,
    connectionState: botConnectionStateSchema,
    lastMessageAt: timestampSchema,
    lastHeartbeatAt: timestampSchema.nullable(),
    lastStatusAt: timestampSchema.nullable(),
  })
  .strict();

const publicTaskSchema = z
  .object({
    taskId: identifierSchema,
    title: z.string().trim().min(1).max(200),
    status: taskStatusSchema,
    startedAt: timestampSchema.nullable(),
  })
  .strict();

export const publicBotDetailV1Schema = publicBotSummaryV1Schema
  .extend({
    health: z
      .object({
        current: z.number().finite().nonnegative(),
        maximum: z.number().finite().positive().nullable(),
      })
      .strict()
      .nullable(),
    food: z
      .object({
        level: z.number().int().min(0).max(20),
        saturation: z.number().finite().min(0).max(20),
      })
      .strict()
      .nullable(),
    armorPoints: z.number().int().min(0).max(20).nullable(),
    latencyMs: z.number().int().nonnegative().max(120_000).nullable(),
    currentTask: publicTaskSchema.nullable(),
    position: botPositionSchema.nullable(),
    positionRedacted: z.boolean(),
    minecraftVersion: minecraftVersionCompatibilitySchema.nullable(),
  })
  .strict();

export const botListResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    data: z
      .object({
        generatedAt: timestampSchema,
        bots: z.array(publicBotSummaryV1Schema),
      })
      .strict(),
  })
  .strict();

export const botDetailResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    data: z
      .object({
        generatedAt: timestampSchema,
        bot: publicBotDetailV1Schema,
      })
      .strict(),
  })
  .strict();

export const controlApiErrorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "PERMISSION_DENIED",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "BOT_NOT_FOUND",
  "ROUTE_NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "UNSUPPORTED_SCHEMA_VERSION",
  "BOT_NOT_STOPPABLE",
  "CONTROL_UNAVAILABLE",
  "STOP_TIMEOUT",
  "STOP_FAILED",
  "INTERNAL_ERROR",
]);

export const controlApiErrorV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    error: z
      .object({
        code: controlApiErrorCodeSchema,
        message: z.string().trim().min(1).max(200),
      })
      .strict(),
  })
  .strict();

const streamEnvelope = {
  schemaVersion: z.literal("1.0"),
  messageId: z.string().uuid(),
  timestamp: timestampSchema,
  streamSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};

export const botStreamSnapshotV1Schema = z
  .object({
    ...streamEnvelope,
    type: z.literal("bot.stream.snapshot.v1"),
    payload: z
      .object({
        bots: z.array(publicBotDetailV1Schema),
      })
      .strict(),
  })
  .strict();

export const botStreamEventV1Schema = z
  .object({
    ...streamEnvelope,
    type: z.literal("bot.stream.event.v1"),
    payload: z
      .object({
        event: z.literal("upsert"),
        bot: publicBotDetailV1Schema,
      })
      .strict(),
  })
  .strict();

export const stopBotHttpRequestV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    confirmation: z.literal("confirmed"),
  })
  .strict();

export const stopBotHttpResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    data: z
      .object({
        botId: identifierSchema,
        traceId: z.string().uuid(),
        commandId: z.string().uuid(),
        outcome: z.enum(["completed", "rejected", "failed"]),
        errorCode: z.string().trim().min(1).max(100).nullable(),
      })
      .strict(),
  })
  .strict();

export type ControlApiPermission = z.infer<typeof controlApiPermissionSchema>;
export type PublicBotSummaryV1 = z.infer<typeof publicBotSummaryV1Schema>;
export type PublicBotDetailV1 = z.infer<typeof publicBotDetailV1Schema>;
export type BotListResponseV1 = z.infer<typeof botListResponseV1Schema>;
export type BotDetailResponseV1 = z.infer<typeof botDetailResponseV1Schema>;
export type ControlApiErrorCode = z.infer<typeof controlApiErrorCodeSchema>;
export type ControlApiErrorV1 = z.infer<typeof controlApiErrorV1Schema>;
export type BotStreamSnapshotV1 = z.infer<typeof botStreamSnapshotV1Schema>;
export type BotStreamEventV1 = z.infer<typeof botStreamEventV1Schema>;
export type StopBotHttpRequestV1 = z.infer<typeof stopBotHttpRequestV1Schema>;
export type StopBotHttpResponseV1 = z.infer<typeof stopBotHttpResponseV1Schema>;
