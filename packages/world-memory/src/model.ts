import { z } from "zod";

import { identifierSchema } from "@minecraft-studio/protocol";

export const MAX_WORLD_MEMORY_EMBEDDING_DIMENSIONS = 2_000;
export const MAX_WORLD_MEMORY_QUERY_RESULTS = 50;

const timestampSchema = z.string().datetime({ offset: true });
const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);
const coordinateSchema = z.number().finite().min(-30_000_000).max(30_000_000);
const verticalCoordinateSchema = z.number().finite().min(-4_096).max(4_096);
const tagSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);
const embeddingModelSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u);

export const worldMemoryKindSchema = z.enum([
  "base",
  "hazard",
  "landmark",
  "player_activity",
  "portal",
  "resource",
  "route",
  "storage",
]);

export const worldMemoryVisibilitySchema = z.enum(["team", "restricted"]);

export const worldMemoryPositionSchema = z
  .object({
    x: coordinateSchema,
    y: verticalCoordinateSchema,
    z: coordinateSchema,
  })
  .strict();

export const worldMemoryEmbeddingSchema = z
  .object({
    model: embeddingModelSchema,
    values: z
      .array(z.number().finite())
      .min(1)
      .max(MAX_WORLD_MEMORY_EMBEDDING_DIMENSIONS)
      .refine((values) => values.some((value) => value !== 0), {
        message: "Cosine-search embeddings cannot be a zero vector.",
      }),
  })
  .strict();

export const worldMemoryWriteCommandSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    operationId: z.string().uuid(),
    memoryId: z.string().uuid(),
    serverProfileId: identifierSchema,
    dimension: dimensionSchema,
    position: worldMemoryPositionSchema,
    kind: worldMemoryKindSchema,
    summary: z.string().trim().min(1).max(1_024),
    tags: z.array(tagSchema).max(32),
    confidence: z.number().finite().min(0).max(1),
    visibility: worldMemoryVisibilitySchema,
    allowedSubjectIds: z.array(identifierSchema).max(64),
    modelAccess: z.boolean(),
    sourceBotId: identifierSchema,
    sourceTaskId: identifierSchema.nullable(),
    traceId: identifierSchema,
    observedAt: timestampSchema,
    expiresAt: timestampSchema.nullable(),
    supersedesMemoryId: z.string().uuid().nullable(),
    embedding: worldMemoryEmbeddingSchema.nullable(),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      new Set(command.tags).size !== command.tags.length ||
      new Set(command.allowedSubjectIds).size !==
        command.allowedSubjectIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["tags"],
        message: "Memory tags and allowed subjects must be unique.",
      });
    }
    if (
      command.visibility === "team" &&
      command.allowedSubjectIds.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedSubjectIds"],
        message: "Team-visible memory cannot carry a restricted ACL.",
      });
    }
    if (
      command.visibility === "restricted" &&
      !command.allowedSubjectIds.includes(command.sourceBotId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedSubjectIds"],
        message: "Restricted memory must remain readable by its source Bot.",
      });
    }
    if (
      command.modelAccess &&
      (command.visibility !== "team" ||
        command.kind === "base" ||
        command.kind === "storage" ||
        command.kind === "player_activity")
    ) {
      context.addIssue({
        code: "custom",
        path: ["modelAccess"],
        message:
          "Restricted, base, storage, and player-activity memory cannot enter a model prompt.",
      });
    }
    if (
      command.expiresAt !== null &&
      Date.parse(command.expiresAt) <= Date.parse(command.observedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Memory expiry must be later than its observation time.",
      });
    }
    if (command.supersedesMemoryId === command.memoryId) {
      context.addIssue({
        code: "custom",
        path: ["supersedesMemoryId"],
        message: "A memory record cannot supersede itself.",
      });
    }
  });

const worldMemoryCenterSchema = worldMemoryPositionSchema.extend({
  radius: z.number().finite().positive().max(60_000_000),
});

export const worldMemorySemanticQuerySchema = z
  .object({
    model: embeddingModelSchema,
    values: z
      .array(z.number().finite())
      .min(1)
      .max(MAX_WORLD_MEMORY_EMBEDDING_DIMENSIONS)
      .refine((values) => values.some((value) => value !== 0), {
        message: "Cosine-search embeddings cannot be a zero vector.",
      }),
    maxCosineDistance: z.number().finite().min(0).max(2).optional(),
  })
  .strict();

export const worldMemoryQuerySchema = z
  .object({
    serverProfileId: identifierSchema,
    dimension: dimensionSchema,
    subjectId: identifierSchema,
    kinds: z.array(worldMemoryKindSchema).max(worldMemoryKindSchema.options.length),
    tags: z.array(tagSchema).max(32),
    minimumConfidence: z.number().finite().min(0).max(1),
    observedAfter: timestampSchema.nullable(),
    center: worldMemoryCenterSchema.nullable(),
    semantic: worldMemorySemanticQuerySchema.nullable(),
    modelAccessOnly: z.boolean(),
    limit: z.number().int().min(1).max(MAX_WORLD_MEMORY_QUERY_RESULTS),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      new Set(query.kinds).size !== query.kinds.length ||
      new Set(query.tags).size !== query.tags.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["tags"],
        message: "Query kinds and tags must be unique.",
      });
    }
  });

export type WorldMemoryKind = z.infer<typeof worldMemoryKindSchema>;
export type WorldMemoryVisibility = z.infer<
  typeof worldMemoryVisibilitySchema
>;
export type WorldMemoryPosition = z.infer<typeof worldMemoryPositionSchema>;
export type WorldMemoryEmbedding = z.infer<typeof worldMemoryEmbeddingSchema>;
export type WorldMemoryWriteCommand = z.infer<
  typeof worldMemoryWriteCommandSchema
>;
export type WorldMemorySemanticQuery = z.infer<
  typeof worldMemorySemanticQuerySchema
>;
export type WorldMemoryQuery = z.infer<typeof worldMemoryQuerySchema>;

export const worldMemoryRecordSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    operationId: z.string().uuid(),
    memoryId: z.string().uuid(),
    serverProfileId: identifierSchema,
    dimension: dimensionSchema,
    position: worldMemoryPositionSchema,
    kind: worldMemoryKindSchema,
    summary: z.string().trim().min(1).max(1_024),
    tags: z.array(tagSchema).max(32),
    confidence: z.number().finite().min(0).max(1),
    visibility: worldMemoryVisibilitySchema,
    allowedSubjectIds: z.array(identifierSchema).max(64),
    modelAccess: z.boolean(),
    sourceBotId: identifierSchema,
    sourceTaskId: identifierSchema.nullable(),
    traceId: identifierSchema,
    observedAt: timestampSchema,
    expiresAt: timestampSchema.nullable(),
    supersedesMemoryId: z.string().uuid().nullable(),
    embeddingModel: embeddingModelSchema.nullable(),
    embeddingDimensions: z
      .number()
      .int()
      .min(1)
      .max(MAX_WORLD_MEMORY_EMBEDDING_DIMENSIONS)
      .nullable(),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (
      (record.embeddingModel === null) !==
      (record.embeddingDimensions === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["embeddingModel"],
        message: "Embedding model and dimensions must be present together.",
      });
    }
  });

export type WorldMemoryRecord = z.infer<typeof worldMemoryRecordSchema>;

export type WorldMemorySearchResult = Readonly<{
  memory: WorldMemoryRecord;
  distance: number | null;
  cosineDistance: number | null;
}>;
