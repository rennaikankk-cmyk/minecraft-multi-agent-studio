import { z } from "zod";

import {
  botConnectionStateSchema,
  botPositionSchema,
  combatRuntimeStatusV1Schema,
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
import {
  publicTaskDetailV1Schema,
  taskHistoryListPageV1Schema,
} from "./task-history.js";

const timestampSchema = z.string().datetime({ offset: true });

export const controlApiPermissionSchema = z.enum([
  "bot.read",
  "bot.position.read",
  "bot.stop",
  "goal.submit",
  "task.read",
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
    attempts: z.number().int().min(0).max(5),
    queueTimeMs: z.number().int().nonnegative().max(10 * 60_000),
    executionTimeMs: z.number().int().nonnegative().max(10 * 60_000),
    totalTimeMs: z.number().int().nonnegative().max(10 * 60_000),
  })
  .strict();

/**
 * The numeric counts a completed Skill may publish about what it actually did.
 *
 * Allow-listed by name rather than passed through, because a Skill output also
 * carries block names and world coordinates, and the goal response is an
 * operator-facing channel that must not become wider than the prompt boundary
 * the Coordinator already guards. Every name here denotes a count, so together
 * they answer "how much happened" without saying where.
 */
const GOAL_RESULT_SUMMARY_KEYS = Object.freeze([
  "targetsFound",
  "itemsCollected",
  "requestedCount",
  "craftedCount",
  "movedCount",
  "smeltedCount",
  "changedCount",
  "capabilityCallCount",
  "distanceToTarget",
  "totalScoreBefore",
  "totalScoreAfter",
] as const);

const goalResultCountSchema = z
  .number()
  .finite()
  .min(-1_000_000)
  .max(1_000_000);

/**
 * At least one count must be present. "The Skill published no counts" is
 * expressed by omitting the field entirely, so an empty object would be a
 * second spelling of the same fact and a consumer would have to handle both.
 */
const goalResultSummarySchema = z
  .object(
    Object.fromEntries(
      GOAL_RESULT_SUMMARY_KEYS.map((key) => [
        key,
        goalResultCountSchema.optional(),
      ]),
    ) as {
      [Key in (typeof GOAL_RESULT_SUMMARY_KEYS)[number]]: z.ZodOptional<
        typeof goalResultCountSchema
      >;
    },
  )
  .strict()
  .refine(
    (value) => Object.values(value).some((count) => count !== undefined),
    "A goal result summary must carry at least one count.",
  );

/**
 * Extracts the allow-listed counts from a Skill's own output, or undefined when
 * it published none.
 *
 * The transport must not restate these numbers or derive them: `itemsCollected`
 * is a fact only the Skill observed. Anything absent, non-numeric, or outside
 * the allow-list is dropped rather than coerced, so a summary that arrives is
 * always the Skill's own report.
 */
export function goalResultSummaryFromOutput(
  output: unknown,
): GoalResultSummaryV1 | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return undefined;
  }
  const record = output as Record<string, unknown>;
  const summary: Record<string, number> = {};
  for (const key of GOAL_RESULT_SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      summary[key] = value;
    }
  }
  const parsed = goalResultSummarySchema.safeParse(summary);
  return parsed.success ? parsed.data : undefined;
}

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
    /**
     * Optional because two different facts must stay distinguishable — a Skill
     * that published no counts, and a goal recorded before this field existed.
     * Persisted results are re-parsed with the current schema on read-back, so a
     * required field here would make every historical row unreadable.
     *
     * Only the completed branch carries it: an unsuccessful payload has an error
     * code where its output would be, so there are no counts to report.
     */
    summary: goalResultSummarySchema.optional(),
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

/**
 * Round 6.6 注册屏障：Bot 尚未 goal-ready（runtime-link 未注册 / MC 未上线 /
 * skill catalog 未达）时，goal 不是被拒绝，而是**持久等待**——提交方拿到
 * 202 + waiting_for_bot（含截止时间），Bot ready 后自动派发一次。
 * 这是状态/事件语义，不是失败；真正超时走 GOAL_EXPIRED_WAITING_FOR_BOT。
 */
const goalDispatchWaitingV1Schema = z
  .object({
    action: z.literal("waiting_for_bot"),
    botId: identifierSchema,
    taskId: identifierSchema,
    reasonCode: z.literal("GOAL_WAITING_FOR_BOT"),
    /** 等待截止（epoch ms）= 提交时间 + 提交方 timeoutMs；到期诚实终态。 */
    expiresAtMs: z.number().int().min(0),
  })
  .strict();

/** 可持久化的终态结果（waiting 回执绝不落库）。 */
export const goalDispatchTerminalResultV1Schema = z.union([
  goalDispatchNoopV1Schema,
  goalSkillResultV1Schema,
]);
export type GoalDispatchTerminalResultV1 = z.infer<
  typeof goalDispatchTerminalResultV1Schema
>;

export const goalDispatchResultV1Schema = z.union([
  goalDispatchTerminalResultV1Schema,
  goalDispatchWaitingV1Schema,
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
    combat: combatRuntimeStatusV1Schema.nullable(),
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

export const taskListResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    data: taskHistoryListPageV1Schema,
  })
  .strict();

export const taskDetailResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    data: z
      .object({
        generatedAt: timestampSchema,
        task: publicTaskDetailV1Schema,
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
  "TASK_NOT_FOUND",
  "ROUTE_NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "UNSUPPORTED_SCHEMA_VERSION",
  "BOT_NOT_STOPPABLE",
  "CONTROL_UNAVAILABLE",
  "TASK_HISTORY_UNAVAILABLE",
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
export type TaskListResponseV1 = z.infer<typeof taskListResponseV1Schema>;
export type TaskDetailResponseV1 = z.infer<typeof taskDetailResponseV1Schema>;
export type ControlApiErrorCode = z.infer<typeof controlApiErrorCodeSchema>;
export type ControlApiErrorV1 = z.infer<typeof controlApiErrorV1Schema>;
export type BotStreamSnapshotV1 = z.infer<typeof botStreamSnapshotV1Schema>;
export type BotStreamEventV1 = z.infer<typeof botStreamEventV1Schema>;
export type GoalResultSummaryV1 = z.infer<typeof goalResultSummarySchema>;
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
      /**
       * Present only on a completed outcome, and only when the Skill published
       * counts. This flat view cannot express that, so it stays optional here
       * and the runtime schema enforces the narrower rule.
       */
      summary?: GoalResultSummaryV1 | undefined;
      ai: z.infer<typeof goalAiTimingSchema>;
    };
export type SubmitGoalHttpRequestV1 = z.infer<typeof submitGoalHttpRequestV1Schema>;
export type SubmitGoalHttpResponseV1 = z.infer<typeof submitGoalHttpResponseV1Schema>;
