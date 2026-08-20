import { z } from "zod";

export const aiTaskTypeSchema = z.enum([
  "planner",
  "chat",
  "strategy",
  "task-decomposition",
  "failure-analysis",
  "skill-selection",
  "team-coordination",
]);

export type AITaskType = z.infer<typeof aiTaskTypeSchema>;

export const AI_PRIORITIES = Object.freeze({
  SYSTEM_CRITICAL_PLANNING: 0,
  COMBAT_STRATEGY: 10,
  TASK_RECOVERY: 20,
  NORMAL_PLANNING: 30,
  EXPLORATION: 50,
  CHAT: 80,
  BACKGROUND_SUMMARY: 100,
} as const);

const safeVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const aiRequestEnvelopeSchema = z
  .object({
    requestId: z.string().uuid(),
    traceId: z.string().min(1).max(128),
    botId: z.string().min(1).max(128),
    taskId: z.string().min(1).max(128).optional(),
    taskType: aiTaskTypeSchema,
    priority: z.number().int().min(0).max(1_000),
    timestamp: z.string().datetime({ offset: true }),
    stateVersion: safeVersionSchema,
    taskVersion: safeVersionSchema,
    prompt: z.string().min(1).max(2_000_000),
    systemPrompt: z.string().min(1).max(500_000).optional(),
    maxTokens: z.number().int().positive().max(1_000_000),
    temperature: z.number().min(0).max(2),
    timeoutMs: z.number().int().positive().max(3_600_000),
    preferredProvider: z.string().min(1).max(128).optional(),
  })
  .strict();

export type AIRequestEnvelope = z.infer<typeof aiRequestEnvelopeSchema>;

export type JSONSchema = Readonly<Record<string, unknown>>;

export type AIOutputContract<T> = Readonly<{
  name: string;
  schema: z.ZodType<T>;
  jsonSchema?: JSONSchema;
}>;

export type AIRequest<T = unknown> = AIRequestEnvelope &
  Readonly<{
    output?: AIOutputContract<T>;
  }>;

export function parseAIRequest<T>(request: AIRequest<T>): AIRequest<T> {
  const { output, ...unvalidatedEnvelope } = request;
  const envelope = aiRequestEnvelopeSchema.safeParse(unvalidatedEnvelope);
  if (!envelope.success) throw new Error("AI_REQUEST_INVALID");
  if (output !== undefined) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(output.name)) {
      throw new Error("AI_REQUEST_INVALID");
    }
    if (typeof output.schema?.safeParse !== "function") {
      throw new Error("AI_REQUEST_INVALID");
    }
  }
  return Object.freeze({
    ...envelope.data,
    ...(output === undefined ? {} : { output }),
  }) as AIRequest<T>;
}

export function isHighLevelPlanningTask(taskType: AITaskType): boolean {
  return taskType !== "chat";
}
