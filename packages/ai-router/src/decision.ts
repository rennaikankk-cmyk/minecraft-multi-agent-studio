import { z } from "zod";

export type JSONPrimitive = null | boolean | number | string;
export interface JSONArray extends ReadonlyArray<JSONValue> {}
export interface JSONObject {
  readonly [key: string]: JSONValue;
}
export type JSONValue = JSONPrimitive | JSONArray | JSONObject;

const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(16_384),
    z.array(jsonValueSchema).max(256),
    z.record(jsonValueSchema).refine((value) => Object.keys(value).length <= 256, {
      message: "JSON objects may contain at most 256 properties.",
    }),
  ]),
);

const reasonSchema = z.string().trim().min(1).max(1_024);
const confidenceSchema = z.number().finite().min(0).max(1);

export const aiSkillDecisionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("execute_skill"),
      skill: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/u),
      arguments: z
        .record(jsonValueSchema)
        .refine((value) => Object.keys(value).length <= 128, {
          message: "Skill arguments may contain at most 128 top-level properties.",
        }),
      reason: reasonSchema,
      confidence: confidenceSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("wait"),
      reason: reasonSchema,
      confidence: confidenceSchema,
    })
    .strict(),
]);

export type AISkillDecision = z.infer<typeof aiSkillDecisionSchema>;

export const aiSkillDecisionJsonSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  oneOf: [
    {
      additionalProperties: false,
      required: ["action", "skill", "arguments", "reason", "confidence"],
      properties: {
        action: { const: "execute_skill" },
        skill: { type: "string", pattern: "^[A-Za-z0-9_.-]+$", maxLength: 128 },
        arguments: { type: "object", maxProperties: 128 },
        reason: { type: "string", minLength: 1, maxLength: 1_024 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    {
      additionalProperties: false,
      required: ["action", "reason", "confidence"],
      properties: {
        action: { const: "wait" },
        reason: { type: "string", minLength: 1, maxLength: 1_024 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
  ],
} as const);
