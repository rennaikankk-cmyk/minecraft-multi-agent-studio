import { z } from "zod";

import { identifierSchema } from "./bot-messages.js";
import {
  skillIdentifierSchema,
  skillVersionSchema,
} from "./skill-identifiers.js";

export { skillIdentifierSchema, skillVersionSchema } from "./skill-identifiers.js";

const timestampSchema = z.string().datetime({ offset: true });
const MAX_INVOCATION_LIFETIME_MS = 5 * 60_000;

export const skillCapabilitySchema = z.enum([
  "bot.observe",
  "bot.move",
  "combat.control",
  "world.read",
  "world.interact",
  "inventory.read",
  "inventory.write",
  "craft.execute",
  "container.read",
  "container.write",
]);

export const skillOperationSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/u);

export const skillErrorCodeSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/u);

export const skillJsonValueSchema = z.json();

const skillAuthorizationReferenceSchema = z
  .object({
    decisionId: z.string().uuid(),
    actorId: identifierSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export const skillInvocationV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    messageId: z.string().uuid(),
    traceId: identifierSchema,
    timestamp: timestampSchema,
    source: z
      .object({
        service: z.literal("coordinator"),
        instanceId: identifierSchema,
      })
      .strict(),
    botId: identifierSchema,
    taskId: identifierSchema,
    type: z.literal("skill.invoke.v1"),
    payload: z
      .object({
        invocationId: z.string().uuid(),
        skillId: skillIdentifierSchema,
        skillVersion: skillVersionSchema,
        expiresAt: timestampSchema,
        input: skillJsonValueSchema,
        authorization: skillAuthorizationReferenceSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const requestedAt = Date.parse(message.timestamp);
    const expiresAt = Date.parse(message.payload.expiresAt);
    const authorizationIssuedAt = Date.parse(
      message.payload.authorization.issuedAt,
    );
    const authorizationExpiresAt = Date.parse(
      message.payload.authorization.expiresAt,
    );

    if (expiresAt <= requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["payload", "expiresAt"],
        message: "Skill invocation expiry must be after its timestamp.",
      });
    }
    if (expiresAt - requestedAt > MAX_INVOCATION_LIFETIME_MS) {
      context.addIssue({
        code: "custom",
        path: ["payload", "expiresAt"],
        message: "Skill invocation lifetime exceeds the five minute boundary.",
      });
    }
    if (authorizationIssuedAt > requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["payload", "authorization", "issuedAt"],
        message: "Authorization cannot be issued after the invocation.",
      });
    }
    if (authorizationExpiresAt < expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["payload", "authorization", "expiresAt"],
        message: "Authorization must cover the invocation lifetime.",
      });
    }
  });

export const skillCancellationReasonSchema = z.enum([
  "caller_cancelled",
  "request_superseded",
  "task_cancelled",
  "coordinator_shutdown",
]);

export const skillCancellationV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    messageId: z.string().uuid(),
    traceId: identifierSchema,
    timestamp: timestampSchema,
    source: z
      .object({
        service: z.literal("coordinator"),
        instanceId: identifierSchema,
      })
      .strict(),
    botId: identifierSchema,
    taskId: identifierSchema,
    type: z.literal("skill.cancel.v1"),
    payload: z
      .object({
        invocationId: z.string().uuid(),
        reason: skillCancellationReasonSchema,
        expiresAt: timestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const requestedAt = Date.parse(message.timestamp);
    const expiresAt = Date.parse(message.payload.expiresAt);
    if (expiresAt <= requestedAt || expiresAt - requestedAt > 60_000) {
      context.addIssue({
        code: "custom",
        path: ["payload", "expiresAt"],
        message: "Skill cancellation must expire within one minute.",
      });
    }
  });

const skillResultBaseShape = {
  invocationId: z.string().uuid(),
  skillId: skillIdentifierSchema,
  skillVersion: skillVersionSchema,
  completedAt: timestampSchema,
};

const unsuccessfulSkillResultPayload = (
  outcome: "rejected" | "failed" | "cancelled" | "timed_out",
) =>
  z
    .object({
      ...skillResultBaseShape,
      outcome: z.literal(outcome),
      attempts: z.number().int().min(0).max(5),
      errorCode: skillErrorCodeSchema,
    })
    .strict();

export const skillExecutionResultV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    messageId: z.string().uuid(),
    traceId: identifierSchema,
    timestamp: timestampSchema,
    source: z
      .object({
        service: z.literal("bot-runtime"),
        instanceId: identifierSchema,
      })
      .strict(),
    botId: identifierSchema,
    taskId: identifierSchema,
    type: z.literal("skill.result.v1"),
    payload: z.discriminatedUnion("outcome", [
      z
        .object({
          ...skillResultBaseShape,
          outcome: z.literal("completed"),
          attempts: z.number().int().min(1).max(5),
          output: skillJsonValueSchema,
        })
        .strict(),
      unsuccessfulSkillResultPayload("rejected"),
      unsuccessfulSkillResultPayload("failed"),
      unsuccessfulSkillResultPayload("cancelled"),
      unsuccessfulSkillResultPayload("timed_out"),
    ]),
  })
  .strict();

export type SkillCapability = z.infer<typeof skillCapabilitySchema>;
export type SkillCancellationReason = z.infer<typeof skillCancellationReasonSchema>;
export type SkillCancellationV1 = z.infer<typeof skillCancellationV1Schema>;
export type SkillInvocationV1 = z.infer<typeof skillInvocationV1Schema>;
export type SkillExecutionResultV1 = z.infer<
  typeof skillExecutionResultV1Schema
>;
export type SkillJsonValue = z.infer<typeof skillJsonValueSchema>;

export function parseSkillInvocation(input: unknown): SkillInvocationV1 {
  return skillInvocationV1Schema.parse(input);
}

export function parseSkillCancellation(input: unknown): SkillCancellationV1 {
  return skillCancellationV1Schema.parse(input);
}

export function parseSkillExecutionResult(
  input: unknown,
): SkillExecutionResultV1 {
  return skillExecutionResultV1Schema.parse(input);
}
