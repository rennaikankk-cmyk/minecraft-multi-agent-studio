import {
  skillCapabilitySchema,
  skillErrorCodeSchema,
  skillIdentifierSchema,
  skillVersionSchema,
} from "@minecraft-studio/protocol";
import { z } from "zod";

import { SkillFrameworkError } from "./errors.js";
import type { SkillDefinition, SkillMetadata } from "./types.js";

type StoredSkillDefinition = SkillDefinition<unknown, unknown, unknown>;

const retryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(5),
    baseDelayMs: z.number().int().min(10).max(5_000),
    maxDelayMs: z.number().int().min(10).max(30_000),
    retryableErrorCodes: z
      .array(skillErrorCodeSchema)
      .max(16)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict()
  .refine((value) => value.maxDelayMs >= value.baseDelayMs, {
    message: "Retry maximum delay must be at least the base delay.",
    path: ["maxDelayMs"],
  });

const preconditionMetadataSchema = z
  .object({
    id: skillIdentifierSchema,
    failureCode: skillErrorCodeSchema,
    check: z.custom<(input: unknown, state: unknown) => boolean>(
      (value) => typeof value === "function",
    ),
  })
  .strict();

const definitionMetadataSchema = z
  .object({
    id: skillIdentifierSchema,
    version: skillVersionSchema,
    requiredCapabilities: z
      .array(skillCapabilitySchema)
      .max(16)
      .refine((values) => new Set(values).size === values.length),
    timeoutMs: z.number().int().min(10).max(60_000),
    idempotent: z.boolean(),
    retryPolicy: retryPolicySchema,
    preconditions: z
      .array(preconditionMetadataSchema)
      .max(16)
      .refine(
        (values) => new Set(values.map(({ id }) => id)).size === values.length,
      ),
  })
  .strict()
  .superRefine((definition, context) => {
    if (!definition.idempotent && definition.retryPolicy.maxAttempts > 1) {
      context.addIssue({
        code: "custom",
        path: ["retryPolicy", "maxAttempts"],
        message: "Non-idempotent skills cannot be retried automatically.",
      });
    }
  });

function isSchema(value: unknown): value is z.ZodType<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof value.safeParse === "function"
  );
}

function key(id: string, version: string): string {
  return `${id}@${version}`;
}

export class SkillRegistry {
  private readonly definitions = new Map<string, StoredSkillDefinition>();

  register<TInput, TOutput, TState>(
    definition: SkillDefinition<TInput, TOutput, TState>,
  ): void {
    const metadata = definitionMetadataSchema.safeParse({
      id: definition.id,
      version: definition.version,
      requiredCapabilities: definition.requiredCapabilities,
      timeoutMs: definition.timeoutMs,
      idempotent: definition.idempotent,
      retryPolicy: definition.retryPolicy,
      preconditions: definition.preconditions,
    });
    if (
      !metadata.success ||
      !isSchema(definition.inputSchema) ||
      !isSchema(definition.outputSchema) ||
      !isSchema(definition.stateSchema) ||
      typeof definition.execute !== "function"
    ) {
      throw new SkillFrameworkError(
        "INVALID_SKILL_DEFINITION",
        "Skill definition failed metadata, schema, or handler validation.",
      );
    }
    const definitionKey = key(metadata.data.id, metadata.data.version);
    if (this.definitions.has(definitionKey)) {
      throw new SkillFrameworkError(
        "DUPLICATE_SKILL_VERSION",
        "A skill with the same ID and version is already registered.",
      );
    }

    const stored = Object.freeze({
      ...definition,
      requiredCapabilities: Object.freeze([
        ...metadata.data.requiredCapabilities,
      ]),
      retryPolicy: Object.freeze({
        ...metadata.data.retryPolicy,
        retryableErrorCodes: Object.freeze([
          ...metadata.data.retryPolicy.retryableErrorCodes,
        ]),
      }),
      preconditions: Object.freeze(
        definition.preconditions.map((precondition) =>
          Object.freeze({ ...precondition }),
        ),
      ),
    }) as unknown as StoredSkillDefinition;
    this.definitions.set(definitionKey, stored);
  }

  resolve(id: string, version: string): StoredSkillDefinition | null {
    const parsedId = skillIdentifierSchema.safeParse(id);
    const parsedVersion = skillVersionSchema.safeParse(version);
    if (!parsedId.success || !parsedVersion.success) return null;
    return this.definitions.get(key(parsedId.data, parsedVersion.data)) ?? null;
  }

  list(): readonly SkillMetadata[] {
    return [...this.definitions.values()]
      .map((definition) =>
        Object.freeze({
          id: definition.id,
          version: definition.version,
          requiredCapabilities: Object.freeze([
            ...definition.requiredCapabilities,
          ]),
          timeoutMs: definition.timeoutMs,
          idempotent: definition.idempotent,
          retryPolicy: Object.freeze({
            ...definition.retryPolicy,
            retryableErrorCodes: Object.freeze([
              ...definition.retryPolicy.retryableErrorCodes,
            ]),
          }),
          preconditionIds: Object.freeze(
            definition.preconditions.map(({ id }) => id),
          ),
        }),
      )
      .sort((left, right) =>
        `${left.id}@${left.version}`.localeCompare(
          `${right.id}@${right.version}`,
        ),
      );
  }
}
