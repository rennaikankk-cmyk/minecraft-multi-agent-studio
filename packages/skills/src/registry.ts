import {
  minecraftVersionStringSchema,
  skillCapabilitySchema,
  skillErrorCodeSchema,
  skillIdentifierSchema,
  skillVersionSchema,
} from "@minecraft-studio/protocol";
import { z } from "zod";

import { SkillFrameworkError } from "./errors.js";
import { resolveSkillCompatibility } from "./compatibility.js";
import type {
  SkillCompatibilityEnvironment,
  SkillCompatibilityResolution,
  SkillDefinition,
  SkillMetadata,
} from "./types.js";

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

const compatibilityNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const compatibilityRequirementSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("feature"),
      name: compatibilityNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("resource"),
      resource: z.enum(["item", "block", "entity"]),
      names: z
        .array(
          z
            .string()
            .min(1)
            .max(128)
            .regex(/^[a-z0-9_]+$/u),
        )
        .min(1)
        .max(32)
        .refine((values) => new Set(values).size === values.length),
      match: z.enum(["any", "all"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("server-capability"),
      name: compatibilityNameSchema,
    })
    .strict(),
]);

const compatibilityManifestSchema = z
  .object({
    variants: z
      .array(
        z
          .object({
            id: skillIdentifierSchema,
            requirements: z
              .array(compatibilityRequirementSchema)
              .max(16),
            verifiedMinecraftVersions: z
              .array(minecraftVersionStringSchema)
              .max(64)
              .refine((values) => new Set(values).size === values.length),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .refine(
        (variants) =>
          new Set(variants.map(({ id }) => id)).size === variants.length,
      ),
  })
  .strict();

const definitionMetadataSchema = z
  .object({
    id: skillIdentifierSchema,
    version: skillVersionSchema,
    compatibility: compatibilityManifestSchema,
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
      compatibility: definition.compatibility,
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
      compatibility: Object.freeze({
        variants: Object.freeze(
          metadata.data.compatibility.variants.map((variant) =>
            Object.freeze({
              ...variant,
              requirements: Object.freeze(
                variant.requirements.map((requirement) =>
                  Object.freeze(
                    requirement.kind === "resource"
                      ? {
                          ...requirement,
                          names: Object.freeze([...requirement.names]),
                        }
                      : { ...requirement },
                  ),
                ),
              ),
              verifiedMinecraftVersions: Object.freeze([
                ...variant.verifiedMinecraftVersions,
              ]),
            }),
          ),
        ),
      }),
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

  resolveCompatibility(
    id: string,
    version: string,
    environment: SkillCompatibilityEnvironment | null,
  ): SkillCompatibilityResolution | null {
    const definition = this.resolve(id, version);
    return definition
      ? resolveSkillCompatibility(definition, environment)
      : null;
  }

  listCompatibility(
    environment: SkillCompatibilityEnvironment | null,
  ): readonly SkillCompatibilityResolution[] {
    return Object.freeze(
      [...this.definitions.values()]
        .map((definition) =>
          resolveSkillCompatibility(definition, environment),
        )
        .sort((left, right) =>
          `${left.skillId}@${left.skillVersion}`.localeCompare(
            `${right.skillId}@${right.skillVersion}`,
          ),
        ),
    );
  }

  list(): readonly SkillMetadata[] {
    return [...this.definitions.values()]
      .map((definition) =>
        Object.freeze({
          id: definition.id,
          version: definition.version,
          compatibility: definition.compatibility,
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
