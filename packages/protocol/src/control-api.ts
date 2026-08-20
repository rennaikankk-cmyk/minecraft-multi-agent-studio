import { z } from "zod";

import {
  botConnectionStateSchema,
  botPositionSchema,
  identifierSchema,
  l0SafetyStatusSchema,
  minecraftVersionCompatibilitySchema,
  taskStatusSchema,
} from "./bot-messages.js";
import { skillExecutionResultV1Schema } from "./skill-messages.js";
import {
  teamObjectiveInputV1Schema,
  teamTaskAssignmentInputV1Schema,
  teamTaskAssignmentV1Schema,
} from "./team.js";

const timestampSchema = z.string().datetime({ offset: true });

export const controlApiPermissionSchema = z.enum([
  "bot.read",
  "bot.position.read",
  "bot.stop",
  "task.execute",
  "ai.metrics.read",
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

export const botAiPerformanceV1Schema = z
  .object({
    state: z.enum(["queued", "completed", "waiting", "failed"]),
    observedAt: timestampSchema,
    botId: identifierSchema,
    requestId: z.string().uuid(),
    taskId: identifierSchema.nullable(),
    taskType: identifierSchema,
    provider: identifierSchema.nullable(),
    model: z.string().trim().min(1).max(500).nullable(),
    queueTimeMs: z.number().finite().nonnegative().nullable(),
    providerQueueTimeMs: z.number().finite().nonnegative().nullable(),
    totalLatencyMs: z.number().finite().nonnegative().nullable(),
    timeToFirstTokenMs: z.number().finite().nonnegative().nullable(),
    generationTimeMs: z.number().finite().nonnegative().nullable(),
    meanInterTokenLatencyMs: z.number().finite().nonnegative().nullable(),
    generationTokensPerSecond: z.number().finite().nonnegative().nullable(),
    promptTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    errorCode: identifierSchema.nullable(),
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
    safety: l0SafetyStatusSchema.nullable().optional(),
    aiPerformance: botAiPerformanceV1Schema.nullable().optional(),
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
  "AI_UNAVAILABLE",
  "TASK_REJECTED",
  "TASK_TIMEOUT",
  "AI_METRICS_UNAVAILABLE",
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

export const executeBotTaskHttpRequestV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    taskId: identifierSchema,
    task: z.string().trim().min(1).max(10_000),
    taskVersion: z.number().int().nonnegative().safe(),
    priority: z.number().int().min(0).max(100).default(50),
  })
  .strict();

const executeTaskResponseIdentity = {
  botId: identifierSchema,
  taskId: identifierSchema,
  operationId: z.string().uuid(),
  plannerRequestId: z.string().uuid(),
};

export const executeBotTaskHttpResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    data: z.discriminatedUnion("action", [
      z
        .object({
          ...executeTaskResponseIdentity,
          action: z.literal("wait"),
          provider: identifierSchema,
          model: z.string().trim().min(1).max(512),
          reason: z.string().trim().min(1).max(2_000),
          confidence: z.number().finite().min(0).max(1),
        })
        .strict(),
      z
        .object({
          ...executeTaskResponseIdentity,
          action: z.literal("skill_result"),
          result: skillExecutionResultV1Schema,
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((message, context) => {
    if (
      message.data.action === "skill_result" &&
      (message.data.result.botId !== message.data.botId ||
        message.data.result.taskId !== message.data.taskId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["data", "result"],
        message: "Task result identity does not match the HTTP response.",
      });
    }
  });

export const executeTeamTaskHttpRequestV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    objective: teamObjectiveInputV1Schema,
    assignment: teamTaskAssignmentInputV1Schema,
    task: z.string().trim().min(1).max(10_000),
    taskVersion: z.number().int().nonnegative().safe(),
    priority: z.number().int().min(0).max(100).default(50),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.objective.objectiveId !== request.assignment.objectiveId) {
      context.addIssue({
        code: "custom",
        path: ["assignment", "objectiveId"],
        message: "Team task objective identity does not match.",
      });
    }
  });

const executeTeamTaskResponseIdentity = {
  objectiveId: identifierSchema,
  taskId: identifierSchema,
  operationId: z.string().uuid(),
  plannerRequestId: z.string().uuid(),
  assignment: teamTaskAssignmentV1Schema,
};

export const executeTeamTaskHttpResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    data: z.discriminatedUnion("action", [
      z
        .object({
          ...executeTeamTaskResponseIdentity,
          action: z.literal("wait"),
          provider: identifierSchema,
          model: z.string().trim().min(1).max(512),
          reason: z.string().trim().min(1).max(2_000),
          confidence: z.number().finite().min(0).max(1),
        })
        .strict(),
      z
        .object({
          ...executeTeamTaskResponseIdentity,
          action: z.literal("skill_result"),
          result: skillExecutionResultV1Schema,
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((message, context) => {
    const { data } = message;
    if (
      data.assignment.objectiveId !== data.objectiveId ||
      data.assignment.taskId !== data.taskId
    ) {
      context.addIssue({
        code: "custom",
        path: ["data", "assignment"],
        message: "Team assignment identity does not match the HTTP response.",
      });
    }
    if (
      data.action === "skill_result" &&
      (data.result.botId !== data.assignment.botId ||
        data.result.taskId !== data.taskId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["data", "result"],
        message: "Team task result identity does not match the HTTP response.",
      });
    }
  });

export type ControlApiPermission = z.infer<typeof controlApiPermissionSchema>;
export type BotAiPerformanceV1 = z.infer<typeof botAiPerformanceV1Schema>;
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
export type ExecuteBotTaskHttpRequestV1 = z.infer<
  typeof executeBotTaskHttpRequestV1Schema
>;
export type ExecuteBotTaskHttpResponseV1 = z.infer<
  typeof executeBotTaskHttpResponseV1Schema
>;
export type ExecuteTeamTaskHttpRequestV1 = z.infer<
  typeof executeTeamTaskHttpRequestV1Schema
>;
export type ExecuteTeamTaskHttpResponseV1 = z.infer<
  typeof executeTeamTaskHttpResponseV1Schema
>;
