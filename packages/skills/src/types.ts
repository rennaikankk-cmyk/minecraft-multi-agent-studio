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

export type SkillResourceKind = "item" | "block" | "entity";

export type SkillCompatibilityRequirement =
  | Readonly<{
      kind: "feature";
      name: string;
    }>
  | Readonly<{
      kind: "resource";
      resource: SkillResourceKind;
      names: readonly string[];
      match: "any" | "all";
    }>
  | Readonly<{
      kind: "server-capability";
      name: string;
    }>;

/**
 * One skill implementation may expose ordered compatibility variants. The
 * first variant whose requirements are satisfied is selected. This lets a
 * portable skill keep one semantic ID while using a legacy or modern adapter
 * branch, without treating every non-primary Minecraft version as unusable.
 */
export type SkillCompatibilityVariant = Readonly<{
  id: string;
  requirements: readonly SkillCompatibilityRequirement[];
  verifiedMinecraftVersions: readonly string[];
}>;

export type SkillCompatibilityManifest = Readonly<{
  variants: readonly SkillCompatibilityVariant[];
}>;

export interface SkillCompatibilityEnvironment {
  readonly minecraftVersion: string;
  readonly protocolVersion: number;
  supportsFeature(name: string): boolean | undefined;
  hasResource(kind: SkillResourceKind, name: string): boolean | undefined;
  serverCapability(name: string): boolean | undefined;
}

export type SkillCompatibilityUnmetRequirement = Readonly<{
  requirement: SkillCompatibilityRequirement;
  status: "missing" | "unknown";
}>;

export type SkillVariantCompatibility = Readonly<{
  variantId: string;
  available: boolean;
  verification: "verified" | "unverified";
  unmetRequirements: readonly SkillCompatibilityUnmetRequirement[];
}>;

export type SkillCompatibilityResolution = Readonly<{
  skillId: string;
  skillVersion: string;
  minecraftVersion: string | null;
  protocolVersion: number | null;
  availability: "available" | "unavailable";
  verification: "verified" | "unverified";
  selectedVariantId: string | null;
  variants: readonly SkillVariantCompatibility[];
}>;

export type SkillExecutionCompatibility = Readonly<{
  minecraftVersion: string | null;
  protocolVersion: number | null;
  variantId: string;
  verification: "verified" | "unverified";
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
  compatibility: SkillExecutionCompatibility;
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
  compatibility: SkillCompatibilityManifest;
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
  compatibility: SkillCompatibilityManifest;
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
