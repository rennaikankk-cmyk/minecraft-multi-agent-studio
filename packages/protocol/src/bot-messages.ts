import { z } from "zod";

import {
  skillIdentifierSchema,
  skillVersionSchema,
} from "./skill-identifiers.js";

export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const timestampSchema = z.string().datetime({ offset: true });
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const botMessageSourceSchema = z
  .object({
    service: z.enum(["bot-runtime", "coordinator", "api-gateway"]),
    instanceId: identifierSchema,
  })
  .strict();

export const botConnectionStateSchema = z.enum([
  "connecting",
  "online",
  "stale",
  "offline",
  "stopping",
  "error",
]);

export const minecraftVersionStringSchema = z
  .string()
  .min(1)
  .max(64)
  // Minecraft changed its public versioning scheme after the 1.x era. Keep
  // the wire contract scheme-agnostic; the installed adapter remains the
  // authority for whether a concrete version is actually supported.
  .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u);

export const minecraftVersionCompatibilitySchema = z
  .object({
    selection: z.enum(["auto", "fixed"]),
    requestedVersion: minecraftVersionStringSchema.nullable(),
    resolvedVersion: minecraftVersionStringSchema.nullable(),
    protocolVersion: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
    majorVersion: minecraftVersionStringSchema.nullable().optional(),
    supportLevel: z.enum(["tested", "compatible-untested", "unsupported"]),
    supportedRange: z
      .object({
        oldest: minecraftVersionStringSchema,
        latest: minecraftVersionStringSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.selection === "auto" && value.requestedVersion !== null) {
      context.addIssue({
        code: "custom",
        path: ["requestedVersion"],
        message: "Auto version selection cannot contain a requested version.",
      });
    }
    if (value.selection === "fixed" && value.requestedVersion === null) {
      context.addIssue({
        code: "custom",
        path: ["requestedVersion"],
        message: "Fixed version selection requires a requested version.",
      });
    }
    if (value.supportLevel === "unsupported" && value.resolvedVersion !== null) {
      context.addIssue({
        code: "custom",
        path: ["resolvedVersion"],
        message: "An unsupported result cannot claim a resolved version.",
      });
    }
    if (value.supportLevel !== "unsupported" && value.resolvedVersion === null) {
      context.addIssue({
        code: "custom",
        path: ["resolvedVersion"],
        message: "A supported result requires a resolved version.",
      });
    }
    if (
      value.supportLevel === "unsupported" &&
      (value.protocolVersion != null || value.majorVersion != null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["protocolVersion"],
        message: "An unsupported result cannot claim resolved protocol metadata.",
      });
    }
  });

export const skillCompatibilityAvailabilitySchema = z.enum([
  "available",
  "unavailable",
]);

export const skillCompatibilityVerificationSchema = z.enum([
  "verified",
  "unverified",
]);

export const SKILL_INPUT_SCHEMA_MAX_BYTES = 32_768;
export const SKILL_INPUT_SCHEMA_MAX_DEPTH = 16;
export const SKILL_INPUT_SCHEMA_MAX_PROPERTIES = 256;
const SKILL_INPUT_SCHEMA_MAX_NODES = 512;
const SKILL_INPUT_SCHEMA_MAX_ARRAY_LENGTH = 64;
const SKILL_INPUT_SCHEMA_MAX_STRING_LENGTH = 256;
const SKILL_INPUT_SCHEMA_MAX_KEYS_PER_NODE = 256;
const SKILL_INPUT_SCHEMA_DRAFT =
  "https://json-schema.org/draft/2020-12/schema";

const skillInputSchemaAllowedKeys = new Set([
  "$schema",
  "type",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

// Variant IDs are local compatibility labels rather than Skill identifiers;
// preserve their historical one-character lower-case boundary.
const skillVariantIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/u);

const skillInputSchemaPropertyName = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const skillInputSchemaReservedPropertyNames = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const skillInputSchemaFormats = new Set([
  "base64",
  "base64url",
  "cidr",
  "cidr-v6",
  "cuid",
  "cuid2",
  "date",
  "date-time",
  "duration",
  "e164",
  "email",
  "emoji",
  "ipv4",
  "ipv6",
  "jwt",
  "ksuid",
  "mac",
  "nanoid",
  "time",
  "ulid",
  "uri",
  "uri-reference",
  "uuid",
  "xid",
]);

type SkillInputSchemaObject = Record<string, unknown>;
type SkillInputJsonPrimitive = string | number | boolean | null;
type SkillInputJsonValue =
  | SkillInputJsonPrimitive
  | SkillInputJsonValue[]
  | { [key: string]: SkillInputJsonValue };
type SkillInputSchemaIssue = {
  path: (string | number)[];
  message: string;
};

function isSkillInputSchemaPrimitive(value: unknown): value is SkillInputJsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isSkillInputSchemaObject(value: unknown): value is SkillInputSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addSkillInputSchemaIssue(
  issues: SkillInputSchemaIssue[],
  path: (string | number)[],
  message: string,
): void {
  if (issues.length < 32) issues.push({ path, message });
}

function validateSkillInputSchema(value: unknown): SkillInputSchemaIssue[] {
  const issues: SkillInputSchemaIssue[] = [];
  if (!isSkillInputSchemaObject(value)) {
    return [{ path: [], message: "Skill inputSchema must be a JSON Schema object." }];
  }

  let propertyCount = 0;
  let nodeCount = 0;
  const visitedObjects = new WeakSet<object>();

  const visit = (node: unknown, path: (string | number)[], depth: number): void => {
    if (!isSkillInputSchemaObject(node)) {
      addSkillInputSchemaIssue(issues, path, "Schema nodes must be JSON objects.");
      return;
    }
    if (visitedObjects.has(node)) {
      addSkillInputSchemaIssue(issues, path, "Schema nodes must not contain cycles or shared object references.");
      return;
    }
    visitedObjects.add(node);
    nodeCount += 1;
    if (nodeCount > SKILL_INPUT_SCHEMA_MAX_NODES) {
      addSkillInputSchemaIssue(issues, path, "Skill inputSchema exceeds the node limit.");
      return;
    }
    if (depth > SKILL_INPUT_SCHEMA_MAX_DEPTH) {
      addSkillInputSchemaIssue(issues, path, "Skill inputSchema exceeds the depth limit.");
      return;
    }
    const keys = Object.keys(node);
    if (keys.length > SKILL_INPUT_SCHEMA_MAX_KEYS_PER_NODE) {
      addSkillInputSchemaIssue(
        issues,
        path,
        "A Skill inputSchema node contains too many keywords.",
      );
    }
    if (keys.length === 0) {
      addSkillInputSchemaIssue(issues, path, "Schema nodes must contain a validation keyword.");
    }
    if (
      !["type", "enum", "const", "anyOf", "oneOf", "allOf"].some(
        (key) => key in node,
      )
    ) {
      addSkillInputSchemaIssue(
        issues,
        path,
        "Schema nodes must declare a concrete type or bounded composition.",
      );
    }
    for (const key of keys.slice(0, SKILL_INPUT_SCHEMA_MAX_KEYS_PER_NODE)) {
      if (!skillInputSchemaAllowedKeys.has(key)) {
        addSkillInputSchemaIssue(
          issues,
          [...path, key],
          `Unsupported or annotation JSON Schema keyword: ${key}.`,
        );
      }
    }

    if ("$schema" in node && node.$schema !== SKILL_INPUT_SCHEMA_DRAFT) {
      addSkillInputSchemaIssue(issues, [...path, "$schema"], "Only the draft 2020-12 JSON Schema dialect is allowed.");
    }
    if ("type" in node) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (
        types.length === 0 ||
        types.length > 4 ||
        new Set(types).size !== types.length ||
        types.some(
          (type) =>
            typeof type !== "string" ||
            !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type),
        )
      ) {
        addSkillInputSchemaIssue(issues, [...path, "type"], "Schema type must use the bounded JSON Schema type set.");
      }
    }

    const validateNonNegativeInteger = (key: string): void => {
      if (
        key in node &&
        (!Number.isSafeInteger(node[key]) || (node[key] as number) < 0)
      ) {
        addSkillInputSchemaIssue(issues, [...path, key], `${key} must be a non-negative safe integer.`);
      }
    };
    for (const key of [
      "minItems",
      "maxItems",
      "minLength",
      "maxLength",
    ]) {
      validateNonNegativeInteger(key);
    }
    for (const [minimumKey, maximumKey] of [
      ["minItems", "maxItems"],
      ["minLength", "maxLength"],
    ] as const) {
      if (
        typeof node[minimumKey] === "number" &&
        typeof node[maximumKey] === "number" &&
        node[minimumKey] > node[maximumKey]
      ) {
        addSkillInputSchemaIssue(issues, [...path, maximumKey], `${maximumKey} cannot be less than ${minimumKey}.`);
      }
    }
    for (const key of [
      "minimum",
      "maximum",
      "multipleOf",
      "exclusiveMinimum",
      "exclusiveMaximum",
    ]) {
      if (key in node && (typeof node[key] !== "number" || !Number.isFinite(node[key]))) {
        addSkillInputSchemaIssue(issues, [...path, key], `${key} must be a finite number.`);
      }
    }
    if (typeof node.multipleOf === "number" && node.multipleOf <= 0) {
      addSkillInputSchemaIssue(issues, [...path, "multipleOf"], "multipleOf must be positive.");
    }
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
      if (typeof node[key] === "number" && Math.abs(node[key]) > Number.MAX_SAFE_INTEGER) {
        addSkillInputSchemaIssue(issues, [...path, key], `${key} exceeds the safe numeric range.`);
      }
    }
    if ("pattern" in node) {
      if (
        typeof node.pattern !== "string" ||
        node.pattern.length > SKILL_INPUT_SCHEMA_MAX_STRING_LENGTH
      ) {
        addSkillInputSchemaIssue(issues, [...path, "pattern"], "pattern must be a short string.");
      } else {
        try {
          // Compile here so fromJSONSchema cannot fail after catalog admission.
          new RegExp(node.pattern);
        } catch {
          addSkillInputSchemaIssue(issues, [...path, "pattern"], "pattern must be a valid regular expression.");
        }
      }
    }
    if ("format" in node && (typeof node.format !== "string" || !skillInputSchemaFormats.has(node.format))) {
      addSkillInputSchemaIssue(issues, [...path, "format"], "format is not in the supported validation subset.");
    }

    if ("enum" in node) {
      if (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > SKILL_INPUT_SCHEMA_MAX_ARRAY_LENGTH) {
        addSkillInputSchemaIssue(issues, [...path, "enum"], "enum must be a bounded non-empty primitive array.");
      } else if (node.enum.some((entry) => !isSkillInputSchemaPrimitive(entry))) {
        addSkillInputSchemaIssue(issues, [...path, "enum"], "enum values must be primitive JSON values.");
      }
    }
    if ("const" in node && !isSkillInputSchemaPrimitive(node.const)) {
      addSkillInputSchemaIssue(issues, [...path, "const"], "const must be a primitive JSON value.");
    }

    if ("required" in node) {
      if (!Array.isArray(node.required) || node.required.length > SKILL_INPUT_SCHEMA_MAX_ARRAY_LENGTH) {
        addSkillInputSchemaIssue(issues, [...path, "required"], "required must be a bounded array of safe property names.");
      } else {
        const required = new Set<string>();
        for (const [index, name] of node.required.entries()) {
          if (
            typeof name !== "string" ||
            name.length > 128 ||
            !skillInputSchemaPropertyName.test(name) ||
            skillInputSchemaReservedPropertyNames.has(name) ||
            required.has(name)
          ) {
            addSkillInputSchemaIssue(issues, [...path, "required", index], "required contains an invalid or duplicate property name.");
          }
          if (typeof name === "string") required.add(name);
        }
      }
    }
    if ("properties" in node) {
      if (!isSkillInputSchemaObject(node.properties)) {
        addSkillInputSchemaIssue(issues, [...path, "properties"], "properties must be an object of schema nodes.");
      } else {
        const properties = Object.entries(node.properties);
        const remainingPropertyBudget = Math.max(
          0,
          SKILL_INPUT_SCHEMA_MAX_PROPERTIES - propertyCount,
        );
        propertyCount += properties.length;
        if (propertyCount > SKILL_INPUT_SCHEMA_MAX_PROPERTIES) {
          addSkillInputSchemaIssue(issues, [...path, "properties"], "Skill inputSchema exceeds the property limit.");
        }
        for (const [index, [name, child]] of properties.entries()) {
          if (index >= remainingPropertyBudget) break;
          if (name.length > 128 || !skillInputSchemaPropertyName.test(name)) {
            addSkillInputSchemaIssue(issues, [...path, "properties", name], "Property names must be short safe identifiers.");
          }
          if (skillInputSchemaReservedPropertyNames.has(name)) {
            addSkillInputSchemaIssue(issues, [...path, "properties", name], "Reserved property names are not allowed.");
          }
          visit(child, [...path, "properties", name], depth + 1);
        }
      }
    }

    if ("additionalProperties" in node) {
      if (typeof node.additionalProperties === "boolean") {
        // Boolean additionalProperties is a safe strict/loose object boundary.
      } else {
        visit(node.additionalProperties, [...path, "additionalProperties"], depth + 1);
      }
    }
    if ("items" in node) visit(node.items, [...path, "items"], depth + 1);
    if ("prefixItems" in node) {
      if (!Array.isArray(node.prefixItems) || node.prefixItems.length > SKILL_INPUT_SCHEMA_MAX_ARRAY_LENGTH) {
        addSkillInputSchemaIssue(issues, [...path, "prefixItems"], "prefixItems must be a bounded schema array.");
      } else {
        node.prefixItems.forEach((child, index) => visit(child, [...path, "prefixItems", index], depth + 1));
      }
    }
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      if (key in node) {
        if (!Array.isArray(node[key]) || node[key].length === 0 || node[key].length > SKILL_INPUT_SCHEMA_MAX_ARRAY_LENGTH) {
          addSkillInputSchemaIssue(issues, [...path, key], `${key} must be a bounded non-empty schema array.`);
        } else {
          node[key].forEach((child, index) => visit(child, [...path, key, index], depth + 1));
        }
      }
    }
  };

  visit(value, [], 0);
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > SKILL_INPUT_SCHEMA_MAX_BYTES) {
      addSkillInputSchemaIssue(issues, [], "Skill inputSchema exceeds the serialized byte limit.");
    }
  } catch {
    addSkillInputSchemaIssue(issues, [], "Skill inputSchema must be serializable JSON.");
  }
  if (issues.length === 0) {
    try {
      z.fromJSONSchema(value as Parameters<typeof z.fromJSONSchema>[0]);
    } catch {
      addSkillInputSchemaIssue(issues, [], "Skill inputSchema is not supported by Zod fromJSONSchema.");
    }
  }
  return issues;
}

const skillInputSchemaValueSchema = z.custom<SkillInputJsonValue>(() => true);

export const skillInputSchemaSchema = skillInputSchemaValueSchema.superRefine((value, context) => {
  let issues: SkillInputSchemaIssue[];
  try {
    issues = validateSkillInputSchema(value);
  } catch {
    context.addIssue({
      code: "custom",
      path: [],
      message: "Skill inputSchema could not be safely inspected as JSON.",
    });
    return;
  }
  for (const issue of issues) {
    context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});

export const skillCompatibilityReasonSchema = z
  .object({
    variantId: skillVariantIdentifierSchema,
    code: z.enum([
      "FEATURE_MISSING",
      "RESOURCE_MISSING",
      "SERVER_CAPABILITY_MISSING",
      "SERVER_CAPABILITY_UNKNOWN",
      "COMPATIBILITY_ENVIRONMENT_UNAVAILABLE",
    ]),
    subject: z.string().min(1).max(512),
  })
  .strict();

export const botSkillCatalogEntryV1Schema = z
  .object({
    skillId: skillIdentifierSchema,
    skillVersion: skillVersionSchema,
    availability: skillCompatibilityAvailabilitySchema,
    verification: skillCompatibilityVerificationSchema,
    inputSchema: skillInputSchemaSchema,
    timeoutMs: z.number().int().min(10).max(60_000),
    idempotent: z.boolean(),
    selectedVariantId: skillVariantIdentifierSchema.nullable(),
    unavailableReasons: z.array(skillCompatibilityReasonSchema).max(128),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.availability === "available" &&
      (entry.selectedVariantId === null || entry.unavailableReasons.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["availability"],
        message: "An available skill requires one selected variant and no reasons.",
      });
    }
    if (
      entry.availability === "unavailable" &&
      (entry.selectedVariantId !== null || entry.unavailableReasons.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["availability"],
        message: "An unavailable skill requires bounded incompatibility reasons.",
      });
    }
  });

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

export const botPositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
    dimension: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u),
  })
  .strict();

const healthSchema = z
  .object({
    current: z.number().finite().nonnegative(),
    maximum: z.number().finite().positive().nullable(),
  })
  .strict()
  .superRefine((health, context) => {
    if (health.maximum !== null && health.current > health.maximum) {
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "Current health cannot exceed maximum health.",
      });
    }
  });

const currentTaskSchema = z
  .object({
    taskId: identifierSchema,
    title: z.string().trim().min(1).max(200),
    status: taskStatusSchema,
    startedAt: timestampSchema.nullable(),
  })
  .strict();

export const l0SafetyRiskSchema = z.enum([
  "CRITICAL_HEALTH",
  "LOW_HEALTH",
  "HUNGER",
  "DROWNING",
  "LAVA",
  "FALLING",
  "STUCK",
  "INVENTORY_FULL",
]);

export const l0SafetyActionKindSchema = z.enum([
  "PAUSE_NORMAL_TASKS",
  "CONSUME_SAFE_FOOD",
  "RETREAT_STEP",
  "ASCEND",
  "ESCAPE_LAVA",
  "HALT_HORIZONTAL_MOVEMENT",
  "UNSTICK",
  "EMERGENCY_STOP",
]);

export const l0SafetyStatusSchema = z
  .object({
    mode: z.enum([
      "monitoring",
      "intervening",
      "paused",
      "emergency_stopping",
    ]),
    activeRisks: z.array(l0SafetyRiskSchema).max(8),
    normalTasksPaused: z.boolean(),
    lastDecisionId: identifierSchema.nullable(),
    lastAction: z
      .object({
        kind: l0SafetyActionKindSchema,
        outcome: z.enum(["executed", "skipped", "failed"]),
        completedAt: timestampSchema,
        errorCode: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Z][A-Z0-9_]*$/u)
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((status, context) => {
    if (new Set(status.activeRisks).size !== status.activeRisks.length) {
      context.addIssue({
        code: "custom",
        path: ["activeRisks"],
        message: "Safety risks must be unique.",
      });
    }
    if (
      status.mode === "monitoring" &&
      (status.activeRisks.length > 0 || status.normalTasksPaused)
    ) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "Monitoring mode cannot claim active risks or a task pause.",
      });
    }
    if (
      (status.mode === "paused" || status.mode === "emergency_stopping") &&
      !status.normalTasksPaused
    ) {
      context.addIssue({
        code: "custom",
        path: ["normalTasksPaused"],
        message: "Paused safety modes must pause normal tasks.",
      });
    }
  });

const botMessageEnvelopeShape = {
  schemaVersion: z.literal("1.0"),
  messageId: z.string().uuid(),
  traceId: identifierSchema,
  timestamp: timestampSchema,
  source: botMessageSourceSchema,
  botId: identifierSchema,
};

export const botStatusV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.status.v1"),
    payload: z
      .object({
        serverProfileId: identifierSchema,
        runtimeInstanceId: identifierSchema,
        sequence: sequenceSchema,
        observedAt: timestampSchema,
        connectionState: botConnectionStateSchema,
        health: healthSchema,
        food: z
          .object({
            level: z.number().int().min(0).max(20),
            saturation: z.number().finite().min(0).max(20),
          })
          .strict(),
        armorPoints: z.number().int().min(0).max(20).nullable(),
        position: botPositionSchema,
        latencyMs: z.number().int().nonnegative().max(120_000).nullable(),
        currentTask: currentTaskSchema.nullable(),
        safety: l0SafetyStatusSchema.optional(),
        minecraftVersion: minecraftVersionCompatibilitySchema
          .refine((value) => value.supportLevel !== "unsupported")
          .optional(),
      })
      .strict(),
  })
  .strict();

export const botHeartbeatV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.heartbeat.v1"),
    payload: z
      .object({
        serverProfileId: identifierSchema,
        runtimeInstanceId: identifierSchema,
        sequence: sequenceSchema,
        observedAt: timestampSchema,
        connectionState: botConnectionStateSchema,
        uptimeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        lastStatusSequence: sequenceSchema.nullable(),
        currentTaskId: identifierSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const lastStatusSequence = message.payload.lastStatusSequence;
    if (
      lastStatusSequence !== null &&
      lastStatusSequence > message.payload.sequence
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload", "lastStatusSequence"],
        message: "The last status sequence cannot exceed the message sequence.",
      });
    }
  });

export const botDisconnectedV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.disconnected.v1"),
    payload: z
      .object({
        serverProfileId: identifierSchema,
        runtimeInstanceId: identifierSchema,
        sequence: sequenceSchema,
        observedAt: timestampSchema,
        reason: z.enum([
          "requested_stop",
          "server_shutdown",
          "kicked",
          "network_error",
          "authentication_error",
          "runtime_error",
          "unknown",
        ]),
        expected: z.boolean(),
        lastStatusSequence: sequenceSchema.nullable(),
        detail: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const lastStatusSequence = message.payload.lastStatusSequence;
    if (
      lastStatusSequence !== null &&
      lastStatusSequence > message.payload.sequence
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload", "lastStatusSequence"],
        message: "The last status sequence cannot exceed the message sequence.",
      });
    }
  });

export const botVersionV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.version.v1"),
    payload: z
      .object({
        serverProfileId: identifierSchema,
        runtimeInstanceId: identifierSchema,
        sequence: sequenceSchema,
        observedAt: timestampSchema,
        compatibility: minecraftVersionCompatibilitySchema,
      })
      .strict(),
  })
  .strict();

export const botSkillCatalogV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.skill-catalog.v1"),
    payload: z
      .object({
        serverProfileId: identifierSchema,
        runtimeInstanceId: identifierSchema,
        sequence: sequenceSchema,
        observedAt: timestampSchema,
        minecraftVersion: minecraftVersionStringSchema,
        protocolVersion: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER),
        skills: z
          .array(botSkillCatalogEntryV1Schema)
          .max(256)
          .refine(
            (skills) =>
              new Set(
                skills.map(({ skillId, skillVersion }) =>
                  `${skillId}@${skillVersion}`,
                ),
              ).size === skills.length,
            { message: "Skill catalog entries must be unique by ID and version." },
          ),
      })
      .strict(),
  })
  .strict();

export const controlPermissionSchema = z.enum([
  "bot.stop",
  "bot.emergency-stop",
]);

const controlAuthorizationSchema = z
  .object({
    decisionId: z.string().uuid(),
    actorId: identifierSchema,
    permission: controlPermissionSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export const stopBotCommandV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.stop.command.v1"),
    source: z
      .object({
        service: z.enum(["coordinator", "api-gateway"]),
        instanceId: identifierSchema,
      })
      .strict(),
    payload: z
      .object({
        commandId: z.string().uuid(),
        mode: z.enum(["graceful", "emergency"]),
        reason: z.string().trim().min(1).max(300),
        requestedAt: timestampSchema,
        expiresAt: timestampSchema,
        gracePeriodMs: z.number().int().min(0).max(60_000),
        expectedRuntimeInstanceId: identifierSchema.nullable(),
        authorization: controlAuthorizationSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const requestedAt = Date.parse(message.payload.requestedAt);
    const expiresAt = Date.parse(message.payload.expiresAt);
    const authorizationIssuedAt = Date.parse(message.payload.authorization.issuedAt);
    const authorizationExpiresAt = Date.parse(message.payload.authorization.expiresAt);

    if (expiresAt <= requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["payload", "expiresAt"],
        message: "Command expiry must be after requestedAt.",
      });
    }
    if (authorizationIssuedAt > requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["payload", "authorization", "issuedAt"],
        message: "Authorization cannot be issued after the command request.",
      });
    }
    if (authorizationExpiresAt < expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["payload", "authorization", "expiresAt"],
        message: "Authorization must remain valid for the command lifetime.",
      });
    }

    const expectedPermission =
      message.payload.mode === "emergency" ? "bot.emergency-stop" : "bot.stop";
    if (message.payload.authorization.permission !== expectedPermission) {
      context.addIssue({
        code: "custom",
        path: ["payload", "authorization", "permission"],
        message: `Stop mode requires ${expectedPermission} permission.`,
      });
    }
  });

export const botStopResultV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.stop.result.v1"),
    source: z
      .object({
        service: z.literal("bot-runtime"),
        instanceId: identifierSchema,
      })
      .strict(),
    payload: z
      .object({
        commandId: z.string().uuid(),
        runtimeInstanceId: identifierSchema,
        outcome: z.enum(["completed", "rejected", "failed"]),
        completedAt: timestampSchema,
        errorCode: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Z][A-Z0-9_]*$/u)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.source.instanceId !== message.payload.runtimeInstanceId) {
      context.addIssue({
        code: "custom",
        path: ["source", "instanceId"],
        message: "Stop result source must match the runtime instance.",
      });
    }
    const hasError = message.payload.errorCode !== undefined;
    if (message.payload.outcome === "completed" && hasError) {
      context.addIssue({
        code: "custom",
        path: ["payload", "errorCode"],
        message: "A completed stop result cannot contain an error code.",
      });
    }
    if (message.payload.outcome !== "completed" && !hasError) {
      context.addIssue({
        code: "custom",
        path: ["payload", "errorCode"],
        message: "A rejected or failed stop result requires an error code.",
      });
    }
  });

export const botTelemetryMessageV1Schema = z.discriminatedUnion("type", [
  botStatusV1Schema,
  botHeartbeatV1Schema,
  botDisconnectedV1Schema,
  botVersionV1Schema,
  botSkillCatalogV1Schema,
]);

export const botProtocolMessageV1Schema = z.union([
  botStatusV1Schema,
  botHeartbeatV1Schema,
  botDisconnectedV1Schema,
  botVersionV1Schema,
  botSkillCatalogV1Schema,
  stopBotCommandV1Schema,
  botStopResultV1Schema,
]);

export type ControlPermission = z.infer<typeof controlPermissionSchema>;
export type BotStatusV1 = z.infer<typeof botStatusV1Schema>;
export type BotHeartbeatV1 = z.infer<typeof botHeartbeatV1Schema>;
export type BotDisconnectedV1 = z.infer<typeof botDisconnectedV1Schema>;
export type BotVersionV1 = z.infer<typeof botVersionV1Schema>;
export type BotSkillCatalogEntryV1 = z.infer<
  typeof botSkillCatalogEntryV1Schema
>;
export type BotSkillCatalogV1 = z.infer<typeof botSkillCatalogV1Schema>;
export type SkillCompatibilityAvailability = z.infer<
  typeof skillCompatibilityAvailabilitySchema
>;
export type SkillCompatibilityVerification = z.infer<
  typeof skillCompatibilityVerificationSchema
>;
export type SkillCompatibilityReason = z.infer<
  typeof skillCompatibilityReasonSchema
>;
export type L0SafetyRisk = z.infer<typeof l0SafetyRiskSchema>;
export type L0SafetyActionKind = z.infer<typeof l0SafetyActionKindSchema>;
export type L0SafetyStatus = z.infer<typeof l0SafetyStatusSchema>;
export type MinecraftVersionCompatibility = z.infer<
  typeof minecraftVersionCompatibilitySchema
>;
export type StopBotCommandV1 = z.infer<typeof stopBotCommandV1Schema>;
export type BotStopResultV1 = z.infer<typeof botStopResultV1Schema>;
export type BotTelemetryMessageV1 = z.infer<typeof botTelemetryMessageV1Schema>;
export type BotProtocolMessageV1 = z.infer<typeof botProtocolMessageV1Schema>;

export type ControlAuthorizationContext = {
  decisionId: string;
  actorId: string;
  botId: string;
  commandId: string;
  permissions: ReadonlySet<ControlPermission>;
  now?: Date;
};

export type ProtocolAuthorizationErrorCode =
  | "AUTH_CONTEXT_REQUIRED"
  | "AUTH_DECISION_MISMATCH"
  | "AUTH_ACTOR_MISMATCH"
  | "AUTH_RESOURCE_MISMATCH"
  | "AUTH_COMMAND_MISMATCH"
  | "AUTH_PERMISSION_DENIED"
  | "AUTH_CONTEXT_INVALID"
  | "AUTH_EXPIRED";

export class ProtocolAuthorizationError extends Error {
  readonly code: ProtocolAuthorizationErrorCode;

  constructor(code: ProtocolAuthorizationErrorCode, message: string) {
    super(message);
    this.name = "ProtocolAuthorizationError";
    this.code = code;
  }
}

export function parseBotTelemetryMessage(input: unknown): BotTelemetryMessageV1 {
  return botTelemetryMessageV1Schema.parse(input);
}

export function parseBotStopResult(input: unknown): BotStopResultV1 {
  return botStopResultV1Schema.parse(input);
}

/**
 * Parses telemetry directly, but requires a separately trusted authorization
 * context for control messages. Parsing stopBotCommandV1Schema alone is never
 * sufficient authorization to execute a stop.
 */
export function parseBotProtocolMessage(
  input: unknown,
  authorizationContext?: ControlAuthorizationContext,
): BotProtocolMessageV1 {
  const message = botProtocolMessageV1Schema.parse(input);
  if (message.type !== "bot.stop.command.v1") {
    return message;
  }

  if (!authorizationContext) {
    throw new ProtocolAuthorizationError(
      "AUTH_CONTEXT_REQUIRED",
      "A trusted authorization context is required for control messages.",
    );
  }

  const authorization = message.payload.authorization;
  if (authorization.decisionId !== authorizationContext.decisionId) {
    throw new ProtocolAuthorizationError(
      "AUTH_DECISION_MISMATCH",
      "The authorization decision does not match the trusted context.",
    );
  }
  if (authorization.actorId !== authorizationContext.actorId) {
    throw new ProtocolAuthorizationError(
      "AUTH_ACTOR_MISMATCH",
      "The authorization actor does not match the trusted context.",
    );
  }
  if (message.botId !== authorizationContext.botId) {
    throw new ProtocolAuthorizationError(
      "AUTH_RESOURCE_MISMATCH",
      "The target bot does not match the trusted authorization context.",
    );
  }
  if (message.payload.commandId !== authorizationContext.commandId) {
    throw new ProtocolAuthorizationError(
      "AUTH_COMMAND_MISMATCH",
      "The command ID does not match the trusted authorization context.",
    );
  }
  if (!authorizationContext.permissions.has(authorization.permission)) {
    throw new ProtocolAuthorizationError(
      "AUTH_PERMISSION_DENIED",
      "The trusted context does not grant the required permission.",
    );
  }

  const now = (authorizationContext.now ?? new Date()).getTime();
  if (!Number.isFinite(now)) {
    throw new ProtocolAuthorizationError(
      "AUTH_CONTEXT_INVALID",
      "The trusted authorization context contains an invalid current time.",
    );
  }
  if (
    now > Date.parse(authorization.expiresAt) ||
    now > Date.parse(message.payload.expiresAt)
  ) {
    throw new ProtocolAuthorizationError(
      "AUTH_EXPIRED",
      "The control authorization or command has expired.",
    );
  }

  return message;
}
