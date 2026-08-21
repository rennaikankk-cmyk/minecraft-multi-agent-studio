import { z } from "zod";

import {
  botConnectionStateSchema,
  botPositionSchema,
  identifierSchema,
  l0SafetyStatusSchema,
  minecraftVersionCompatibilitySchema,
  taskStatusSchema,
} from "./bot-messages.js";
import {
  skillErrorCodeSchema,
} from "./skill-messages.js";
import {
  skillIdentifierSchema,
  skillVersionSchema,
} from "./skill-identifiers.js";

const timestampSchema = z.string().datetime({ offset: true });

export const controlApiPermissionSchema = z.enum([
  "bot.read",
  "bot.position.read",
  "bot.stop",
  "goal.submit",
]);

const reasonCodeSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/u);

const goalTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value),
    "Goal contains unsupported control characters.",
  );

const goalAiTimingSchema = z
  .object({
    attempts: z.number().int().min(1).max(5),
    queueTimeMs: z.number().int().nonnegative().max(10 * 60_000),
    executionTimeMs: z.number().int().nonnegative().max(10 * 60_000),
    totalTimeMs: z.number().int().nonnegative().max(10 * 60_000),
  })
  .strict();

const goalDispatchNoopV1Schema = z
  .object({
    action: z.literal("noop"),
    botId: identifierSchema,
    taskId: identifierSchema,
    reasonCode: reasonCodeSchema,
    ai: goalAiTimingSchema,
  })
  .strict();

const goalSkillResultCommonShape = {
  action: z.literal("skill_result"),
  botId: identifierSchema,
  taskId: identifierSchema,
  reasonCode: reasonCodeSchema,
  skillId: skillIdentifierSchema,
  skillVersion: skillVersionSchema,
  ai: goalAiTimingSchema,
};

const goalSkillResultCompletedV1Schema = z
  .object({
    ...goalSkillResultCommonShape,
    outcome: z.literal("completed"),
    // Keep the property available to consumers as `undefined`, while
    // rejecting an explicitly supplied error code on successful outcomes.
    errorCode: z.never().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.prototype.hasOwnProperty.call(value, "errorCode")) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "A completed goal result cannot contain an error code.",
      });
    }
  });

const goalSkillResultRejectedV1Schema = z
  .object({
    ...goalSkillResultCommonShape,
    outcome: z.literal("rejected"),
    errorCode: skillErrorCodeSchema,
  })
  .strict();

const goalSkillResultFailedV1Schema = z
  .object({
    ...goalSkillResultCommonShape,
    outcome: z.literal("failed"),
    errorCode: skillErrorCodeSchema,
  })
  .strict();

const goalSkillResultCancelledV1Schema = z
  .object({
    ...goalSkillResultCommonShape,
    outcome: z.literal("cancelled"),
    errorCode: skillErrorCodeSchema,
  })
  .strict();

const goalSkillResultTimedOutV1Schema = z
  .object({
    ...goalSkillResultCommonShape,
    outcome: z.literal("timed_out"),
    errorCode: skillErrorCodeSchema,
  })
  .strict();

const goalSkillResultV1Schema = z.discriminatedUnion("outcome", [
  goalSkillResultCompletedV1Schema,
  goalSkillResultRejectedV1Schema,
  goalSkillResultFailedV1Schema,
  goalSkillResultCancelledV1Schema,
  goalSkillResultTimedOutV1Schema,
]);

export const goalDispatchResultV1Schema = z.union([
  goalDispatchNoopV1Schema,
  goalSkillResultV1Schema,
]);

export const submitGoalHttpRequestV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    botId: identifierSchema,
    operatorGoal: goalTextSchema,
    timeoutMs: z.number().int().min(1_000).max(120_000),
  })
  .strict();

export const submitGoalHttpResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    data: goalDispatchResultV1Schema,
  })
  .strict();

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
    safety: l0SafetyStatusSchema.nullable().optional(),
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
  "AI_QUEUE_FULL",
  "GOAL_TIMEOUT",
  "GOAL_REJECTED",
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
/**
 * Consumer-facing result type deliberately keeps the historical nullable
 * errorCode shape. Runtime parsing is stricter: completed outcomes reject the
 * field and every unsuccessful outcome requires a stable Skill error code.
 * Keeping this compatibility view lets transports normalize a result from the
 * Skill execution union without unsafe outcome/error-code casts.
 */
export type GoalDispatchResultV1 =
  | z.infer<typeof goalDispatchNoopV1Schema>
  | {
      action: "skill_result";
      botId: z.infer<typeof identifierSchema>;
      taskId: z.infer<typeof identifierSchema>;
      reasonCode: z.infer<typeof reasonCodeSchema>;
      skillId: z.infer<typeof skillIdentifierSchema>;
      skillVersion: z.infer<typeof skillVersionSchema>;
      outcome: "completed" | "rejected" | "failed" | "cancelled" | "timed_out";
      errorCode?: z.infer<typeof skillErrorCodeSchema> | null | undefined;
      ai: z.infer<typeof goalAiTimingSchema>;
    };
export type SubmitGoalHttpRequestV1 = z.infer<typeof submitGoalHttpRequestV1Schema>;
export type SubmitGoalHttpResponseV1 = z.infer<typeof submitGoalHttpResponseV1Schema>;
