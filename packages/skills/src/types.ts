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

/**
 * 技能在前置条件里能看到的策略视图——**只读裁决，不能记账、不能改策略**。
 *
 * 故意做成结构化窄接口而不是直接引用 `ServerPolicyGate`：
 *   - 前置条件必须是纯判断。给到完整闸门就等于把 `recordAction` 交到
 *     前置条件手里，被拒绝的尝试也会占用频率配额。
 *   - 框架层不依赖 policy 模块的具体实现，`ServerPolicyGate` 结构上满足即可。
 */
export interface SkillPolicyView {
  readonly serverProfileId: string;
  checkBlockReach(distance: number): Readonly<{ allowed: boolean }>;
  checkAttackReach(distance: number): Readonly<{ allowed: boolean }>;
}

/**
 * 前置条件。`policy` 是当前生效的服务器策略视图：reach 之类的边界从这里读，
 * 不再由各技能写死常量——否则策略档位换了技能行为不变（AGENTS.md §2）。
 *
 * 参数可选是为了不逼着"在线""维度一致"这类与策略无关的检查签收一个用不到的
 * 形参；TypeScript 允许实现少写形参，所以两类前置条件可以并存。
 */
export type SkillPrecondition<TInput, TState> = Readonly<{
  id: string;
  failureCode: string;
  check(input: TInput, state: TState, policy: SkillPolicyView): boolean;
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

/**
 * 一次终态失败里被丢掉的那半。`errorCode` 只说得出"哪一类坏了"，`reason` 才说得出
 * 究竟坏在哪：能力实现里那句 `catch { throw new SkillFault(CODE) }` 会把底层库抛
 * 出的原因整个吞掉，于是排查只剩翻 mineflayer 自己的输出。这个诊断把原因交还给
 * 宿主去记，而协议结果一个字不改——上报给协调器的仍然只有 `errorCode`。
 */
export type SkillFaultDiagnostic = Readonly<{
  traceId: string;
  taskId: string;
  skillId: string;
  skillVersion: string;
  invocationId: string;
  errorCode: string;
  attempts: number;
  /** 底层原因；能力实现没留下任何说明时为 null，不编造替代文本。 */
  reason: string | null;
}>;

export type SkillExecutorOptions = Readonly<{
  runtimeInstanceId: string;
  capabilityAdapter?: SkillCapabilityAdapter;
  /**
   * 终态失败时收下被屏蔽的原因，仅供宿主侧日志。不参与重试判定，也不进结果载荷。
   */
  onFault?: (diagnostic: SkillFaultDiagnostic) => void;
  now?: () => Date;
  random?: () => number;
  messageId?: () => string;
  /**
   * 当前生效的服务器策略视图，按 bot 所连的 serverProfileId 解析。
   *
   * 不传时执行器用 STRICT 基线（`DEFAULT_UNKNOWN_SERVER_PROFILE`）——服务器策略
   * 未知就按最保守档走，不退回原版 4.5 格。这是 fail-closed，不是默认放宽。
   */
  policyView?: (serverProfileId: string) => SkillPolicyView;
}>;

export function defineSkill<TInput, TOutput, TState>(
  definition: SkillDefinition<TInput, TOutput, TState>,
): SkillDefinition<TInput, TOutput, TState> {
  return definition;
}
