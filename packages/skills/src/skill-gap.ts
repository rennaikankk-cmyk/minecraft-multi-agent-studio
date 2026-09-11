// ---------------------------------------------------------------------------
// skill-gap.ts —— Skill Gap 域模型：taxonomy、fingerprint、分类器、resolver
// 链（SG1 提示词 §二-§六）。
//
// 纪律：
//   1. 失败的 Goal ≠ 缺 Skill。路径/Runtime/Server/Policy 故障不产生 Gap。
//   2. 分类只看 stable FailureCode/schema/catalog——禁止解析日志文案。
//   3. 同一 fingerprint 聚合，不爆炸。
//   4. 优先组合现有 Skill，Profile/Blueprint 不是 Skill。
//   5. Observation gap 不用 LLM 编造事实。
//   6. Policy denied 永不产生 bypass 开发任务。
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Gap taxonomy（SG1 §二）
// ---------------------------------------------------------------------------

export const capabilityGapKinds = [
  "existing_skill_composition_missing",
  "skill_not_advertised",
  "skill_not_compatible",
  "skill_contract_mismatch",
  "capability_not_available",
  "capability_backend_missing",
  "server_profile_missing",
  "server_behavior_unknown",
  "blueprint_missing",
  "template_version_unverified",
  "observation_insufficient",
  "grounding_fact_missing",
  "policy_denied",
  "resource_dependency_missing",
  "planner_decomposition_gap",
  "unknown_gap",
] as const;
export const capabilityGapKindSchema = z.enum(capabilityGapKinds);
export type CapabilityGapKind = z.infer<typeof capabilityGapKindSchema>;

export const skillGapStatuses = [
  "detected",
  "deduplicated",
  "triaging",
  "composition_candidate",
  "profile_candidate",
  "blueprint_candidate",
  "development_requested",
  "draft",
  "sandboxed",
  "verified",
  "canary",
  "active",
  "rejected",
  "revoked",
  "deferred",
] as const;
export const skillGapStatusSchema = z.enum(skillGapStatuses);
export type SkillGapStatus = z.infer<typeof skillGapStatusSchema>;

// ---------------------------------------------------------------------------
// Gap request schema
// ---------------------------------------------------------------------------

const identifierSchema = z.string().min(1).max(128);

export const skillGapRequestSchema = z
  .object({
    gapId: identifierSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{16,64}$/u),
    kind: capabilityGapKindSchema,
    status: skillGapStatusSchema,
    severity: z.enum(["info", "warning", "error", "critical"]),
    createdAtMs: z.number().int(),
    firstSeenAtMs: z.number().int(),
    lastSeenAtMs: z.number().int(),
    occurrenceCount: z.number().int().min(1),

    project: z.object({
      gitCommit: z.string().regex(/^[0-9a-f]{7,40}$/u),
      branch: z.string().max(128),
      buildVersion: z.string().max(64),
      dirty: z.boolean(),
    }).strict(),

    runtime: z.object({
      botId: identifierSchema,
      serverProfileId: identifierSchema,
      minecraftVersion: z.string().max(32).optional(),
      protocolVersion: z.number().int().optional(),
    }).strict(),

    goal: z.object({
      goalText: z.string().max(500).optional(),
      taskId: identifierSchema.optional(),
      requestedOutcome: z.string().max(300),
    }).strict(),

    gap: z.object({
      requestedSkillId: z.string().max(128).optional(),
      requestedCapability: z.string().max(128).optional(),
      actionFamily: z.string().max(64),
      terminalFailureCode: z.string().max(128),
      causedByFailureCodes: z.array(z.string().max(128)).max(32),
    }).strict(),

    linkedIncidentIds: z.array(identifierSchema).max(64),
  })
  .strict();
export type SkillGapRequest = z.infer<typeof skillGapRequestSchema>;

// ---------------------------------------------------------------------------
// Fingerprint（SG1 §五）——deterministic，排除 botId/时间戳/坐标/sessionId
// ---------------------------------------------------------------------------

export interface GapFingerprintInput {
  kind: CapabilityGapKind;
  actionFamily: string;
  requestedSkillId?: string;
  requestedCapability?: string;
  terminalFailureCode: string;
  minecraftVersion?: string;
}

/** 生成 gap fingerprint（SHA-256 截取 16 字节 hex）。deterministic 纯函数。 */
export function gapFingerprint(input: GapFingerprintInput): string {
  const parts = [
    input.kind,
    input.actionFamily,
    input.requestedSkillId ?? "",
    input.requestedCapability ?? "",
    input.terminalFailureCode,
    input.minecraftVersion ?? "",
  ];
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// 确定性分类器（SG1 §四）——FailureCode → GapKind
// ---------------------------------------------------------------------------

/** 非能力缺口的 FailureCode 前缀/精确值（这些走普通 Incident 修复）。 */
const NON_GAP_FAILURE_CODES: ReadonlySet<string> = new Set([
  // 路径/Runtime 修复类
  "PATH_NO_PROGRESS", "PATH_OSCILLATION", "PATH_REPLAN_STORM", "PATH_UNREACHABLE",
  "PATHFINDER_GOTO_FAILED",
  // 生命周期（Round 6.6 新增）
  "GOAL_EXPIRED_WAITING_FOR_BOT", "BOT_READINESS_TIMEOUT",
  "GOAL_WAITING_FOR_BOT",
  // 网络/连接
  "NETWORK_DISCONNECTED", "SERVER_KICKED", "SERVER_RECONNECT_LOOP", "SERVER_READINESS_TIMEOUT",
  // AI 不可用
  "AI_NODE_UNREACHABLE", "AI_MODEL_DISCOVERY_FAILED", "AI_QUEUE_FULL", "AI_QUEUE_TIMEOUT",
  "LLM_REQUEST_TIMEOUT", "LLM_OUTPUT_INVALID", "LLM_SCHEMA_VALIDATION_FAILED",
  // Bot 生命周期
  "BOT_PROCESS_EXITED", "BOT_RESTART_EXHAUSTED", "BOT_FORCED_STOP_TIMEOUT",
  "BOT_STARTUP_FAILED", "BOT_EXTERNAL_TERMINATION",
  // 安全预占
  "NORMAL_ACTIONS_PAUSED", "MINE_LAVA_ADJACENT",
]);

/** 分类规则：FailureCode → GapKind（deterministic，无日志解析）。 */
export function classifyGap(input: {
  terminalFailureCode: string;
  causedByFailureCodes: readonly string[];
  actionFamily: string;
  requestedSkillId?: string;
  /** 现有 skill catalog 中是否已有该 skillId。 */
  skillExists: boolean;
  /** 该 skill 的 compatibility 是否在目标版本可用。 */
  skillCompatible: boolean;
  /** planner 是否有现有可组合方案。 */
  hasCompositionCandidate: boolean;
  /** capability dispatcher 是否支持该动作。 */
  capabilityAvailable: boolean;
  /** 操作是否被 policy 明确拒绝。 */
  policyDenied: boolean;
}): CapabilityGapKind | null {
  // Policy denied → 分类但不创建 bypass
  if (input.policyDenied) return "policy_denied";

  // 非能力缺口 → 不产生 Gap（走普通 Incident）
  if (NON_GAP_FAILURE_CODES.has(input.terminalFailureCode)) return null;
  if (input.causedByFailureCodes.some((code) => NON_GAP_FAILURE_CODES.has(code))) return null;

  // 确定性分类链（SG1 §四建议顺序）
  if (input.terminalFailureCode === "PLANNER_SKILL_CATALOG_UNAVAILABLE") {
    return "skill_not_advertised";
  }
  if (input.terminalFailureCode === "PLANNER_SKILL_CATALOG_UNAVAILABLE" ||
      input.terminalFailureCode === "FEATURE_GATE_DISABLED") {
    return "skill_not_compatible";
  }
  if (input.terminalFailureCode === "BLUEPRINT_ANCHOR_INVALID" ||
      input.terminalFailureCode === "BUILD_MATERIAL_MISSING") {
    return "blueprint_missing";
  }
  if (input.terminalFailureCode === "COMPAT_PROFILE_UNKNOWN" ||
      input.terminalFailureCode === "COMPAT_PROFILE_EXPIRED" ||
      input.terminalFailureCode === "VERSION_BEHAVIOR_MISMATCH") {
    return "server_behavior_unknown";
  }
  if (input.terminalFailureCode === "SERVER_VERSION_MISMATCH") {
    return "server_profile_missing";
  }
  if (input.terminalFailureCode === "PLANNER_INPUT_UNGROUNDED") {
    return "grounding_fact_missing";
  }
  if (input.terminalFailureCode === "SKILL_VERIFY_FAILED") {
    return "skill_contract_mismatch";
  }

  // 基于 catalog/compatibility 状态分流
  if (input.skillExists && input.skillCompatible && input.hasCompositionCandidate) {
    return "existing_skill_composition_missing";
  }
  if (input.skillExists && !input.skillCompatible) {
    return "skill_not_compatible";
  }
  if (input.skillExists && input.skillCompatible && !input.capabilityAvailable) {
    return "capability_not_available";
  }
  if (!input.skillExists && !input.capabilityAvailable) {
    return "capability_backend_missing";
  }
  if (!input.skillExists && input.capabilityAvailable) {
    return "skill_not_advertised";
  }

  return "unknown_gap";
}

// ---------------------------------------------------------------------------
// Resolver 优先级链（SG1 §六）
// ---------------------------------------------------------------------------

export const RESOLVER_CHAIN = Object.freeze([
  "existing_composition",
  "profile",
  "blueprint",
  "observation",
  "new_skill",
  "new_capability",
] as const);
export type ResolverKind = (typeof RESOLVER_CHAIN)[number];

/** GapKind → 推荐的 resolver（分流表）。 */
const KIND_TO_RESOLVER: Readonly<Record<CapabilityGapKind, ResolverKind>> = Object.freeze({
  existing_skill_composition_missing: "existing_composition",
  skill_not_advertised: "existing_composition",
  skill_not_compatible: "profile",
  skill_contract_mismatch: "new_skill",
  capability_not_available: "new_skill",
  capability_backend_missing: "new_capability",
  server_profile_missing: "profile",
  server_behavior_unknown: "profile",
  blueprint_missing: "blueprint",
  template_version_unverified: "blueprint",
  observation_insufficient: "observation",
  grounding_fact_missing: "observation",
  policy_denied: "existing_composition", // 不产生 bypass，标记 policy
  resource_dependency_missing: "existing_composition",
  planner_decomposition_gap: "existing_composition",
  unknown_gap: "existing_composition",
});

export function recommendedResolver(kind: CapabilityGapKind): ResolverKind {
  return KIND_TO_RESOLVER[kind];
}

// ---------------------------------------------------------------------------
// Release lifecycle（SG1 §十二）
// ---------------------------------------------------------------------------

export const skillReleaseStatuses = [
  "draft",
  "sandboxed",
  "verified",
  "canary",
  "active",
  "revoked",
] as const;
export const skillReleaseStatusSchema = z.enum(skillReleaseStatuses);
export type SkillReleaseStatus = z.infer<typeof skillReleaseStatusSchema>;

/** Release 状态合法转换（draft 不进 catalog；canary→active 或→revoked）。 */
export const RELEASE_TRANSITIONS: Readonly<
  Record<SkillReleaseStatus, readonly SkillReleaseStatus[]>
> = Object.freeze({
  draft: ["sandboxed", "rejected" as SkillReleaseStatus, "revoked"],
  sandboxed: ["verified", "revoked"],
  verified: ["canary", "revoked"],
  canary: ["active", "revoked"],
  active: ["revoked"],
  revoked: [],
});

export function canTransitionRelease(
  from: SkillReleaseStatus,
  to: SkillReleaseStatus,
): boolean {
  return RELEASE_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Development mode（SG1 §八）
// ---------------------------------------------------------------------------

export const skillDevelopmentModes = [
  "disabled",
  "export_only",
  "proposal",
  "sandbox_auto",
] as const;
export const skillDevelopmentModeSchema = z.enum(skillDevelopmentModes);
export type SkillDevelopmentMode = z.infer<typeof skillDevelopmentModeSchema>;

/** 默认安全模式：只导出 bundle，不自动开发。 */
export const DEFAULT_DEVELOPMENT_MODE: SkillDevelopmentMode = "export_only";

// ---------------------------------------------------------------------------
// Gap store（bounded in-memory + fingerprint 去重）
// ---------------------------------------------------------------------------

export interface SkillGapStoreOptions {
  maxGaps?: number;
  now?: () => number;
}

const DEFAULT_MAX_GAPS = 512;

export class SkillGapStore {
  private readonly gaps = new Map<string, SkillGapRequest>();
  private readonly maxGaps: number;
  private readonly now: () => number;
  private droppedCount = 0;

  constructor(options: SkillGapStoreOptions = {}) {
    this.maxGaps = options.maxGaps ?? DEFAULT_MAX_GAPS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 记录一个 gap。同 fingerprint 聚合（occurrenceCount++），不创建重复条目。
   * 满时丢弃最低 severity 的最旧条目（不阻塞调用方）。
   */
  record(input: Omit<SkillGapRequest, "gapId" | "occurrenceCount" | "createdAtMs" | "firstSeenAtMs" | "lastSeenAtMs" | "status">): SkillGapRequest {
    const existing = this.gaps.get(input.fingerprint);
    if (existing !== undefined) {
      const updated: SkillGapRequest = {
        ...existing,
        occurrenceCount: existing.occurrenceCount + 1,
        lastSeenAtMs: this.now(),
        status: "deduplicated",
      };
      this.gaps.set(input.fingerprint, updated);
      return updated;
    }
    if (this.gaps.size >= this.maxGaps) {
      this.evictOldest();
      this.droppedCount += 1;
    }
    const nowMs = this.now();
    const gap: SkillGapRequest = {
      ...input,
      gapId: `gap-${input.fingerprint.slice(0, 12)}`,
      occurrenceCount: 1,
      createdAtMs: nowMs,
      firstSeenAtMs: nowMs,
      lastSeenAtMs: nowMs,
      status: "detected",
    };
    this.gaps.set(input.fingerprint, gap);
    return gap;
  }

  get(fingerprint: string): SkillGapRequest | null {
    return this.gaps.get(fingerprint) ?? null;
  }

  /**
   * 持久化恢复专用：原样写回一条完整 gap（保留 occurrenceCount 与时间戳，
   * 不走 record 的聚合/eviction 路径）。仅 FileSkillGapStore 启动恢复使用。
   */
  restore(gap: SkillGapRequest): void {
    const validated = skillGapRequestSchema.parse(gap);
    this.gaps.set(validated.fingerprint, validated);
  }

  list(): readonly SkillGapRequest[] {
    return [...this.gaps.values()].sort((a, b) => b.occurrenceCount - a.occurrenceCount);
  }

  get size(): number {
    return this.gaps.size;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    let lowestSeverity = 5;
    for (const [key, gap] of this.gaps) {
      const sevRank = gap.severity === "info" ? 0 : gap.severity === "warning" ? 1 : 2;
      if (sevRank < lowestSeverity || (sevRank === lowestSeverity && gap.lastSeenAtMs < oldestTime)) {
        oldestKey = key;
        oldestTime = gap.lastSeenAtMs;
        lowestSeverity = sevRank;
      }
    }
    if (oldestKey !== null) this.gaps.delete(oldestKey);
  }
}
