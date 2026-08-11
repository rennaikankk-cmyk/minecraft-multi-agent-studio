import { z } from "zod";

import { identifierSchema } from "./bot-messages.js";
import { skillVersionSchema } from "./skill-messages.js";

const utcTimestampSchema = z.string().datetime({ offset: false });
const safeRevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const taskDispatchTaskTypeSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/u);

export const taskQueueSourceSchema = z
  .object({
    service: z.literal("coordinator"),
    instanceId: identifierSchema,
  })
  .strict();

export const taskDispatchV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    messageId: z.string().uuid(),
    traceId: identifierSchema,
    timestamp: utcTimestampSchema,
    source: taskQueueSourceSchema,
    taskId: z.string().uuid(),
    botId: identifierSchema,
    type: z.literal("task.dispatch.v1"),
    payload: z
      .object({
        expectedRevision: safeRevisionSchema,
        taskType: taskDispatchTaskTypeSchema,
        handlerVersion: skillVersionSchema,
        executionIdempotent: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type TaskDispatchV1 = z.infer<typeof taskDispatchV1Schema>;

export function parseTaskDispatch(input: unknown): TaskDispatchV1 {
  return taskDispatchV1Schema.parse(input);
}
