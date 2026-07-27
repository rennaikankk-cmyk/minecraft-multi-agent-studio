import {
  identifierSchema,
  skillIdentifierSchema,
  skillJsonValueSchema,
  skillVersionSchema,
} from "@minecraft-studio/protocol";
import { z } from "zod";

const timestampSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
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

const boundedJsonSchema = skillJsonValueSchema.refine(
  (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 32 * 1_024,
  "Structured task data exceeds 32 KiB.",
);

export const taskStatusSchema = z.enum([
  "queued",
  "assigned",
  "running",
  "blocked",
  "waiting",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export const taskRiskLevelSchema = z.enum(["R0", "R1", "R2", "R3", "R4"]);

export const taskTargetSchema = z
  .object({
    x: z.number().finite().min(-30_000_000).max(30_000_000),
    y: z.number().finite().min(-2_048).max(2_048),
    z: z.number().finite().min(-30_000_000).max(30_000_000),
    dimension: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u),
    serverProfileId: identifierSchema,
  })
  .strict();

export const taskRequiredSkillSchema = z
  .object({
    skillId: skillIdentifierSchema,
    skillVersion: skillVersionSchema,
  })
  .strict();

export const taskRequiredItemSchema = z
  .object({
    itemName: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u),
    count: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();

export const taskEvidenceSchema = z
  .object({
    kind: z.enum(["trace", "log", "screenshot", "artifact"]),
    reference: identifierSchema,
  })
  .strict();

export const taskCreateCommandSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    operationId: z.string().uuid(),
    taskId: z.string().uuid(),
    idempotencyScope: identifierSchema,
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    taskType: taskTypeSchema,
    handlerVersion: skillVersionSchema,
    executionIdempotent: z.boolean(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4_000),
    priority: z.number().int().min(0).max(100),
    requiredSkills: z
      .array(taskRequiredSkillSchema)
      .max(32)
      .refine(
        (values) =>
          new Set(
            values.map(
              ({ skillId, skillVersion }) => `${skillId}@${skillVersion}`,
            ),
          ).size === values.length,
      ),
    requiredItems: z
      .array(taskRequiredItemSchema)
      .max(128)
      .refine(
        (values) =>
          new Set(values.map(({ itemName }) => itemName)).size === values.length,
      ),
    target: taskTargetSchema.nullable(),
    dependencyIds: z
      .array(z.string().uuid())
      .max(64)
      .refine((values) => new Set(values).size === values.length),
    parentTaskId: z.string().uuid().nullable(),
    deadline: timestampSchema.nullable(),
    timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60_000),
    maxRetries: z.number().int().min(0).max(10),
    riskLevel: taskRiskLevelSchema,
    traceId: identifierSchema,
    actorId: identifierSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.dependencyIds.includes(command.taskId)) {
      context.addIssue({
        code: "custom",
        path: ["dependencyIds"],
        message: "A task cannot depend on itself.",
      });
    }
    if (command.parentTaskId === command.taskId) {
      context.addIssue({
        code: "custom",
        path: ["parentTaskId"],
        message: "A task cannot be its own parent.",
      });
    }
  });

export const taskRecordSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    taskId: z.string().uuid(),
    idempotencyScope: identifierSchema,
    idempotencyKey: z.string().min(8).max(128),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    taskType: taskTypeSchema,
    handlerVersion: skillVersionSchema,
    executionIdempotent: z.boolean(),
    title: z.string().min(1).max(200),
    description: z.string().max(4_000),
    priority: z.number().int().min(0).max(100),
    status: taskStatusSchema,
    assignedBotId: identifierSchema.nullable(),
    requiredSkills: z.array(taskRequiredSkillSchema).max(32),
    requiredItems: z.array(taskRequiredItemSchema).max(128),
    target: taskTargetSchema.nullable(),
    dependencyIds: z.array(z.string().uuid()).max(64),
    parentTaskId: z.string().uuid().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    finishedAt: timestampSchema.nullable(),
    deadline: timestampSchema.nullable(),
    timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60_000),
    retryCount: z.number().int().min(0).max(10),
    maxRetries: z.number().int().min(0).max(10),
    leaseOwner: identifierSchema.nullable(),
    leaseExpiresAt: timestampSchema.nullable(),
    riskLevel: taskRiskLevelSchema,
    failureReason: reasonCodeSchema.nullable(),
    result: boundedJsonSchema.nullable(),
    evidence: z.array(taskEvidenceSchema).max(64),
    traceId: identifierSchema,
    revision: z.number().int().min(0),
  })
  .strict();

const operationBaseShape = {
  schemaVersion: z.literal("1.0"),
  operationId: z.string().uuid(),
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().min(0),
  actorId: identifierSchema,
};

export const taskTransitionCommandSchema = z
  .object({
    ...operationBaseShape,
    to: taskStatusSchema,
    reasonCode: reasonCodeSchema,
    leaseOwner: identifierSchema.nullable(),
    failureReason: reasonCodeSchema.nullable(),
    result: boundedJsonSchema.nullable(),
    evidence: z.array(taskEvidenceSchema).max(64),
  })
  .strict();

export const taskCancelCommandSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    operationId: z.string().uuid(),
    taskId: z.string().uuid(),
    actorId: identifierSchema,
    leaseOwner: identifierSchema.nullable(),
    reasonCode: reasonCodeSchema,
  })
  .strict();

export const taskLeaseAcquireCommandSchema = z
  .object({
    ...operationBaseShape,
    botId: identifierSchema,
    leaseOwner: identifierSchema,
    leaseDurationMs: z.number().int().min(1_000).max(5 * 60_000),
  })
  .strict();

export const taskLeaseRenewCommandSchema = z
  .object({
    ...operationBaseShape,
    leaseOwner: identifierSchema,
    leaseDurationMs: z.number().int().min(1_000).max(5 * 60_000),
  })
  .strict();

export const taskLeaseReleaseCommandSchema = z
  .object({
    ...operationBaseShape,
    leaseOwner: identifierSchema,
    reasonCode: reasonCodeSchema,
  })
  .strict();

export const taskLeaseExpireCommandSchema = z
  .object({
    ...operationBaseShape,
    reasonCode: z.literal("TASK_LEASE_EXPIRED"),
  })
  .strict();

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskCreateCommand = z.infer<typeof taskCreateCommandSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type TaskTransitionCommand = z.infer<
  typeof taskTransitionCommandSchema
>;
export type TaskCancelCommand = z.infer<typeof taskCancelCommandSchema>;
export type TaskLeaseAcquireCommand = z.infer<
  typeof taskLeaseAcquireCommandSchema
>;
export type TaskLeaseRenewCommand = z.infer<
  typeof taskLeaseRenewCommandSchema
>;
export type TaskLeaseReleaseCommand = z.infer<
  typeof taskLeaseReleaseCommandSchema
>;
export type TaskLeaseExpireCommand = z.infer<
  typeof taskLeaseExpireCommandSchema
>;
