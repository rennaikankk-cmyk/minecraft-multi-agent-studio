import type {
  SkillCapability,
  SkillJsonValue,
} from "@minecraft-studio/protocol";
import type { z } from "zod";

export type SkillRetryPolicy = Readonly<{
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrorCodes: readonly string[];
}>;

export type SkillPrecondition<TInput, TState> = Readonly<{
  id: string;
  failureCode: string;
  check(input: TInput, state: TState): boolean;
}>;

export type SkillCapabilityRequest = Readonly<{
  invocationId: string;
  traceId: string;
  taskId: string;
  botId: string;
  skillId: string;
  skillVersion: string;
  capability: SkillCapability;
  operation: string;
  input: SkillJsonValue;
  signal: AbortSignal;
}>;

export interface SkillCapabilityAdapter {
  invoke(request: SkillCapabilityRequest): Promise<unknown>;
}

export type SkillExecutionContext = Readonly<{
  invocationId: string;
  traceId: string;
  taskId: string;
  botId: string;
  signal: AbortSignal;
  deadlineMs: number;
  callCapability<TOutput extends SkillJsonValue = SkillJsonValue>(
    capability: SkillCapability,
    operation: string,
    input: SkillJsonValue,
  ): Promise<TOutput>;
}>;

export type SkillDefinition<TInput, TOutput, TState> = Readonly<{
  id: string;
  version: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  stateSchema: z.ZodType<TState>;
  requiredCapabilities: readonly SkillCapability[];
  timeoutMs: number;
  idempotent: boolean;
  retryPolicy: SkillRetryPolicy;
  preconditions: readonly SkillPrecondition<TInput, TState>[];
  execute(
    context: SkillExecutionContext,
    input: TInput,
    state: TState,
  ): Promise<TOutput>;
}>;

export type SkillMetadata = Readonly<{
  id: string;
  version: string;
  requiredCapabilities: readonly SkillCapability[];
  timeoutMs: number;
  idempotent: boolean;
  retryPolicy: SkillRetryPolicy;
  preconditionIds: readonly string[];
}>;

export type SkillExecutionAuthorization = Readonly<{
  decisionId: string;
  actorId: string;
  sourceInstanceId: string;
  traceId: string;
  taskId: string;
  botId: string;
  invocationId: string;
  skillId: string;
  skillVersion: string;
  issuedAt: string;
  expiresAt: string;
  allowedCapabilities: ReadonlySet<SkillCapability>;
}>;

export type SkillExecutorOptions = Readonly<{
  runtimeInstanceId: string;
  capabilityAdapter?: SkillCapabilityAdapter;
  now?: () => Date;
  random?: () => number;
  messageId?: () => string;
}>;

export function defineSkill<TInput, TOutput, TState>(
  definition: SkillDefinition<TInput, TOutput, TState>,
): SkillDefinition<TInput, TOutput, TState> {
  return definition;
}
