import { z } from "zod";

import {
  identifierSchema,
  taskStatusSchema,
} from "./bot-messages.js";

const timestampSchema = z.string().max(35).datetime({ offset: true });
const taskTypeSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/u);
const reasonCodeSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/u);

// A page must fit inside the fixed 64 KiB Control Link frame even when every
// bounded text field is at its maximum encoded size.
export const CONTROL_LINK_MAX_TASK_HISTORY_ITEMS = 32;

export const taskRiskLevelSchema = z.enum(["R0", "R1", "R2", "R3", "R4"]);

export const taskHistoryCursorSchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const taskHistoryListQueryV1Schema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(CONTROL_LINK_MAX_TASK_HISTORY_ITEMS),
    cursor: taskHistoryCursorSchema.nullable(),
    status: taskStatusSchema.nullable(),
    botId: identifierSchema.nullable(),
  })
  .strict();

export const publicTaskSummaryV1Schema = z
  .object({
    taskId: z.string().uuid(),
    taskType: taskTypeSchema,
    title: z.string().trim().min(1).max(200),
    status: taskStatusSchema,
    priority: z.number().int().min(0).max(100),
    riskLevel: taskRiskLevelSchema,
    botId: identifierSchema.nullable(),
    failureReason: reasonCodeSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    finishedAt: timestampSchema.nullable(),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const publicTaskDetailV1Schema = publicTaskSummaryV1Schema
  .extend({
    operatorGoal: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine(
        (value) =>
          !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value),
        "Operator goal contains unsupported control characters.",
      )
      .nullable(),
  })
  .strict();

export const taskHistoryListPageV1Schema = z
  .object({
    generatedAt: timestampSchema,
    tasks: z
      .array(publicTaskSummaryV1Schema)
      .max(CONTROL_LINK_MAX_TASK_HISTORY_ITEMS),
    nextCursor: taskHistoryCursorSchema.nullable(),
  })
  .strict();

export type TaskHistoryListQueryV1 = z.infer<
  typeof taskHistoryListQueryV1Schema
>;
export type TaskHistoryListPageV1 = z.infer<
  typeof taskHistoryListPageV1Schema
>;
export type PublicTaskSummaryV1 = z.infer<typeof publicTaskSummaryV1Schema>;
export type PublicTaskDetailV1 = z.infer<typeof publicTaskDetailV1Schema>;
