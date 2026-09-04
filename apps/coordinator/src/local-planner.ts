import { randomUUID } from "node:crypto";

import {
  aiRequestPriorities,
  parseStructuredOutput,
  type AIScheduledResult,
  type GenerateResult,
  type ScheduledAIRouter,
} from "@minecraft-studio/ai-router";
import type {
  AppLogger,
  LifecycleMetricName,
  MetricRecorder,
} from "@minecraft-studio/observability";
import {
  goalResultSummaryFromOutput,
  identifierSchema,
  parseSkillExecutionResult,
  type BotSkillCatalogEntryV1,
  skillIdentifierSchema,
  skillInvocationV1Schema,
  skillJsonValueSchema,
  skillVersionSchema,
  type SkillExecutionResultV1,
  type SkillInvocationV1,
  type SkillJsonValue,
} from "@minecraft-studio/protocol";
import {
  GoalPlanner,
  PlanSupervisor,
  acquireWorkstation,
  type FacilityFailureSignal,
  type GoalRequest,
  type PlanStep,
  type PlannerInventory,
  type StepOutcome,
  type SupervisionResult,
  type WorkstationRegistryPort,
} from "@minecraft-studio/skills";
import {
  PersistentTaskStateMachine,
  TaskExecutionError,
  type TaskExecutionRecord,
} from "@minecraft-studio/task-system";
import { z } from "zod";
import { appendFileSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { BotRegistry, BotRegistryRecord } from "./bot-registry.js";
import { InMemoryGoalLifecycleStore } from "./in-memory-goal-store.js";
import {
  applyStepResult,
  newPlanJournal,
  recordDispatch,
  type PlanExecutionJournal,
  type PlanJournalStore,
} from "./plan-journal.js";
import {
  BotAssignmentError,
  type BotAssignmentService,
} from "./bot-assignment.js";
import {
  parseBlueprintFileGoal,
  parseDeterministicGoal,
  type DeterministicGoal,
  type DeterministicPlanItemsDecision,
  type DeterministicSkillDecision,
} from "./deterministic-goals.js";
import {
  blueprintCellsForDispatch,
  loadBlueprintFiles,
  type BlueprintFile,
} from "./blueprint-files.js";
import {
  buildLocalPlannerPrompt,
  LOCAL_PLANNER_PROMPT_VERSION,
  LOCAL_PLANNER_SYSTEM_PROMPT,
} from "./planner-prompts.js";

export const LOCAL_PLANNER_REASON_CODES = Object.freeze([
  "ADVANCE_TASK",
  "MISSING_REQUIRED_INPUT",
  "NO_MATCHING_SKILL",
  "NO_SAFE_SKILL",
  "POLICY_RESTRICTED",
  "RAW_ACTION_FORBIDDEN",
  "UNGROUNDED_INPUT",
  "UNSUPPORTED_ACTION",
] as const);
const reasonCodeSchema = z.enum(LOCAL_PLANNER_REASON_CODES);
const TRUSTED_SERVER_PROFILE_PLACEHOLDER = "$CURRENT_SERVER_PROFILE";
// Operator cancellation is trusted only from AbortSignal/task state. Runtime
// SKILL_CANCELLED is also emitted when L0 preempts an active normal Skill.
const RECOVERABLE_L0_ERROR_CODES = new Set([
  "NORMAL_ACTIONS_PAUSED",
  "SKILL_CANCELLED",
  "SKILL_EXECUTION_INTERRUPTED",
]);
/**
 * 技能派发握手余量（L6/L7 拥挤 fixture 实证 2026-09-03）：协调器的等待/
 * invocation 过期从 **dispatch 时刻**起算 skill.timeoutMs，而 runtime 侧的
 * 执行预算从**握手完成后**才起算（executor 自带同值硬停）。负载下
 * dispatch→invoke 握手实测 ~3s（5-bot），协调器先于 runtime 自身超时
 * 触发取消——goal 在临完成前数百 ms 被杀（RUNTIME_LINK_RESULT_NOT_PENDING
 * 迟到结果为证）。加余量只修正等待窗记账：执行预算仍由 executor 本地
 * timeoutMs 从执行起硬停，不被此值放大。
 * STUDIO_SKILL_DISPATCH_GRACE_MS：有界测试旋钮（0-60000，垃圾值 fail-closed
 * 回默认），与 movement 旋钮同纪律——不改变生产缺省契约。
 */
function skillDispatchHandshakeGraceMs(): number {
  const raw = process.env.STUDIO_SKILL_DISPATCH_GRACE_MS?.trim();
  if (raw === undefined || raw === "") return 10_000;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || value > 60_000) return 10_000;
  return value;
}
const DEFAULT_SAFETY_RECOVERY_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_SAFETY_RECOVERY_WAIT_MS = 30_000;

const localPlannerNoopDecisionSchema = z
  .object({
    action: z.literal("noop"),
    botId: identifierSchema,
    taskId: identifierSchema,
    reasonCode: reasonCodeSchema,
  })
  .strict();

/**
 * A catalog entry as constrained generation needs it. `inputSchema` is optional
 * so callers that only know IDs and versions still compile; supplying it lets
 * the grammar constrain that Skill's input instead of accepting any JSON.
 */
export type LocalPlannerGenerationSkill = Pick<
  BotSkillCatalogEntryV1,
  "skillId" | "skillVersion"
> &
  Partial<Pick<BotSkillCatalogEntryV1, "inputSchema">>;

/**
 * The trusted identity a decision must echo back. The Coordinator already owns
 * both values and rejects any deviation as PLANNER_DECISION_MISMATCH, so
 * generation never needs to produce them freely.
 */
export type LocalPlannerTrustedIdentity = Readonly<{
  botId: string;
  taskId: string;
}>;

/**
 * Narrows `botId`/`taskId` to the exact trusted values for constrained
 * generation. Free-form identifier generation leaves a region where the grammar
 * accepts arbitrary whitespace, and a model that has already decided the
 * outcome can stall there until `max_tokens` instead of emitting the remaining
 * required keys. Pinning removes that region without weakening validation: the
 * full protocol schema still re-parses the response before dispatch.
 */
function trustedIdentityFields(identity: LocalPlannerTrustedIdentity | undefined) {
  if (!identity) return { botId: identifierSchema, taskId: identifierSchema };
  const trusted = z.object({ botId: identifierSchema, taskId: identifierSchema });
  const parsed = trusted.safeParse(identity);
  if (!parsed.success) {
    throw new LocalPlannerError(
      "PLANNER_DECISION_MISMATCH",
      "Trusted planner identity is not a valid identifier pair.",
    );
  }
  return {
    botId: z.literal(parsed.data.botId),
    taskId: z.literal(parsed.data.taskId),
  };
}

const planGoalItemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);
const planGoalSchema = z
  .object({
    itemName: planGoalItemNameSchema,
    // The free-form goal API has no trusted structured quantity. Keep this
    // branch single-item until the operator supplies quantity as typed data.
    count: z.literal(1),
  })
  .strict();

function localPlannerInvokeDecisionSchema<
  InputSchema extends z.ZodType = typeof skillJsonValueSchema,
>(
  skillIdSchema: z.ZodType<string>,
  skillVersionValueSchema: z.ZodType<string>,
  inputValueSchema: InputSchema = skillJsonValueSchema as unknown as InputSchema,
) {
  return z
    .object({
      action: z.literal("invoke_skill"),
      botId: identifierSchema,
      taskId: identifierSchema,
      skillId: skillIdSchema,
      skillVersion: skillVersionValueSchema,
      input: inputValueSchema,
      reasonCode: reasonCodeSchema,
    })
    .strict();
}

/**
 * Builds one constrained invoke branch per catalog Skill, pairing each exact
 * `skillId`/`skillVersion` with that Skill's own advertised input schema.
 *
 * A single shared branch has to type `input` as arbitrary JSON, which is the
 * only unconstrained region left in the decision grammar once identity and
 * reason codes are pinned. Constrained decoding then steers away from
 * `invoke_skill` toward the branches the grammar actually describes, so Skills
 * never get invoked. Compiling each advertised schema into its own branch
 * removes that asymmetry. This narrows generation only; every decision is still
 * re-parsed by the protocol schema and re-validated against the advertised
 * schema before dispatch.
 *
 * A Skill whose advertised schema will not compile is omitted rather than
 * widened back to arbitrary JSON: `validateAdvertisedInput` would reject its
 * dispatch anyway, so advertising it for generation could only produce a
 * decision that cannot be executed.
 */
function localPlannerInvokeBranches(
  availableSkills: readonly LocalPlannerGenerationSkill[],
): z.ZodType[] {
  const branches: z.ZodType[] = [];
  for (const { skillId, skillVersion, inputSchema } of availableSkills) {
    if (inputSchema === undefined) continue;
    let inputValueSchema: z.ZodType;
    try {
      inputValueSchema = z.fromJSONSchema(
        plannerInputSchema(inputSchema) as Parameters<
          typeof z.fromJSONSchema
        >[0],
      );
    } catch {
      continue;
    }
    branches.push(
      localPlannerInvokeDecisionSchema(
        z.literal(skillId),
        z.literal(skillVersion),
        inputValueSchema,
      ),
    );
  }
  return branches;
}

function localPlannerPlanItemsDecisionSchema(
  itemNameValueSchema: z.ZodType<string>,
) {
  return z
    .object({
      action: z.literal("plan_items"),
      botId: identifierSchema,
      taskId: identifierSchema,
      goals: z
        .array(planGoalSchema.extend({ itemName: itemNameValueSchema }))
        .length(1),
      reasonCode: reasonCodeSchema,
    })
    .strict();
}

export const localPlannerDecisionSchema = z.discriminatedUnion("action", [
  localPlannerNoopDecisionSchema,
  localPlannerInvokeDecisionSchema(skillIdentifierSchema, skillVersionSchema),
  localPlannerPlanItemsDecisionSchema(planGoalItemNameSchema),
]);

/**
 * Ollama's grammar compiler cannot parse the full SemVer regex used by the
 * protocol schema. Generation can be narrower than the protocol: advertise
 * only exact catalog IDs and versions, then parse the response again with the
 * complete protocol-backed schema before dispatch.
 */
export function buildLocalPlannerGenerationSchema(
  availableSkills: readonly LocalPlannerGenerationSkill[],
  plannedItemNames: readonly string[] = new GoalPlanner().resourceGraph.knownItemNames(),
  trustedIdentity?: LocalPlannerTrustedIdentity,
) {
  const identity = trustedIdentityFields(trustedIdentity);
  const skillIds = [...new Set(availableSkills.map(({ skillId }) => skillId))];
  const skillVersions = [
    ...new Set(availableSkills.map(({ skillVersion }) => skillVersion)),
  ];
  if (skillIds.length === 0 || skillVersions.length === 0) {
    throw new LocalPlannerError(
      "PLANNER_SKILL_CATALOG_UNAVAILABLE",
      "Bot Runtime has no versions available for constrained generation.",
    );
  }
  const perSkillInvokeBranches = localPlannerInvokeBranches(availableSkills).map(
    (branch) => (branch as z.ZodObject).extend(identity),
  );
  const invokeBranches = perSkillInvokeBranches.length > 0
    ? perSkillInvokeBranches
    : [
        localPlannerInvokeDecisionSchema(
          z.enum(skillIds as [string, ...string[]]),
          z.enum(skillVersions as [string, ...string[]]),
        ).extend(identity),
      ];
  const noopSchema = localPlannerNoopDecisionSchema.extend(identity);
  const itemNames = [...new Set(plannedItemNames)].filter(
    (itemName) => planGoalItemNameSchema.safeParse(itemName).success,
  );
  const branches: z.ZodType[] = [noopSchema, ...invokeBranches];
  if (itemNames.length > 0) {
    branches.push(
      localPlannerPlanItemsDecisionSchema(
        z.enum(itemNames as [string, ...string[]]),
      ).extend(identity),
    );
  }
  return z.union(branches as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

/**
 * 取得类动词。中文一侧此前只认书面的"获取/制作/采集/收集/合成"，
 * 而"做一个熔炉""挖点铁矿"这类最常见的口语说法一个都不匹配——目标里明明写了
 * 可达物品，却因为动词没登记而降级成 noop。英文一侧早已同时收 make 与 build，
 * 中文补齐到同一水位。
 *
 * 放宽的只是"这句话是不是在要东西"，不是任何安全判定：候选仍只能来自
 * 确定性规划器已证明可达的集合，且必须唯一命中，否则照样返回 null。
 *
 * 2026-08-26：上一轮补齐仍然漏了中文最常用的"获得"。实测一条 live 目标
 * "获得一把木镐" 因此降级成 noop/NO_SAFE_SKILL——别名表里 `木镐` 在，
 * 只是动词没登记；同一句换成"获取"立刻解析出 wooden_pickaxe。同批实测为 null
 * 的还有 得到/拿到/弄/搞/我要 和英文的 get/need，一并登记。
 * 未登记"整"("整一把木镐")：它会撞上"整个""整理"，收益不值这个误判。
 *
 * 拉丁一侧只加**前置** \b：这样 craft 仍然吃得下 crafting、get 吃得下 getting，
 * 而 forget/target/budget 里的 get 不再算命中——顺带收掉了 determine 里的 mine、
 * remake 里的 make 这类既有的误命中。中日韩没有 \b 意义上的词边界，所以分成两支。
 */
const PLAN_ITEMS_ACQUISITION_GOAL_PATTERN =
  /(?:\b(?:obtain|craft|make|build|gather|collect|acquire|mine|smelt|get|need|want|fetch|bring)|获取|获得|得到|拿到|制作|采集|收集|合成|做|造|挖|烧|弄|搞|我要|想要|需要|给我)/iu;

/**
 * Names the single trusted item a declined goal is asking to acquire, or null
 * when the goal is not an unambiguous single-item acquisition request.
 *
 * Both halves matter. The acquisition verb keeps goals that merely mention an
 * item ("equip the best armor") out of the retry, and the exactly-one rule
 * keeps a multi-item goal out, since plan_items carries exactly one goal and
 * picking one of several would be the Coordinator inventing operator intent.
 * Every candidate is drawn from the caller's trusted reachable set, so this
 * reads the goal only to choose among items the deterministic planner has
 * already proven it can reach.
 */
export function plannedAcquisitionGoalItem(
  operatorGoal: string,
  plannedItemNames: readonly string[],
): string | null {
  if (!PLAN_ITEMS_ACQUISITION_GOAL_PATTERN.test(operatorGoal)) return null;
  const matched = [...new Set(plannedItemNames)]
    .filter((itemName) => planGoalItemNameSchema.safeParse(itemName).success)
    .map((itemName) => ({
      itemName,
      spans: goalNameSpans(operatorGoal, itemName),
    }))
    .filter(({ spans }) => spans.length > 0);
  const distinct = matched.filter(
    ({ itemName, spans }) =>
      !spans.every((span) =>
        matched.some(
          (other) =>
            other.itemName !== itemName &&
            other.spans.some((cover) => strictlyCovers(cover, span)),
        ),
      ),
  );
  return distinct.length === 1 ? distinct[0]!.itemName : null;
}

type GoalSpan = Readonly<{ start: number; end: number }>;

/**
 * True when `cover` contains `span` and is strictly longer, which is what makes
 * the shorter name an artifact of the longer spelling rather than a request.
 */
function strictlyCovers(cover: GoalSpan, span: GoalSpan): boolean {
  return (
    cover.start <= span.start &&
    span.end <= cover.end &&
    cover.end - cover.start > span.end - span.start
  );
}

/**
 * Where the goal spells an item, across its own name and every registered
 * alias.
 *
 * Positions, not just a yes/no, because reachable item names nest: "钻石镐"
 * contains "钻石" and "diamond chestplate" contains "diamond". Counting those
 * as two hits made the exactly-one rule decline the entire diamond tier —
 * goals the deterministic planner derives a full chain for — as if the operator
 * had named two items. Containment is a spelling fact, and the spans are what
 * distinguish it from a genuine second request.
 */
function goalNameSpans(operatorGoal: string, itemName: string): GoalSpan[] {
  const spans: GoalSpan[] = [];
  for (const spelling of [
    itemName,
    itemName.replaceAll("_", " "),
    ...(PLANNED_ITEM_GOAL_ALIASES[itemName] ?? []),
  ]) {
    for (const match of operatorGoal.matchAll(
      goalTokenPattern(spelling, "giu"),
    )) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

/**
 * The single spelling rule shared by the retry guard and the pre-dispatch
 * grounding check, so a goal the guard treats as naming an item can never be
 * one that assertPlanGoalsGrounded then rejects as ungrounded.
 */
function goalNamesPlannedItem(operatorGoal: string, itemName: string): boolean {
  return goalNameSpans(operatorGoal, itemName).length > 0;
}

export type LocalPlannerDecision = z.infer<typeof localPlannerDecisionSchema>;

export type LocalPlanRequest = Readonly<{
  requestId: string;
  traceId: string;
  taskId: string;
  botId: string;
  operatorGoal: string;
  timeoutMs: number;
  /**
   * Present only when the caller already holds the PostgreSQL goal lease for
   * this task. Direct planner callers omit it and retain the in-memory
   * assignment guard below.
   */
  assignmentLeaseOwner?: string;
  signal?: AbortSignal;
  /** Versions captured when the slow request was created. */
  planVersion?: number;
  worldStateVersion?: number;
  /** Re-read immediately before dispatch to reject a stale model response. */
  currentVersions?: () => Readonly<{
    planVersion: number;
    worldStateVersion: number;
    taskCancelled?: boolean;
    taskCompleted?: boolean;
  }>;
}>;

export type LocalPlanResult =
  | Readonly<{
      action: "noop";
      reasonCode: string;
      /** Null when the decision was derived deterministically without a model. */
      ai: AIScheduledResult<GenerateResult> | null;
    }>
  | Readonly<{
      action: "skill_result";
      reasonCode: string;
      invocation: SkillInvocationV1;
      result: SkillExecutionResultV1;
      /** Null when the decision was derived deterministically without a model. */
      ai: AIScheduledResult<GenerateResult> | null;
    }>;

export type LocalPlannerPlanItemsDecision = Extract<
  LocalPlannerDecision,
  { action: "plan_items" }
>;

export type SkillInvocationTransport = Readonly<{
  sendSkillInvocation: (
    invocation: SkillInvocationV1,
    expectedRuntimeInstanceId: string,
    signal: AbortSignal,
  ) => Promise<SkillExecutionResultV1>;
  requestFreshStatus?: (
    botId: string,
    expectedRuntimeInstanceId: string,
    afterStatusSequence: number,
    traceId: string,
    taskId: string,
    signal: AbortSignal,
  ) => Promise<void>;
}>;

export type LocalPlannerErrorCode =
  | "PLANNER_REQUEST_INVALID"
  | "PLANNER_BOT_UNAVAILABLE"
  | "PLANNER_BOT_BUSY"
  | "PLANNER_SAFETY_PAUSED"
  | "PLANNER_SKILL_CATALOG_UNAVAILABLE"
  | "PLANNER_DECISION_INVALID"
  | "PLANNER_DECISION_MISMATCH"
  | "PLANNER_SKILL_UNAVAILABLE"
  | "PLANNER_INPUT_UNGROUNDED"
  | "PLANNER_SENSITIVE_GOAL"
  | "PLANNER_TIMEOUT"
  | "PLANNER_GOAL_UNSUPPORTED"
  | "PLANNER_GOAL_EXECUTION_FAILED"
  | "PLAN_STEP_DISPATCH_UNAVAILABLE"
  | "STEP_TARGET_NOT_FOUND"
  | "SKILL_INVOCATION_INVALID"
  | "PLANNER_STALE_RESPONSE"
  | "PLANNER_EXECUTION_OWNED"
  | "PLANNER_RESTART_RECOVERY_STALE"
  | "PLANNER_RESTART_RECOVERY_UNSAFE"
  | "PLANNER_RESTART_RECOVERY_EXHAUSTED"
  | "PLANNER_CANCELLED"
  | "PLANNER_SKILL_RESULT_INVALID";

export class LocalPlannerError extends Error {
  /** Plan step the failure came from, when the failure had one. Log-only. */
  readonly stepIndex?: number;
  /** Skill the failing step was bound to, when it had been bound. Log-only. */
  readonly stepSkillId?: string;

  constructor(
    readonly code: LocalPlannerErrorCode,
    message: string,
    options?: Readonly<{
      cause?: unknown;
      stepIndex?: number;
      stepSkillId?: string;
    }>,
  ) {
    super(message, options);
    this.name = "LocalPlannerError";
    if (options?.stepIndex !== undefined) this.stepIndex = options.stepIndex;
    if (options?.stepSkillId !== undefined) {
      this.stepSkillId = options.stepSkillId;
    }
  }
}

export type CoordinatorLocalPlannerOptions = Readonly<{
  ai: Pick<ScheduledAIRouter, "generate">;
  registry: Pick<BotRegistry, "get">;
  /**
   * Round 6.2 真实 Facility 消费方：跨 bot 共享的工作站目录（与
   * SharedStateServer 同一实例，main.ts 装配）。smelt.item 在模型直派
   * （furnace=null）时经 acquireWorkstation 解析共享熔炉租约；
   * world.scan 观测到的熔炉位置自动注册。正常 contention（busy）静默。
   */
  workstationRegistry?: WorkstationRegistryPort;
  /**
   * Round 6.4 P0c/P0d：durable plan/step journal。未注入时 build 派发
   * 仍可运行但 resume 语义退化为 skill 自身 nextIndex（诚实降级）。
   */
  planJournalStore?: PlanJournalStore;
  /**
   * 蓝图文件目录（默认 apps/coordinator/blueprints）。测试可注入临时目录；
   * 缺省在构造期加载，schema/几何不合法直接抛（协调器拒启，fail-closed）。
   */
  blueprintDirectory?: string;
  assignment?: Pick<BotAssignmentService, "acquire" | "release">;
  /**
   * Durable lease authority used when a caller supplies a pre-acquired goal
   * lease.  A lease-owner string by itself is not a capability: direct
   * planner callers must not be able to bypass the in-memory assignment
   * guard by guessing one.
   */
  verifyAssignmentLease?: (input: Readonly<{
    taskId: string;
    botId: string;
    leaseOwner: string;
  }>) => boolean | Promise<boolean>;
  transport: SkillInvocationTransport;
  coordinatorInstanceId: string;
  actorId?: string;
  /**
   * Diagnostic sink for the step ladder.  Without it a failed multi-step goal
   * is only visible as one coarse code at the control link, and the per-step
   * outcome lives solely in the Runtime's own log — which is a different
   * process, and the wrong place to start a triage.
   */
  logger?: AppLogger;
  taskStateMachine?: PersistentTaskStateMachine;
  metrics?: MetricRecorder;
  now?: () => Date;
  randomId?: () => string;
  safetyRecoveryPollIntervalMs?: number;
  maxSafetyRecoveryWaitMs?: number;
}>;

type PlannerExecutionContext = Readonly<{
  task: TaskExecutionRecord;
  worldStateVersion: number;
  claim: PlannerExecutionClaim;
}>;

type PlannerExecutionClaim = Readonly<{
  owner: string;
  leaseExpiresAt: string;
}>;

/**
 * The bindable/excluded split of every planner-known item, with the reason each
 * exclusion was made. Named rather than inferred because both log helpers take
 * it as a parameter, and an indexed access on a private method is not a type
 * the compiler will hand out.
 */
type GoalBindability = Readonly<{
  bindable: readonly string[];
  excluded: readonly Readonly<{ itemName: string; reason: string }>[];
}>;

type BoundPlanStep = Readonly<{
  invocation: SkillInvocationV1;
  runtimeInstanceId: string;
  signal: AbortSignal;
  idempotent: boolean;
}>;
type LastSkillResult = Readonly<{
  step: PlanStep;
  invocation: SkillInvocationV1;
  result: SkillExecutionResultV1;
}>;

/**
 * The observed world facts one plan step is allowed to be bound against.
 *
 * Both fields are observations, never predictions. `placementSites` holds only
 * positions the Runtime read back after confirming a block is really there, and
 * `placementReference` holds a block a `world.scan` just returned. A step whose
 * fact is absent binds to null and fails closed, which is what keeps the
 * coordinator from asserting a workstation exists where it never looked.
 */
type PlanStepBinding = Readonly<{
  placementSites: ReadonlyMap<string, PlacementPosition>;
  placementReference: PlacementPosition | null;
}>;

// collect.block 的契约上限（无规则服强度优先已拉到 64）；实测 16 在稀疏
// 林地/平原上大量目标被判不可达，恢复梯被迫反复换区。直接用契约上限。
const COORDINATOR_COLLECT_MAX_DISTANCE = 64;
const REOBSERVE_TIMEOUT_MS = 5_000;
const NON_IDEMPOTENT_RESULT_UNCERTAIN = "NON_IDEMPOTENT_RESULT_UNCERTAIN";

/** The one face a scanned ground block can be built on without further observation. */
const COORDINATOR_PLACEMENT_FACE = Object.freeze({ x: 0, y: 1, z: 0 });
/** Stations the coordinator can place after observing a trusted ground block. */
const COORDINATOR_PLACEABLE_STATIONS: ReadonlySet<string> = new Set([
  "crafting_table",
  "furnace",
]);
/** Both are needed for any placement: one to observe the site, one to build on it. */
const COORDINATOR_PLACEMENT_SKILLS = Object.freeze([
  "world.scan",
  "world.place-block",
]);
/**
 * Ground blocks worth scanning for a placement reference. Every one is solid by
 * name, so whichever the scan actually returns is an observed fact rather than
 * an assumption about what the bot happens to be standing on.
 */
const COORDINATOR_PLACEMENT_GROUND_BLOCKS = Object.freeze([
  "grass_block",
  "dirt",
  "stone",
  "cobblestone",
  "sand",
  "gravel",
  "coarse_dirt",
  "podzol",
]);
const COORDINATOR_PLACEMENT_SCAN_MAX_COUNT = 16;
const COORDINATOR_PLACEMENT_SCAN_MAX_DISTANCE = 6;
const COORDINATOR_PLACEMENT_OPEN_BLOCK = "air";
/**
 * A reference must be far enough not to be the block under the bot's own feet
 * and near enough to stay inside placement reach. Outside this window the
 * coordinator reports no site rather than dispatching a placement the Runtime
 * would refuse.
 */
const COORDINATOR_PLACEMENT_MIN_DISTANCE = 2;
// The Runtime defaults unknown servers to STRICT (3.8 block reach). The scan
// distance is measured to the reference block corner while crafting checks the
// placed station center one block higher, so 3.0 keeps the resulting station in
// reach instead of merely keeping its supporting block in reach.
const COORDINATOR_PLACEMENT_MAX_DISTANCE = 3.0;

type PlacementPosition = Readonly<{ x: number; y: number; z: number }>;

/**
 * Why a plan step cannot be bound, or null when it can.
 *
 * The single rule shared by the advertised-item report and the pre-dispatch
 * execution gate. Two copies of it drifted once already: a unit test observed
 * `SKILL_NOT_ADVERTISED:world.place-block` while production observed
 * `STEP_KIND_UNSUPPORTED:place-station` for the same goal, because each caller
 * decided in its own order which gate to check first.
 */
function unbindableStepReason(
  step: PlanStep,
  advertised: ReadonlySet<string>,
): string | null {
  if (!advertised.has(step.skillId)) {
    return `SKILL_NOT_ADVERTISED:${step.skillId}`;
  }
  if (step.kind === "mine") return null;
  if (step.kind === "craft") {
    if (step.station === null) return null;
    return COORDINATOR_PLACEABLE_STATIONS.has(step.station)
      ? placementSupportReason(advertised)
      : `STATION_UNSUPPORTED:${step.station}`;
  }
  if (step.kind === "smelt") {
    if (step.station === null) return "STATION_UNSUPPORTED:furnace";
    return COORDINATOR_PLACEABLE_STATIONS.has(step.station)
      ? placementSupportReason(advertised)
      : `STATION_UNSUPPORTED:${step.station}`;
  }
  if (step.kind === "place-station") {
    return COORDINATOR_PLACEABLE_STATIONS.has(step.itemName)
      ? placementSupportReason(advertised)
      : `STATION_UNSUPPORTED:${step.itemName}`;
  }
  return `STEP_KIND_UNSUPPORTED:${step.kind}`;
}

function placementSupportReason(advertised: ReadonlySet<string>): string | null {
  for (const skillId of COORDINATOR_PLACEMENT_SKILLS) {
    if (!advertised.has(skillId)) return `SKILL_NOT_ADVERTISED:${skillId}`;
  }
  return null;
}
/**
 * 中文与自然英文说法 → 计划物品名。**只影响"这条目标提到了哪个物品"的判定**，
 * 不放宽任何检查：候选永远来自确定性 GoalPlanner 已证明可达的集合，
 * 命中之后仍要过 assertPlanGoalsGrounded。
 *
 * 覆盖面必须跟上 ResourceGraph。此前只登记了四个物品，于是"做一个熔炉"这类
 * 目标在规划器明明推得出链条时仍然被判成"没提到任何可达物品"而降级 noop——
 * 缺的不是能力，是这张表。下面的 `plannedItemGoalAliasCoverage` 把它变成测试。
 */
const PLANNED_ITEM_GOAL_ALIASES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    oak_log: Object.freeze(["oak log", "oak_log", "橡木原木", "原木", "木头"]),
    birch_log: Object.freeze(["birch log", "birch_log", "白桦原木"]),
    spruce_log: Object.freeze(["spruce log", "spruce_log", "云杉原木"]),
    jungle_log: Object.freeze(["jungle log", "jungle_log", "丛林原木"]),
    acacia_log: Object.freeze(["acacia log", "acacia_log", "金合欢原木"]),
    dark_oak_log: Object.freeze(["dark oak log", "dark_oak_log", "深色橡木原木"]),
    mangrove_log: Object.freeze(["mangrove log", "mangrove_log", "红树林原木"]),
    cherry_log: Object.freeze(["cherry log", "cherry_log", "樱花原木"]),
    dirt: Object.freeze(["dirt", "泥土"]),
    oak_planks: Object.freeze([
      "oak planks",
      "oak_planks",
      "橡木木板",
      "木板",
    ]),
    birch_planks: Object.freeze(["birch_planks", "birch planks", "白桦木板"]),
    spruce_planks: Object.freeze(["spruce_planks", "spruce planks", "云杉木板"]),
    jungle_planks: Object.freeze(["jungle_planks", "jungle planks", "丛林木板"]),
    acacia_planks: Object.freeze(["acacia_planks", "acacia planks", "金合欢木板"]),
    dark_oak_planks: Object.freeze(["dark_oak_planks", "dark oak planks", "深色橡木木板"]),
    mangrove_planks: Object.freeze(["mangrove_planks", "mangrove planks", "红树林木板"]),
    cherry_planks: Object.freeze(["cherry_planks", "cherry planks", "樱花木板"]),
    stick: Object.freeze(["stick", "sticks", "木棍", "木棒"]),
    crafting_table: Object.freeze([
      "crafting table",
      "crafting_table",
      "工作台",
      "合成台",
    ]),
    cobblestone: Object.freeze(["cobblestone", "圆石", "鹅卵石"]),
    coal: Object.freeze(["coal", "煤炭", "煤"]),
    raw_iron: Object.freeze(["raw iron", "raw_iron", "粗铁", "铁矿石"]),
    iron_ingot: Object.freeze(["iron ingot", "iron_ingot", "铁锭"]),
    diamond: Object.freeze(["diamond", "diamonds", "钻石"]),
    furnace: Object.freeze(["furnace", "熔炉", "炉子"]),
    wooden_pickaxe: Object.freeze([
      "wooden pickaxe",
      "wooden_pickaxe",
      "木镐",
      "木制镐",
    ]),
    stone_pickaxe: Object.freeze([
      "stone pickaxe",
      "stone_pickaxe",
      "石镐",
      "石制镐",
    ]),
    iron_pickaxe: Object.freeze([
      "iron pickaxe",
      "iron_pickaxe",
      "铁镐",
      "铁制镐",
    ]),
    diamond_pickaxe: Object.freeze([
      "diamond pickaxe",
      "diamond_pickaxe",
      "钻石镐",
    ]),
    diamond_axe: Object.freeze(["diamond axe", "diamond_axe", "钻石斧"]),
    diamond_shovel: Object.freeze(["diamond shovel", "diamond_shovel", "钻石铲"]),
    diamond_hoe: Object.freeze(["diamond hoe", "diamond_hoe", "钻石锄"]),
    obsidian: Object.freeze(["obsidian", "黑曜石"]),
    diamond_sword: Object.freeze([
      "diamond sword",
      "diamond_sword",
      "钻石剑",
    ]),
    diamond_helmet: Object.freeze([
      "diamond helmet",
      "diamond_helmet",
      "钻石头盔",
    ]),
    diamond_chestplate: Object.freeze([
      "diamond chestplate",
      "diamond_chestplate",
      "钻石胸甲",
    ]),
    diamond_leggings: Object.freeze([
      "diamond leggings",
      "diamond_leggings",
      "钻石护腿",
    ]),
    diamond_boots: Object.freeze([
      "diamond boots",
      "diamond_boots",
      "钻石靴子",
      "钻石鞋",
    ]),
    charcoal: Object.freeze(["charcoal", "木炭"]),
    torch: Object.freeze(["torch", "torches", "火把"]),
    chest: Object.freeze(["chest", "chests", "箱子", "储物箱"]),
    wooden_sword: Object.freeze([
      "wooden sword",
      "wooden_sword",
      "木剑",
      "木制剑",
    ]),
    stone_sword: Object.freeze([
      "stone sword",
      "stone_sword",
      "石剑",
      "石制剑",
    ]),
    iron_sword: Object.freeze([
      "iron sword",
      "iron_sword",
      "铁剑",
      "铁制剑",
    ]),
    shield: Object.freeze(["shield", "盾牌", "盾"]),
    iron_helmet: Object.freeze([
      "iron helmet",
      "iron_helmet",
      "铁头盔",
      "铁头盔",
    ]),
    iron_chestplate: Object.freeze([
      "iron chestplate",
      "iron_chestplate",
      "铁胸甲",
    ]),
    iron_leggings: Object.freeze([
      "iron leggings",
      "iron_leggings",
      "铁护腿",
    ]),
    iron_boots: Object.freeze(["iron boots", "iron_boots", "铁靴子", "铁鞋"]),
  });

/**
 * 别名表覆盖到的物品名，供测试与 ResourceGraph 对账。导出的是键集合而不是整张
 * 表：调用方需要的是"哪些物品能被目标文本认出来"，不该拿到可改的别名列表。
 */
export const plannedItemGoalAliasCoverage: readonly string[] = Object.freeze(
  Object.keys(PLANNED_ITEM_GOAL_ALIASES).sort(),
);

export class CoordinatorLocalPlanner {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly coordinatorInstanceId: string;
  private readonly actorId: string;
  private readonly goalPlanner: GoalPlanner;
  private readonly blueprintFiles: ReadonlyMap<string, BlueprintFile>;
  private readonly planSupervisor: PlanSupervisor;
  private readonly taskStateMachine: PersistentTaskStateMachine;
  private readonly safetyRecoveryPollIntervalMs: number;
  private readonly maxSafetyRecoveryWaitMs: number;

  constructor(private readonly options: CoordinatorLocalPlannerOptions) {
    this.coordinatorInstanceId = identifierSchema.parse(
      options.coordinatorInstanceId,
    );
    this.actorId = identifierSchema.parse(options.actorId ?? "local-planner");
    this.taskStateMachine =
      options.taskStateMachine ?? new PersistentTaskStateMachine();
    this.safetyRecoveryPollIntervalMs = boundedInteger(
      options.safetyRecoveryPollIntervalMs ??
        DEFAULT_SAFETY_RECOVERY_POLL_INTERVAL_MS,
      1,
      5_000,
      "safetyRecoveryPollIntervalMs",
    );
    this.maxSafetyRecoveryWaitMs = boundedInteger(
      options.maxSafetyRecoveryWaitMs ?? DEFAULT_MAX_SAFETY_RECOVERY_WAIT_MS,
      1,
      60_000,
      "maxSafetyRecoveryWaitMs",
    );
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.goalPlanner = new GoalPlanner();
    this.planSupervisor = new PlanSupervisor(this.goalPlanner);
    this.blueprintFiles = loadBlueprintFiles(options.blueprintDirectory);
  }

  async planAndDispatch(request: LocalPlanRequest): Promise<LocalPlanResult> {
    this.validateRequest(request);
    const startedAt = this.validNow();
    const deadlineMs = startedAt.getTime() + request.timeoutMs;
    this.assertWithinDeadline(deadlineMs, request.signal);
    const initialRecord = this.requireAvailableBot(request.botId);
    // S-12：回放语料采集——env 门控 STUDIO_REPLAY_CAPTURE=1，独立 JSONL，默认关；
    // 协调器日志零 goal 原文（隐私契约不变）；采集失败绝不影响规划。
    const s12Capture = openReplayCapture();
    try {
      const result = await this.planAndDispatchInner(request, startedAt, deadlineMs, initialRecord);
      s12Capture?.({
        at: new Date().toISOString(), traceId: request.traceId, taskId: request.taskId,
        botId: request.botId, operatorGoal: request.operatorGoal.slice(0, 500),
        skillCatalogSequence: initialRecord.skillCatalog?.sequence ?? null,
        statusObservedAt: initialRecord.currentStatus?.observedAt ?? null,
        outcome: result.action, reasonCode: result.reasonCode ?? null,
        durationMs: this.validNow().getTime() - startedAt.getTime(),
      });
      return result;
    } catch (cause) {
      s12Capture?.({
        at: new Date().toISOString(), traceId: request.traceId, taskId: request.taskId,
        botId: request.botId, operatorGoal: request.operatorGoal.slice(0, 500),
        skillCatalogSequence: initialRecord.skillCatalog?.sequence ?? null,
        statusObservedAt: initialRecord.currentStatus?.observedAt ?? null,
        outcome: "error",
        errorCode: cause instanceof LocalPlannerError ? cause.code : "PLANNER_FAILED",
        durationMs: this.validNow().getTime() - startedAt.getTime(),
      });
      throw cause;
    }
  }

  private async planAndDispatchInner(
    request: LocalPlanRequest,
    startedAt: Date,
    deadlineMs: number,
    initialRecord: ReturnType<CoordinatorLocalPlanner["requireAvailableBot"]>,
  ): Promise<LocalPlanResult> {
    let claim: PlannerExecutionClaim | null = null;
    try {
      const execution = await this.beginTaskExecution(
        request,
        initialRecord,
        deadlineMs,
        (acquired) => {
          claim = acquired;
        },
      );
      return await this.planAndDispatchOnce(request, execution, deadlineMs);
    } catch (cause) {
      await this.failTaskExecution(request, cause, claim);
      if (
        cause instanceof LocalPlannerError &&
        cause.code === "PLANNER_STALE_RESPONSE"
      ) {
        this.options.metrics?.increment("bot_stale_responses_total", {
          bot_id: request.botId,
        });
      }
      if (request.signal?.aborted) {
        this.options.metrics?.increment("bot_cancelled_requests_total", {
          bot_id: request.botId,
        });
      }
      throw cause;
    }
  }

  async getTaskExecution(taskId: string): Promise<TaskExecutionRecord | null> {
    return this.taskStateMachine.get(taskId);
  }

  private async planAndDispatchOnce(
    request: LocalPlanRequest,
    execution: PlannerExecutionContext,
    deadlineMs: number,
  ): Promise<LocalPlanResult> {
    this.assertWithinDeadline(deadlineMs, request.signal);
    const record = this.requireAvailableBot(request.botId);
    return this.withAssignment(request, record, deadlineMs, async () => {
    const availableSkills = record.skillCatalog!.skills.filter(
      ({ availability }) => availability === "available",
    );
    if (availableSkills.length === 0) {
      throw new LocalPlannerError(
        "PLANNER_SKILL_CATALOG_UNAVAILABLE",
        "Bot Runtime has no available advertised skills.",
      );
    }
    const operatorGoal = safeOperatorGoal(request.operatorGoal, record);
    const bindability = this.coordinatorGoalBindability(availableSkills);
    this.logGoalBindability(request, bindability);
    const plannedItemNames = bindability.bindable;

    // §确定性快速路径：目标本身是协调器模板或唯一物品采集时，决策可以
    // 被推导出来，不需要一次模型往返。解析器只认固定模板与"动词+唯一
    // 可达物品"，任何含糊形态返回 null 照旧走模型分支；派发路径与模型
    // 分支完全同一条（grounding、安全等待、任务迁移一个不少）。
    const deterministic = this.deterministicDecisionFor(
      operatorGoal,
      plannedItemNames,
      request,
      record,
      availableSkills,
    );
    if (deterministic !== null) {
      if (deterministic.planItems !== null) {
        this.options.metrics?.increment(
          "planner_deterministic_decisions_total",
          { bot_id: request.botId, kind: "plan_items" },
        );
        return this.planItemsAndDispatch(
          request,
          deterministic.planItems,
          record,
          availableSkills,
          null,
          deadlineMs,
        );
      }
      this.options.metrics?.increment(
        "planner_deterministic_decisions_total",
        { bot_id: request.botId, kind: "invoke_skill" },
      );
      if (deterministic.skill === null) {
        throw new LocalPlannerError(
          "PLANNER_DECISION_INVALID",
          "Deterministic skill decision was expected but missing.",
        );
      }
      return this.dispatchDirectSkillDecision({
        request,
        decision: deterministic.skill,
        operatorGoal,
        record,
        availableSkills,
        execution,
        deadlineMs,
        ai: null,
        skipModelGrounding: true,
      });
    }

    const generationSchema = buildLocalPlannerGenerationSchema(
      availableSkills,
      plannedItemNames,
      { botId: request.botId, taskId: request.taskId },
    );

    let prompt: string;
    try {
      prompt = buildLocalPlannerPrompt({
        promptVersion: LOCAL_PLANNER_PROMPT_VERSION,
        operatorGoal,
        bot: safeBotContext(record, request.taskId),
        plannedItems: plannedItemNames,
        availableSkills: availableSkills.map(
          ({
            skillId,
            skillVersion,
            verification,
            inputSchema,
            timeoutMs,
            idempotent,
          }) => ({
            skillId,
            skillVersion,
            verification,
            inputSchema: plannerInputSchema(inputSchema),
            timeoutMs,
            idempotent,
          }),
        ),
      });
    } catch {
      throw new LocalPlannerError(
        "PLANNER_SKILL_CATALOG_UNAVAILABLE",
        "Advertised Skill catalog cannot be represented within the planner prompt boundary.",
      );
    }
    const ai = await this.options.ai.generate({
      requestId: request.requestId,
      botId: request.botId,
      priority: aiRequestPriorities.planning,
      supersedeKey: `plan:${request.taskId}`,
      prompt,
      systemPrompt: LOCAL_PLANNER_SYSTEM_PROMPT,
      schema: generationSchema,
      maxTokens: 512,
      temperature: 0,
      timeoutMs: request.timeoutMs,
      traceId: request.traceId,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    this.recordAIUsage(request, ai);
    this.assertWithinDeadline(deadlineMs, request.signal);
    this.assertFreshResponse(request, ai, execution);
    await this.assertTaskExecutionFresh(request, execution);
    const decision = parseDecision(ai.value.content);
    if (decision.botId !== request.botId || decision.taskId !== request.taskId) {
      throw new LocalPlannerError(
        "PLANNER_DECISION_MISMATCH",
        "Local planner decision changed the trusted task or Bot identity.",
      );
    }
    if (decision.action === "noop") {
      this.logUnbindableGoalNames(request, operatorGoal, bindability);
      await this.abortTaskExecution(
        request.taskId,
        `PLANNER_NOOP:${decision.reasonCode}`,
        execution.claim,
        { expectedRevision: execution.task.revision },
      );
      return { action: "noop", reasonCode: decision.reasonCode, ai };
    }
    if (decision.action === "plan_items") {
      return this.planItemsAndDispatch(
        request,
        decision,
        record,
        availableSkills,
        ai,
        deadlineMs,
      );
    }
    return this.dispatchDirectSkillDecision({
      request,
      decision,
      operatorGoal,
      record,
      availableSkills,
      plannedItemNames,
      execution,
      deadlineMs,
      ai,
    });
    });
  }

  /**
   * Direct single-skill dispatch shared by the model's invoke_skill branch and
   * the deterministic fast path. Everything that makes a dispatch safe —
   * catalog matching, advertised-input validation, grounding, safety wait,
   * task execution transitions, recovery — lives here once, so the two entry
   * points can never drift apart.
   */
  /**
   * Round 6.4 J3：build.blueprint 派发的 durable journal 打开/复用。
   * 同一 build（按 anchor 识别）跨 goal 复用同一 planId——restart 后
   * 已完成 batch 的 SUCCEEDED 步骤是 resume 边界，对应 cell 零重放。
   */
  private openBuildJournal(
    request: LocalPlanRequest,
    skillId: string,
    trustedInput: SkillJsonValue,
    record: BotRegistryRecord,
  ): PlanExecutionJournal | null {
    const store = this.options.planJournalStore;
    if (store === undefined || skillId !== "build.blueprint") return null;
    const input = trustedInput as {
      blueprint?: { anchor?: { x: number; y: number; z: number }; dimension?: string; cells?: unknown[] };
      startIndex?: number;
      maxPlacements?: number;
    } | null;
    const anchor = input?.blueprint?.anchor;
    if (!anchor || !input.blueprint?.dimension) return null;
    const buildKey = `${record.serverProfileId}|${input.blueprint.dimension}|${Math.floor(anchor.x)},${Math.floor(anchor.y)},${Math.floor(anchor.z)}`;
    const existing = store.load().find(
      (j) => j.status === "ACTIVE" && j.correlationId === buildKey,
    );
    if (existing !== undefined) return existing;
    const cells = Array.isArray(input.blueprint.cells) ? (input.blueprint.cells as Array<{ itemName?: unknown }>) : [];
    return newPlanJournal({
      goalId: request.taskId,
      botId: request.botId,
      serverProfileId: record.serverProfileId,
      correlationId: buildKey,
      plannerVersion: "local-planner",
      steps: [
        {
          skillId: "build.blueprint",
          actionFamily: "build",
          sideEffectClass: "NON_IDEMPOTENT",
          expectedPostcondition: {
            kind: "build-cell",
            buildId: buildKey,
            cellIndex: (input.startIndex ?? 0) + Math.max(1, input.maxPlacements ?? cells.length) - 1,
            position: { x: Math.floor(anchor.x), y: Math.floor(anchor.y), z: Math.floor(anchor.z) },
            blockName: String(cells[0]?.itemName ?? "unknown"),
          },
        },
      ],
    });
  }

  /**
   * Phase 2 —— 非幂等步骤 transport 失败的 server-truth reconcile。
   *
   * 判据（与 §五.3 对齐）：
   * 1. dispatch 前记录 bot 盘内该步骤目标物品计数（registry 可信快照）；
   * 2. 失败后 requestFreshStatus 拉取运行时新鲜状态；
   * 3. 新鲜计数 > 快照 → 副作用已发生且后置条件（拿到物品）成立 →
   *    步骤记成功（receipt 丢失但世界真值在），计划继续；
   * 4. 计数不变 → 明确未发生 → 返回原 transport 码，交给 supervisor 的
   *    有界重试阶梯（不吞错误、不盲目重试副作用）；
   * 5. 新鲜状态不可得（runtime 不可达）→ 真不可判定 → NON_IDEMPOTENT
   *    _RESULT_UNCERTAIN（PAUSED 语义由 supervisor 的升级路径承接）。
   */
  private async reconcileNonIdempotentTransportFailure(
    request: LocalPlanRequest,
    step: PlanStep,
    initialRecord: BotRegistryRecord,
    deadlineMs: number,
    transportCode: string,
  ): Promise<StepOutcome> {
    const target = "itemName" in step ? step.itemName : null;
    const beforeInventory = initialRecord.currentStatus?.inventory ?? [];
    const beforeCount = target === null
      ? null
      : (beforeInventory.find((item) => item.itemName === target)?.count ?? 0);
    const freshStatus = this.options.transport.requestFreshStatus;
    if (freshStatus === undefined || target === null || beforeCount === null) {
      return { ok: false, errorCode: NON_IDEMPOTENT_RESULT_UNCERTAIN };
    }
    let afterRecord: BotRegistryRecord | null = null;
    try {
      this.assertWithinDeadline(deadlineMs, request.signal);
      const before = this.requireAvailableBot(request.botId);
      await freshStatus(
        request.botId,
        before.runtimeInstanceId,
        before.currentStatus!.sequence,
        request.traceId,
        request.taskId,
        boundedAbortSignal(request.signal, Math.min(REOBSERVE_TIMEOUT_MS, Math.max(1, deadlineMs - this.validNow().getTime()))),
      );
      afterRecord = this.options.registry.get(request.botId, this.validNow());
    } catch {
      afterRecord = null;
    }
    if (afterRecord === null || afterRecord.currentStatus === null) {
      return { ok: false, errorCode: NON_IDEMPOTENT_RESULT_UNCERTAIN };
    }
    const afterCount = afterRecord.currentStatus.inventory?.find(
      (item) => item.itemName === target,
    )?.count ?? 0;
    if (afterCount > beforeCount) {
      this.options.logger?.info?.("coordinator_step_reconciled_occurred", {
        taskId: request.taskId,
        botId: request.botId,
        stepKind: step.kind,
        itemName: target,
        beforeCount,
        afterCount,
        transportCode,
        note: "transport failure but server truth shows the side effect occurred; step recorded as succeeded",
      });
      return { ok: true };
    }
    this.options.logger?.info?.("coordinator_step_reconciled_not_occurred", {
      taskId: request.taskId,
      botId: request.botId,
      stepKind: step.kind,
      itemName: target,
      beforeCount,
      afterCount,
      transportCode,
      note: "server truth shows the side effect did not occur; supervisor retry ladder may retry safely",
    });
    return { ok: false, errorCode: transportCode };
  }

  private async dispatchDirectSkillDecision({
    request,
    decision,
    operatorGoal,
    record,
    availableSkills,
    plannedItemNames = [],
    execution,
    deadlineMs,
    ai,
    skipModelGrounding = false,
  }: {
    request: LocalPlanRequest;
    decision:
      | Extract<LocalPlannerDecision, { action: "invoke_skill" }>
      | DeterministicSkillDecision;
    operatorGoal: string;
    record: BotRegistryRecord;
    availableSkills: readonly BotSkillCatalogEntryV1[];
    plannedItemNames?: readonly string[];
    execution: PlannerExecutionContext;
    deadlineMs: number;
    ai: AIScheduledResult<GenerateResult> | null;
    /** 确定性模板派发为 true：输入由协调器受控语法构造，跳过模型输出的坐标接地校验。 */
    skipModelGrounding?: boolean;
  }): Promise<LocalPlanResult> {
    const advertisedSkill = availableSkills.find(
      ({ skillId, skillVersion, availability }) =>
        skillId === decision.skillId && skillVersion === decision.skillVersion,
    );
    if (!advertisedSkill) {
      throw new LocalPlannerError(
        "PLANNER_SKILL_UNAVAILABLE",
        "Local planner selected a skill outside the Runtime catalog.",
      );
    }

    const modelInput = validateAdvertisedInput(
      plannerInputSchema(advertisedSkill.inputSchema),
      decision.input,
    );
    if (!skipModelGrounding) {
      assertGroundedSensitiveInput(modelInput, operatorGoal, record);
    }

    const currentRecord = await this.waitForSafetyClear({
      request,
      expectedTask: execution.task,
      initialRecord: record,
      initialSkill: advertisedSkill,
      deadlineMs,
      claim: execution.claim,
    });
    const currentSkill = currentRecord.skillCatalog!.skills.find(
      ({ skillId, skillVersion, availability }) =>
        skillId === decision.skillId && skillVersion === decision.skillVersion,
    )!;
    let trustedInput = injectTrustedServerProfile(
      modelInput,
      currentRecord.serverProfileId,
    );
    validateAdvertisedInput(currentSkill.inputSchema, trustedInput);

    // Round 6.2 Facility 消费方：模型直派 smelt.item 且未指定熔炉时，
    // 从共享工作站目录解析租约（busy/not_found 静默回退 null=Runtime 自放）。
    const facilityLease = await this.resolveFacilityLeaseForDispatch(
      request,
      decision.skillId,
      trustedInput,
      currentRecord,
    );
    if (facilityLease !== null) {
      trustedInput = {
        ...(trustedInput as Record<string, SkillJsonValue>),
        furnace: {
          x: facilityLease.position.x,
          y: facilityLease.position.y,
          z: facilityLease.position.z,
        },
      } as typeof trustedInput;
      validateAdvertisedInput(currentSkill.inputSchema, trustedInput);
    }

    this.assertWithinDeadline(deadlineMs, request.signal);
    const activeExecution = await this.transitionTaskExecution(
      request.taskId,
      "EXECUTE",
      {
        expectedRevision: execution.task.revision,
        currentStep: decision.skillId,
        expectedResult: {
          outcome: "completed",
          skillId: decision.skillId,
          skillVersion: decision.skillVersion,
        },
        worldStateVersion: execution.worldStateVersion,
      },
    );
    // Round 6.4 J3：build.blueprint 派发进 durable journal（cell 级零重放判据）
    const buildJournal = this.openBuildJournal(request, decision.skillId, trustedInput, currentRecord);
    if (buildJournal !== null) {
      this.options.planJournalStore?.save(recordDispatch(buildJournal, buildJournal.steps[0]!.stepId));
    }
    let dispatchOutcome: Awaited<ReturnType<
      CoordinatorLocalPlanner["dispatchSkillWithRecovery"]
    >> | undefined;
    try {
      dispatchOutcome = await this.dispatchSkillWithRecovery({
        request,
        decision,
        trustedInput,
        initialRecord: currentRecord,
        initialSkill: currentSkill,
        deadlineMs,
        execution: activeExecution,
        claim: execution.claim,
      });
    } finally {
      if (buildJournal !== null) {
        const completed = dispatchOutcome !== undefined && dispatchOutcome.result.payload.outcome === "completed";
        this.options.planJournalStore?.save(
          applyStepResult(buildJournal, buildJournal.steps[0]!.stepId, {
            status: completed ? "SUCCEEDED" : "FAILED",
            failureCode: completed ? null : "BUILD_DISPATCH_FAILED",
            verification: completed
              ? { outcome: "confirmed", evidence: "skill result completed with placements output" }
              : { outcome: "unverifiable", evidence: "dispatch did not complete" },
          }),
        );
      }
      // 租约与派发结果同生命周期：失败也要归还（corruption 除外——那是注册表问题）
      if (facilityLease !== null) {
        try {
          this.options.workstationRegistry?.release(
            facilityLease.serverProfileId,
            facilityLease.dimension,
            facilityLease.position,
            request.botId,
          );
        } catch {
          // 归还失败只记录：下一次 TTL 过期自愈
          this.options.logger?.warn?.("coordinator_facility_release_failed", {});
        }
      }
    }
    if (dispatchOutcome === undefined) {
      // dispatch 抛出且 finally 已记 journal——这里如实上抛，不编造结果
      throw new LocalPlannerError(
        "PLANNER_GOAL_EXECUTION_FAILED",
        "build dispatch threw before producing a result",
      );
    }
    const {
      invocation,
      result: skillResult,
      execution: completedExecution,
    } = dispatchOutcome;
    // world.scan 完成结果 → 熔炉位置注册进共享目录（后续 smelt 复用）
    this.registerFacilitiesFromScan(
      request,
      currentRecord,
      decision.skillId,
      trustedInput,
      skillResult,
    );
    if (skillResult.payload.outcome === "completed") {
      if (dispatchChangedNothing(skillResult)) {
        // 空 dispatch（技能成功但什么都没产出）不再触发采集重问阶梯：可解析
        // 的采集目标在进入模型前已被确定性路径接管，能走到这里的空 dispatch
        // 都是非采集形态。如实记录，让调用方基于"目标仍缺"自行重估。
        this.logEmptyDispatchReplanned(request, decision.skillId);
      }
      await this.finishSuccessfulTaskExecution(
        request,
        skillResult,
        completedExecution,
      );
      if (ai !== null) {
        this.options.metrics?.increment("bot_llm_useful_responses_total", {
          bot_id: request.botId,
        });
      }
    }
    return {
      action: "skill_result",
      reasonCode: decision.reasonCode,
      invocation,
      result: skillResult,
      ai,
    };
  }

  /**
   * Derives a decision for the coordinator's own goal templates without a
   * model round-trip. Returns null for every goal shape that is not one of
   * the fixed templates or a single unambiguous acquisition — those must keep
   * going through the model branch.
   *
   * The synthesized decisions carry the same trusted-identity fields a model
   * decision would, because downstream code asserts them; the identity here
   * comes from the request object itself, not from anything parsed.
   */
  private deterministicDecisionFor(
    operatorGoal: string,
    plannedItemNames: readonly string[],
    request: LocalPlanRequest,
    record: BotRegistryRecord,
    availableSkills: readonly BotSkillCatalogEntryV1[],
  ): Readonly<{
    planItems: DeterministicPlanItemsDecision | null;
    skill: DeterministicSkillDecision | null;
  }> | null {
    const parsed: DeterministicGoal | null =
      parseDeterministicGoal(operatorGoal, plannedItemNames) ??
      parseBlueprintFileGoal(operatorGoal, new Set(this.blueprintFiles.keys()));
    if (parsed === null) {
      // 蓝图 goal 诊断（闭环轮）：goal 含"蓝图"但两个解析器都 null 时
      // 输出 goal 前缀与已知蓝图名——直接定位模板匹配断裂点。
      if (/蓝图/.test(operatorGoal)) {
        this.options.logger?.info?.(
          "coordinator_blueprint_goal_unparsed",
          {
            taskId: request.taskId,
            botId: request.botId,
            goalPreview: operatorGoal.slice(0, 120),
            knownBlueprints: [...this.blueprintFiles.keys()].join(","),
          },
        );
      }
      return null;
    }
    if (parsed.kind === "acquire-item") {
      return {
        planItems: {
          action: "plan_items",
          botId: request.botId,
          taskId: request.taskId,
          goals: [{ itemName: parsed.itemName, count: parsed.count }],
          reasonCode: "DETERMINISTIC_ACQUISITION",
        },
        skill: null,
      };
    }
    const dimension =
      record.currentStatus?.position.dimension ?? "minecraft:overworld";
    const decision = deterministicSkillDecision(
      parsed,
      request,
      dimension,
      availableSkills,
      this.blueprintFiles,
    );
    if (decision === null) return null;
    return { planItems: null, skill: decision };
  }

  private async withAssignment<T>(
    request: LocalPlanRequest,
    record: BotRegistryRecord,
    deadlineMs: number,
    action: () => Promise<T>,
  ): Promise<T> {
    if (request.assignmentLeaseOwner !== undefined) {
      const verifier = this.options.verifyAssignmentLease;
      if (!verifier) {
        throw new LocalPlannerError(
          "PLANNER_BOT_UNAVAILABLE",
          "A pre-acquired assignment lease has no trusted verifier.",
        );
      }
      let verified = false;
      try {
        verified =
          (await verifier({
            taskId: request.taskId,
            botId: request.botId,
            leaseOwner: request.assignmentLeaseOwner,
          })) === true;
      } catch {
        // A persistence/authority failure must not degrade into an
        // unguarded execution path.
        verified = false;
      }
      if (!verified) {
        throw new LocalPlannerError(
          "PLANNER_BOT_UNAVAILABLE",
          "The pre-acquired assignment lease is not currently authoritative.",
        );
      }
      this.assertWithinDeadline(deadlineMs, request.signal);
      return action();
    }
    const assignment = this.options.assignment;
    if (!assignment) {
      this.assertWithinDeadline(deadlineMs, request.signal);
      return action();
    }
    let leaseId: string | null = null;
    try {
      const lease = assignment.acquire({
        taskId: request.taskId,
        serverProfileId: record.serverProfileId,
        dimension: record.currentStatus!.position.dimension,
        requiredSkills: [],
        preferredBotId: request.botId,
        leaseTtlMs: request.timeoutMs,
      }, this.validNow());
      leaseId = lease.leaseId;
    } catch (cause) {
      if (cause instanceof BotAssignmentError) {
        if (cause.code === "ASSIGNMENT_PREFERRED_BOT_BUSY") {
          throw new LocalPlannerError(
            "PLANNER_BOT_BUSY",
            "Target Bot already owns another active assignment.",
          );
        }
        throw new LocalPlannerError(
          "PLANNER_BOT_UNAVAILABLE",
          "Target Bot could not obtain a safe assignment lease.",
        );
      }
      throw cause;
    }
    try {
      this.assertWithinDeadline(deadlineMs, request.signal);
      return await action();
    } finally {
      if (leaseId) assignment.release(leaseId);
    }
  }

  /**
   * Splits every planner-known item into the set the coordinator can actually
   * bind and the set it cannot, carrying the reason for each exclusion.
   *
   * The exclusions are the interesting half. A goal naming an excluded item
   * comes back as a bare `action: "noop"`, which reads identically to the model
   * honestly declining a reachable goal — so an operator asking for a stone
   * pickaxe could not tell "this Runtime cannot place a crafting table" from
   * "the model chose not to". Deriving the reason here lets the caller log it
   * instead of leaving the difference invisible.
   */
  private coordinatorGoalBindability(
    availableSkills: readonly BotSkillCatalogEntryV1[],
  ): GoalBindability {
    const available = new Set(
      availableSkills.map(({ skillId }) => skillId),
    );
    const bindable: string[] = [];
    const excluded: { itemName: string; reason: string }[] = [];
    for (const itemName of this.goalPlanner.resourceGraph.knownItemNames()) {
      const plan = this.goalPlanner.plan([{ itemName, count: 1 }], {});
      if (!plan.planned || plan.steps.length === 0) continue;
      let reason: string | null = null;
      for (const step of plan.steps) {
        reason = unbindableStepReason(step, available);
        if (reason !== null) break;
      }
      if (reason === null) {
        bindable.push(itemName);
        continue;
      }
      excluded.push({ itemName, reason });
    }
    return Object.freeze({
      bindable: Object.freeze(bindable),
      excluded: Object.freeze(excluded),
    });
  }

  /**
   * Reports the bindable/excluded split once per planning attempt, with the
   * exclusion reasons aggregated so the record stays a fixed size no matter how
   * large the resource graph grows.
   */
  private logGoalBindability(
    request: LocalPlanRequest,
    bindability: GoalBindability,
  ): void {
    const logger = this.options.logger;
    if (!logger) return;
    try {
      const reasonCounts: Record<string, number> = {};
      for (const { reason } of bindability.excluded) {
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      }
      logger.info("coordinator_planner_goal_bindability", {
        traceId: request.traceId,
        taskId: request.taskId,
        botId: request.botId,
        // 闭环轮诊断：goal 到达 planner 时的前 60 字符（隐私审计过——蓝图
        // goal 无敏感字段；一次性定位 safeOperatorGoal/transport 层是否改写）
        goalPreview: request.operatorGoal.slice(0, 60),
        bindableCount: bindability.bindable.length,
        excludedCount: bindability.excluded.length,
        exclusionReasons: reasonCounts,
      });
    } catch {
      // Diagnostics must never change what the planner reports.
    }
  }

  private async planItemsAndDispatch(
    request: LocalPlanRequest,
    decision: LocalPlannerPlanItemsDecision | DeterministicPlanItemsDecision,
    initialRecord: BotRegistryRecord,
    availableSkills: readonly BotSkillCatalogEntryV1[],
    ai: AIScheduledResult<GenerateResult> | null,
    deadlineMs: number,
  ): Promise<LocalPlanResult> {
    const goals: GoalRequest[] = decision.goals.map(({ itemName, count }) => ({
      itemName,
      count,
    }));
    assertPlanGoalsGrounded(goals, request.operatorGoal);
    if (
      goals.some(
        ({ itemName }) =>
          !this.goalPlanner.resourceGraph.knows(itemName),
      )
    ) {
      throw new LocalPlannerError(
        "PLANNER_GOAL_UNSUPPORTED",
        "The requested resource is outside the trusted planning graph.",
      );
    }
    const inventory = plannerInventoryFromRecord(initialRecord);
    const plan = this.goalPlanner.plan(goals, inventory);
    if (!plan.planned) {
      throw new LocalPlannerError(
        "PLANNER_GOAL_UNSUPPORTED",
        `The trusted planner could not derive ${plan.blockedOn}.`,
      );
    }
    if (plan.steps.length === 0) {
      return { action: "noop", reasonCode: "ADVANCE_TASK", ai };
    }
    const availableSkillIds = new Set(
      availableSkills.map(({ skillId }) => skillId),
    );
    if (
      plan.steps.some(
        (step) => unbindableStepReason(step, availableSkillIds) !== null,
      )
    ) {
      throw new LocalPlannerError(
        "PLANNER_GOAL_UNSUPPORTED",
        "The Runtime catalog cannot safely bind every derived plan step.",
      );
    }

    let last: LastSkillResult | null = null;
    // Where each station was actually observed to land, keyed by station item.
    // Filled only from a Runtime-confirmed placement result, so a later craft
    // step can never be handed a position the coordinator merely predicted.
    const placementSites = new Map<string, PlacementPosition>();
    const supervision = await this.planSupervisor.run(
      plan.steps,
      async (step, _attempt): Promise<StepOutcome> => {
        this.assertWithinDeadline(deadlineMs, request.signal);
        let placementReference: PlacementPosition | null = null;
        if (step.kind === "place-station") {
          try {
            placementReference = await this.observePlacementReference(
              request,
              initialRecord,
              availableSkills,
              deadlineMs,
            );
          } catch (cause) {
            if (
              cause instanceof LocalPlannerError &&
              (cause.code === "PLAN_STEP_DISPATCH_UNAVAILABLE" ||
                cause.code === "SKILL_INVOCATION_INVALID")
            ) {
              return { ok: false, errorCode: cause.code };
            }
            throw cause;
          }
          if (placementReference === null) {
            return { ok: false, errorCode: "STEP_TARGET_NOT_FOUND" };
          }
        }
        let bound: BoundPlanStep | null;
        try {
          bound = this.bindPlanStep(
            request,
            initialRecord,
            availableSkills,
            step,
            deadlineMs,
            request.signal,
            { placementSites, placementReference },
          );
        } catch (cause) {
          if (
            cause instanceof LocalPlannerError &&
            (cause.code === "PLAN_STEP_DISPATCH_UNAVAILABLE" ||
              cause.code === "SKILL_INVOCATION_INVALID")
          ) {
            return { ok: false, errorCode: cause.code };
          }
          throw cause;
        }
        if (!bound) return { ok: false, errorCode: "STEP_TARGET_NOT_FOUND" };
        try {
          const result = await this.options.transport.sendSkillInvocation(
            bound.invocation,
            bound.runtimeInstanceId,
            bound.signal,
          );
          last = { step, invocation: bound.invocation, result };
          // 已有快速通道对齐：从 registry 活快照取当前持有量传给满足判定
          const heldRecord = this.options.registry.get(request.botId, this.validNow());
          const inventoryHeld = "itemName" in step
            ? (heldRecord?.currentStatus?.inventory ?? []).find(
                (item) => item.itemName === step.itemName,
              )?.count ?? 0
            : 0;
          this.options.logger?.info?.("coordinator_step_inventory_check", {
            taskId: request.taskId,
            botId: request.botId,
            stepKind: step.kind,
            itemName: step.itemName,
            inventoryHeld,
            producedCount: "producedCount" in step ? step.producedCount : null,
            statusInventoryCount: (heldRecord?.currentStatus?.inventory ?? []).length,
          });
          const outcome = stepOutcomeFromResult(step, result, inventoryHeld);
          if (outcome.ok && step.kind === "place-station") {
            // Recorded from the Runtime's read-back position, which it produces
            // only after confirming a block is really there.
            const placed = placedStationPosition(result);
            if (placed === null) {
              return { ok: false, errorCode: "STEP_OUTPUT_INSUFFICIENT" };
            }
            placementSites.set(step.itemName, placed);
          }
          if (bound.idempotent) return outcome;
          const guarded = nonIdempotentStepOutcome(result, outcome);
          this.logMaskedStepFailure(request, step, outcome, guarded);
          return guarded;
        } catch (cause) {
          if (!bound.idempotent) {
            // Phase 2 reconcile：副作用是否真的发生，由 server-truth 判定，
            // 不由"异常类型"猜测。见 reconcileNonIdempotentTransportFailure。
            const reconciled = await this.reconcileNonIdempotentTransportFailure(
              request,
              step,
              initialRecord,
              deadlineMs,
              transportFailureCode(cause),
            );
            this.logMaskedStepFailure(request, step, {
              ok: reconciled.ok,
              errorCode: reconciled.ok ? "SKILL_HANDLER_COMPLETED" : reconciled.errorCode,
            }, reconciled.ok
              ? { ok: true }
              : { ok: false, errorCode: reconciled.errorCode });
            return reconciled;
          }
          if (request.signal?.aborted) {
            return { ok: false, errorCode: "SKILL_CANCELLED" };
          }
          if (bound.signal.aborted) {
            return {
              ok: false,
              errorCode: "SKILL_TIMEOUT",
            };
          }
          // Transport failures are transient at the skill boundary. The
          // supervisor owns the bounded retry ladder for idempotent steps.
          return { ok: false, errorCode: transportFailureCode(cause) };
        }
      },
      {},
      {
        reobserve: async () => {
          const requestFreshStatus = this.options.transport.requestFreshStatus;
          if (!requestFreshStatus) {
            throw new LocalPlannerError(
              "PLAN_STEP_DISPATCH_UNAVAILABLE",
              "Runtime transport cannot request a fresh Bot status.",
            );
          }
          const before = this.requireAvailableBot(request.botId);
          const beforeSequence = before.currentStatus!.sequence;
          const remainingMs = deadlineMs - this.validNow().getTime();
          this.assertWithinDeadline(deadlineMs, request.signal);
          await this.options.transport.requestFreshStatus!(
            request.botId,
            before.runtimeInstanceId,
            beforeSequence,
            request.traceId,
            request.taskId,
            boundedAbortSignal(
              request.signal,
              Math.min(REOBSERVE_TIMEOUT_MS, remainingMs),
            ),
          );
          const after = this.requireAvailableBot(request.botId);
          if (
            after.runtimeInstanceId !== before.runtimeInstanceId ||
            after.serverProfileId !== before.serverProfileId ||
            after.currentStatus!.sequence <= beforeSequence
          ) {
            throw new LocalPlannerError(
              "PLANNER_BOT_UNAVAILABLE",
              "Runtime did not publish a fresh status for the same Bot context.",
            );
          }
        },
        // Phase 3.6：moveCloser 复用 movement.goto 确定性派发（不复制移动实现）。
        // 目标取步骤绑定里的世界目标位置；预算有界，失败交回重试阶梯。
        moveCloser: async (step) => {
          const target = stepTargetPosition(step, { placementSites });
          if (target === null) return;
          const record = this.requireAvailableBot(request.botId);
          await this.dispatchObservation(
            request,
            record,
            record.skillCatalog!.skills,
            "movement.goto",
            {
              target: {
                x: target.x,
                y: target.y,
                z: target.z,
                dimension: record.currentStatus!.position!.dimension,
                serverProfileId: record.serverProfileId,
              },
              radius: 3,
            },
            deadlineMs,
          );
          this.options.logger?.info?.("coordinator_recovery_move_closer", {
            taskId: request.taskId,
            botId: request.botId,
            stepIndex: step.stepIndex,
            target: { x: target.x, y: target.y, z: target.z },
          });
        },
        // Phase 3.6：freeInventory 的实际转移由 runtime 的稳定 inventory/container
        // 原语承担（store.sort/capability 层）；这里只记录恢复意图，不复制实现。
        freeInventory: async (step) => {
          void step;
          this.options.logger?.info?.("coordinator_recovery_free_inventory", {
            taskId: request.taskId,
            botId: request.botId,
            note: "inventory space recovery handled by runtime container primitives",
          });
        },
      },
    );
    this.logSupervision(request, plan.steps, supervision);
    this.assertWithinDeadline(deadlineMs, request.signal);
    const failure = supervision.failure;
    const observedLast = last as LastSkillResult | null;
    if (failure !== null) {
      const failedResult =
        observedLast !== null &&
        observedLast.step.stepIndex === failure.stepIndex &&
        observedLast.step.itemName === failure.itemName &&
        observedLast.result.payload.outcome !== "completed"
          ? observedLast
          : null;
      const stepContext = {
        stepIndex: failure.stepIndex,
        ...(failedResult
          ? { stepSkillId: failedResult.invocation.payload.skillId }
          : {}),
      };
      if (failure.errorCode === "STEP_TARGET_NOT_FOUND") {
        throw new LocalPlannerError(
          "STEP_TARGET_NOT_FOUND",
          "A trusted world target was not available for the next plan step.",
          stepContext,
        );
      }
      if (
        failure.errorCode === "PLAN_STEP_DISPATCH_UNAVAILABLE" ||
        failure.errorCode === "SKILL_INVOCATION_INVALID"
      ) {
        throw new LocalPlannerError(
          failure.errorCode,
          failure.errorCode,
          stepContext,
        );
      }
      throw new LocalPlannerError(
        "PLANNER_GOAL_EXECUTION_FAILED",
        failedResult
          ? skillResultErrorCode(failedResult.result)
          : failure.errorCode,
        stepContext,
      );
    }
    if (observedLast === null) {
      const failureCode = supervision.failure?.errorCode;
      if (failureCode === "STEP_TARGET_NOT_FOUND") {
        throw new LocalPlannerError(
          "STEP_TARGET_NOT_FOUND",
          "A trusted world target was not available for the next plan step.",
        );
      }
      throw new LocalPlannerError(
        "PLANNER_GOAL_EXECUTION_FAILED",
        failureCode ?? "The plan ended without a skill result.",
      );
    }
    const completed = observedLast;
    return {
      action: "skill_result",
      reasonCode: decision.reasonCode,
      invocation: completed.invocation,
      result: completed.result,
      ai,
    };
  }

  private bindPlanStep(
    request: LocalPlanRequest,
    initialRecord: BotRegistryRecord,
    availableSkills: readonly BotSkillCatalogEntryV1[],
    step: PlanStep,
    deadlineMs: number,
    externalSignal: AbortSignal | undefined,
    binding: PlanStepBinding,
  ): BoundPlanStep | null {
    const initialSkill = availableSkills.find(
      ({ skillId }) => skillId === step.skillId,
    );
    if (!initialSkill) {
      throw new LocalPlannerError(
        "PLAN_STEP_DISPATCH_UNAVAILABLE",
        `No advertised skill is available for ${step.skillId}.`,
      );
    }
    const currentRecord = this.requireUnchangedDispatchContext(
      request.botId,
      initialRecord,
      initialSkill,
    );
    const currentSkill = currentRecord.skillCatalog!.skills.find(
      ({ skillId, skillVersion, availability }) =>
        skillId === step.skillId &&
        skillVersion === initialSkill.skillVersion &&
        availability === "available",
    );
    if (!currentSkill) {
      throw new LocalPlannerError(
        "PLAN_STEP_DISPATCH_UNAVAILABLE",
        `Runtime no longer advertises ${step.skillId}.`,
      );
    }
    const dimension = currentRecord.currentStatus?.position?.dimension;
    if (!dimension) return null;
    const input = this.planStepInput(
      step,
      dimension,
      currentRecord.serverProfileId,
      binding,
      currentRecord,
    );
    if (input === null) return null;
    let trustedInput: SkillJsonValue;
    try {
      trustedInput = validateAdvertisedInput(currentSkill.inputSchema, input);
    } catch (cause) {
      if (cause instanceof LocalPlannerError) {
        throw new LocalPlannerError(
          "SKILL_INVOCATION_INVALID",
          cause.message,
        );
      }
      throw cause;
    }
    this.assertWithinDeadline(deadlineMs, externalSignal);
    const startedAt = this.validNow();
    const expiresAtMs = Math.min(
      deadlineMs,
      startedAt.getTime() + currentSkill.timeoutMs + skillDispatchHandshakeGraceMs(),
    );
    const invocation = this.invocation(
      request,
      step.skillId,
      currentSkill.skillVersion,
      trustedInput,
      startedAt,
      expiresAtMs,
    );
    return {
      invocation,
      runtimeInstanceId: currentRecord.runtimeInstanceId,
      idempotent: currentSkill.idempotent,
      signal: boundedAbortSignal(
        externalSignal,
        Math.max(1, Math.floor(expiresAtMs - startedAt.getTime())),
      ),
    };
  }

  private planStepInput(
    step: PlanStep,
    dimension: string,
    serverProfileId: string,
    binding: PlanStepBinding,
    currentRecord: BotRegistryRecord,
  ): SkillJsonValue | null {
    if (step.kind === "mine") {
      if (!step.targetBlock) return null;
      return {
        blockName: step.targetBlock,
        maxCount: step.runs,
        maxDistance: COORDINATOR_COLLECT_MAX_DISTANCE,
        dimension,
        serverProfileId,
      };
    }
    if (step.kind === "craft") {
      // A station-backed craft is bound only to a station this same plan placed
      // and the Runtime confirmed. Anything else would be the coordinator
      // asserting a workstation exists somewhere it has never observed one.
      let craftingTable: SkillJsonValue = null;
      if (step.station !== null) {
        const site = binding.placementSites.get(step.station);
        if (site === undefined) return null;
        craftingTable = { x: site.x, y: site.y, z: site.z };
      }
      return {
        itemName: step.itemName,
        count: step.runs,
        craftingTable,
        dimension,
        serverProfileId,
      };
    }
    if (step.kind === "smelt") {
      // A smelt is bound to the furnace this same plan placed and the Runtime
      // confirmed. The input/fuel names come from the deterministic plan's
      // consumption ledger; the model never gets to choose either one.
      const site = step.station === null
        ? undefined
        : binding.placementSites.get(step.station);
      if (site === undefined) return null;
      const smelt = smeltInputsForStep(step);
      if (smelt === null) return null;
      return {
        inputItemName: smelt.inputItemName,
        fuelItemName: smelt.fuelItemName,
        fuelCount: smelt.fuelCount,
        count: step.runs,
        furnace: { x: site.x, y: site.y, z: site.z },
        dimension,
        serverProfileId,
      };
    }
    if (step.kind === "place-station") {
      // The reference block comes from a `world.scan` observation taken moments
      // ago, never from arithmetic on the bot's own position: subtracting one
      // from y guesses that whatever is underfoot is solid, which is exactly
      // the guess this method used to refuse to make.
      const reference = binding.placementReference;
      if (reference === null) return null;
      return {
        itemName: step.itemName,
        referenceBlock: { x: reference.x, y: reference.y, z: reference.z },
        face: { ...COORDINATOR_PLACEMENT_FACE },
        dimension,
        serverProfileId,
      };
    }
    // Villager trades still need facts the coordinator does not hold, so they
    // keep failing closed instead of guessing.
    return null;
  }

  /**
   * Round 6.2 Facility 消费方：模型直派 smelt.item 且 furnace=null 时解析
   * 共享熔炉租约。返回 null 表示无可用共享站（busy 或目录为空都回退
   * furnace=null——Runtime 自放受守护的本地熔炉，行为与接入前一致）。
   */
  private async resolveFacilityLeaseForDispatch(
    request: LocalPlanRequest,
    skillId: string,
    trustedInput: SkillJsonValue,
    record: BotRegistryRecord,
  ): Promise<{
    position: { x: number; y: number; z: number };
    serverProfileId: string;
    dimension: string;
  } | null> {
    const registry = this.options.workstationRegistry;
    if (registry === undefined || skillId !== "smelt.item") return null;
    const input = trustedInput as { furnace?: unknown } | null;
    if (input === null || typeof input !== "object" || input.furnace != null) {
      return null;
    }
    const position = record.currentStatus?.position;
    const dimension = position?.dimension;
    if (!dimension) return null;
    // F3：租约接受前 server 真值验证——注册表条目可能已被世界变化证伪
    // （熔炉被破坏/替换）。验证用一次真实的 world.scan 派发（只读、幂等），
    // matches 里没有候选位置即证伪：发信号 + invalidate + 回退 null。
    const verifyFurnaceStillExists = async (
      entry: Readonly<{ position: { x: number; y: number; z: number } }>,
    ): Promise<boolean> => {
      try {
        const scanOutput = await this.dispatchObservation(
          request,
          record,
          record.skillCatalog!.skills,
          "world.scan",
          {
            blockName: "furnace",
            maxCount: 16,
            maxDistance: 64,
            dimension,
            serverProfileId: record.serverProfileId,
          },
          this.validNow().getTime() + 15_000,
        );
        const matches = Array.isArray(
          (scanOutput as { matches?: unknown } | null)?.matches,
        )
          ? ((scanOutput as { matches: Array<{ x: number; y: number; z: number }> }).matches)
          : [];
        return matches.some(
          (m) =>
            Math.floor(m.x) === entry.position.x &&
            Math.floor(m.y) === entry.position.y &&
            Math.floor(m.z) === entry.position.z,
        );
      } catch {
        // 世界观测不可得：fail-closed 拒绝该租约（不猜存在）
        return false;
      }
    };
    const acquired = await acquireWorkstation(registry, {
      serverProfileId: record.serverProfileId,
      dimension,
      type: "furnace",
      from: {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z),
      },
      botId: request.botId,
      verifyFn: verifyFurnaceStillExists,
      onFailureSignal: (signal: FacilityFailureSignal) => {
        this.options.logger?.warn?.("coordinator_facility_failure_signal", {
          botId: request.botId,
          failureCode: signal.failureCode,
          facilityType: signal.facilityType,
          position: signal.position,
          expected: signal.expected,
          actual: signal.actual,
        });
      },
    });
    if (acquired.status !== "acquired") return null;
    return {
      position: {
        x: acquired.entry.position.x,
        y: acquired.entry.position.y,
        z: acquired.entry.position.z,
      },
      serverProfileId: record.serverProfileId,
      dimension,
    };
  }

  /**
   * Round 6.2 Facility 消费方：world.scan 完成且扫的是 furnace 时，把观测到
   * 的位置（matches，distance 升序）注册进共享目录——目录内容全部来自真实
   * server 观测，不预测。busy contention 语义由 registry 的 lease 承载。
   */
  private registerFacilitiesFromScan(
    request: LocalPlanRequest,
    record: BotRegistryRecord,
    skillId: string,
    trustedInput: SkillJsonValue,
    skillResult: Readonly<{ payload: { outcome: string; output?: unknown } }>,
  ): void {
    const registry = this.options.workstationRegistry;
    if (registry === undefined) return;
    if (skillId !== "world.scan" || skillResult.payload.outcome !== "completed") return;
    const input = trustedInput as { blockName?: unknown; dimension?: unknown } | null;
    if (input === null || typeof input !== "object" || input.blockName !== "furnace") return;
    const dimension =
      typeof input.dimension === "string" ? input.dimension : "minecraft:overworld";
    const output = skillResult.payload.output as { matches?: unknown } | undefined;
    const matches = Array.isArray(output?.matches) ? output.matches : [];
    let registered = 0;
    for (const entry of matches) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { x?: unknown }).x === "number" &&
        typeof (entry as { y?: unknown }).y === "number" &&
        typeof (entry as { z?: unknown }).z === "number"
      ) {
        const pos = entry as { x: number; y: number; z: number };
        registry.register(record.serverProfileId, dimension, "furnace", {
          x: Math.floor(pos.x),
          y: Math.floor(pos.y),
          z: Math.floor(pos.z),
        });
        registered += 1;
      }
    }
    if (registered > 0) {
      this.options.logger?.info?.("coordinator_facility_registered", {
        botId: request.botId,
        registered,
      });
    }
  }

  /**
   * Observes a solid block the next station can be built on top of, or null when
   * none is in reach.
   *
   * `world.scan` is idempotent and read-only — it resolves a block name in the
   * Runtime's own registry and returns only positions it could actually read —
   * so the coordinator ends up holding an observed fact rather than a prediction.
   * The candidate list is a list of *names to look for*, not an assumption about
   * which one is there; whichever the scan returns is what the world has.
   */
  private async observePlacementReference(
    request: LocalPlanRequest,
    initialRecord: BotRegistryRecord,
    availableSkills: readonly BotSkillCatalogEntryV1[],
    deadlineMs: number,
  ): Promise<PlacementPosition | null> {
    const dimension = initialRecord.currentStatus?.position?.dimension;
    if (!dimension) return null;
    this.assertWithinDeadline(deadlineMs, request.signal);
    const openOutput = await this.dispatchObservation(
      request,
      initialRecord,
      availableSkills,
      "world.scan",
      {
        blockName: COORDINATOR_PLACEMENT_OPEN_BLOCK,
        maxCount: COORDINATOR_PLACEMENT_SCAN_MAX_COUNT,
        maxDistance: COORDINATOR_PLACEMENT_SCAN_MAX_DISTANCE,
        dimension,
        serverProfileId: initialRecord.serverProfileId,
      },
      deadlineMs,
    );
    const openPositions = scannedPositionKeys(openOutput);
    if (openPositions.size === 0) return null;
    for (const blockName of COORDINATOR_PLACEMENT_GROUND_BLOCKS) {
      this.assertWithinDeadline(deadlineMs, request.signal);
      const output = await this.dispatchObservation(
        request,
        initialRecord,
        availableSkills,
        "world.scan",
        {
          blockName,
          maxCount: COORDINATOR_PLACEMENT_SCAN_MAX_COUNT,
          maxDistance: COORDINATOR_PLACEMENT_SCAN_MAX_DISTANCE,
          dimension,
          serverProfileId: initialRecord.serverProfileId,
        },
        deadlineMs,
      );
      const reference = nearestPlacementReference(output, openPositions);
      if (reference !== null) {
        this.logPlacementSite(request, blockName);
        return reference;
      }
    }
    return null;
  }

  /**
   * Dispatches one read-only observation and returns its output, or null when
   * the Runtime did not complete it.
   *
   * Held to the same context checks as a plan step — same Runtime instance, same
   * ServerProfile, same advertised schema — because an observation the
   * coordinator then builds a placement on is trusted input, not a free lookup.
   * Restricted to idempotent Skills so a retry can never carry a side effect.
   */
  private async dispatchObservation(
    request: LocalPlanRequest,
    initialRecord: BotRegistryRecord,
    availableSkills: readonly BotSkillCatalogEntryV1[],
    skillId: string,
    input: SkillJsonValue,
    deadlineMs: number,
  ): Promise<SkillJsonValue | null> {
    const initialSkill = availableSkills.find(
      (candidate) => candidate.skillId === skillId,
    );
    if (!initialSkill) {
      throw new LocalPlannerError(
        "PLAN_STEP_DISPATCH_UNAVAILABLE",
        `No advertised skill is available for ${skillId}.`,
      );
    }
    if (!initialSkill.idempotent) {
      throw new LocalPlannerError(
        "PLAN_STEP_DISPATCH_UNAVAILABLE",
        `${skillId} is not idempotent and cannot be used as an observation.`,
      );
    }
    const currentRecord = this.requireUnchangedDispatchContext(
      request.botId,
      initialRecord,
      initialSkill,
    );
    let trustedInput: SkillJsonValue;
    try {
      trustedInput = validateAdvertisedInput(initialSkill.inputSchema, input);
    } catch (cause) {
      throw new LocalPlannerError(
        "SKILL_INVOCATION_INVALID",
        cause instanceof LocalPlannerError ? cause.message : `${skillId} input invalid.`,
      );
    }
    this.assertWithinDeadline(deadlineMs, request.signal);
    const startedAt = this.validNow();
    const expiresAtMs = Math.min(
      deadlineMs,
      startedAt.getTime() + initialSkill.timeoutMs,
    );
    const invocation = this.invocation(
      request,
      skillId,
      initialSkill.skillVersion,
      trustedInput,
      startedAt,
      expiresAtMs,
    );
    const result = await this.options.transport.sendSkillInvocation(
      invocation,
      currentRecord.runtimeInstanceId,
      boundedAbortSignal(
        request.signal,
        Math.max(1, Math.floor(expiresAtMs - startedAt.getTime())),
      ),
    );
    return result.payload.outcome === "completed" ? result.payload.output : null;
  }

  private async dispatchSkillWithRecovery(input: Readonly<{
    request: LocalPlanRequest;
    decision:
      | Extract<LocalPlannerDecision, { action: "invoke_skill" }>
      | DeterministicSkillDecision;
    trustedInput: SkillJsonValue;
    initialRecord: BotRegistryRecord;
    initialSkill: BotSkillCatalogEntryV1;
    deadlineMs: number;
    execution: TaskExecutionRecord;
    claim: PlannerExecutionClaim;
  }>): Promise<Readonly<{
    invocation: SkillInvocationV1;
    result: SkillExecutionResultV1;
    execution: TaskExecutionRecord;
  }>> {
    let execution = input.execution;
    for (;;) {
      await this.assertExecutionAttemptFresh(input.request, execution, input.claim);
      this.assertWithinDeadline(input.deadlineMs, input.request.signal);
      const currentRecord = await this.waitForSafetyClear({
        request: input.request,
        expectedTask: execution,
        initialRecord: input.initialRecord,
        initialSkill: input.initialSkill,
        deadlineMs: input.deadlineMs,
        claim: input.claim,
      });
      const dispatchStartedAt = this.validNow();
      const invocationDeadlineMs = Math.min(
        input.deadlineMs,
        dispatchStartedAt.getTime() + input.initialSkill.timeoutMs + skillDispatchHandshakeGraceMs(),
      );
      const skillTimeoutMs = Math.max(
        1,
        Math.floor(invocationDeadlineMs - dispatchStartedAt.getTime()),
      );
      const invocation = this.invocation(
        input.request,
        input.decision.skillId,
        input.decision.skillVersion,
        input.trustedInput,
        dispatchStartedAt,
        invocationDeadlineMs,
      );
      const dispatchSignal = boundedAbortSignal(
        input.request.signal,
        skillTimeoutMs,
      );
      const result = this.validatedSkillResult(
        await this.options.transport.sendSkillInvocation(
          invocation,
          currentRecord.runtimeInstanceId,
          dispatchSignal,
        ),
        invocation,
        currentRecord.runtimeInstanceId,
      );
      this.assertWithinDeadline(input.deadlineMs, input.request.signal);
      await this.assertExecutionAttemptFresh(input.request, execution, input.claim);
      if (result.payload.outcome === "completed") {
        return { invocation, result, execution };
      }
      const retryExecution = await this.prepareL0RecoveryRetry({
        request: input.request,
        result,
        execution,
        initialRecord: input.initialRecord,
        initialSkill: input.initialSkill,
        deadlineMs: input.deadlineMs,
        claim: input.claim,
      });
      if (retryExecution === null) return { invocation, result, execution };
      execution = retryExecution;
    }
  }

  private async prepareL0RecoveryRetry(input: Readonly<{
    request: LocalPlanRequest;
    result: SkillExecutionResultV1;
    execution: TaskExecutionRecord;
    initialRecord: BotRegistryRecord;
    initialSkill: BotSkillCatalogEntryV1;
    deadlineMs: number;
    claim: PlannerExecutionClaim;
  }>): Promise<TaskExecutionRecord | null> {
    if (input.result.payload.outcome === "completed") {
      throw new TypeError("Completed Skill results cannot enter recovery.");
    }
    const actualResult = skillResultSummary(input.result);
    const errorCode = input.result.payload.errorCode;
    const recoverableL0 = isRecoverableL0SkillResult(input.result);
    if (!recoverableL0) {
      await this.abortTaskExecution(
        input.request.taskId,
        errorCode,
        input.claim,
        {
          expectedRevision: input.execution.revision,
          currentStep: "terminal-skill-failure",
          actualResult,
        },
      );
      return null;
    }
    if (!isSafeL0Replay(input.result, input.initialSkill)) {
      await this.abortTaskExecution(
        input.request.taskId,
        `NON_IDEMPOTENT_L0_RETRY_UNSAFE:${errorCode}`,
        input.claim,
        {
          expectedRevision: input.execution.revision,
          currentStep: "non-idempotent-recovery-requires-replan",
          actualResult,
        },
      );
      return null;
    }

    const recoveryBudgetExhausted =
      input.execution.recoveryCount >= input.execution.maxRecoveryCount;
    const recovered = await this.transitionTaskExecution(
      input.request.taskId,
      "RECOVER",
      {
        expectedRevision: input.execution.revision,
        currentStep: recoveryBudgetExhausted
          ? "recovery-budget-exhausted"
          : "wait-for-safety-clear",
        actualResult,
        failureReason: errorCode,
      },
    );
    if (recovered.state === "ABORT") {
      this.options.metrics?.increment("bot_task_abort_total", {
        bot_id: input.request.botId,
        reason: recovered.failureReason ?? "RECOVERY_BUDGET_EXHAUSTED",
      });
      return null;
    }

    const readyRecord = await this.waitForSafetyClear({
      request: input.request,
      expectedTask: recovered,
      initialRecord: input.initialRecord,
      initialSkill: input.initialSkill,
      deadlineMs: input.deadlineMs,
      claim: input.claim,
    });
    const replanned = await this.transitionTaskExecution(
      input.request.taskId,
      "REPLAN",
      {
        expectedRevision: recovered.revision,
        currentStep: "revalidate-after-l0-interruption",
        worldStateVersion: worldStateVersion(readyRecord),
      },
    );
    this.assertWithinDeadline(input.deadlineMs, input.request.signal);
    return this.transitionTaskExecution(input.request.taskId, "EXECUTE", {
      expectedRevision: replanned.revision,
      currentStep: input.initialSkill.skillId,
      expectedResult: {
        outcome: "completed",
        skillId: input.initialSkill.skillId,
        skillVersion: input.initialSkill.skillVersion,
      },
      actualResult: null,
      worldStateVersion: worldStateVersion(readyRecord),
    });
  }

  private async beginTaskExecution(
    request: LocalPlanRequest,
    record: BotRegistryRecord,
    deadlineMs: number,
    onClaim: (claim: PlannerExecutionClaim) => void,
  ): Promise<PlannerExecutionContext> {
    const reportedWorldVersion = worldStateVersion(record);
    const requestedWorldVersion = request.worldStateVersion;
    const capturedWorldVersion = requestedWorldVersion ?? reportedWorldVersion;
    const claim: PlannerExecutionClaim = {
      owner: this.coordinatorInstanceId,
      leaseExpiresAt: new Date(deadlineMs).toISOString(),
    };
    let task = await this.taskStateMachine.get(request.taskId);
    this.assertTaskStartFresh(request, task);
    if (task === null) {
      try {
        task = await this.taskStateMachine.create({
          taskId: request.taskId,
          botId: request.botId,
          goal: request.operatorGoal,
          worldStateVersion: capturedWorldVersion,
          expectedResult: { outcome: "completed" },
          executionOwner: claim.owner,
          executionLeaseExpiresAt: claim.leaseExpiresAt,
        });
      } catch (cause) {
        if (cause instanceof TaskExecutionError) {
          const durable = cause.code === "TASK_EXECUTION_PERSISTENCE_FAILED"
            ? await this.readTaskAfterPersistenceRace(request.taskId)
            : null;
          if (cause.code === "TASK_EXECUTION_EXISTS" || durable !== null) {
            throw new LocalPlannerError(
              "PLANNER_RESTART_RECOVERY_STALE",
              "Another Coordinator created the task execution first.",
            );
          }
        }
        throw cause;
      }
      onClaim(claim);
      this.recordTaskTransition(request, null, task);
    } else {
      if (task.botId !== request.botId || task.goal !== request.operatorGoal) {
        throw new LocalPlannerError(
          "PLANNER_STALE_RESPONSE",
          "Goal task identity does not match the persisted execution.",
        );
      }
      if (
        task.state === "SUCCESS" ||
        task.state === "ABORT" ||
        task.cancellationToken.cancelled
      ) {
        throw new LocalPlannerError(
          "PLANNER_STALE_RESPONSE",
          "Goal task execution is terminal or cancelled.",
        );
      }
      const unclaimed = task;
      try {
        task = await this.taskStateMachine.claimExecution(task.taskId, {
          ...claim,
          expectedRevision: task.revision,
        });
      } catch (cause) {
        if (cause instanceof TaskExecutionError) {
          if (cause.code === "TASK_EXECUTION_OWNED") {
            throw new LocalPlannerError(
              "PLANNER_EXECUTION_OWNED",
              "Task execution already has an unexpired Coordinator lease.",
            );
          }
          if (cause.code === "TASK_EXECUTION_CANCELLED") {
            throw new LocalPlannerError(
              "PLANNER_CANCELLED",
              "Task execution was cancelled before its lease could be claimed.",
            );
          }
          if (
            cause.code === "TASK_EXECUTION_REVISION_CONFLICT" ||
            cause.code === "TASK_EXECUTION_TERMINAL"
          ) {
            throw new LocalPlannerError(
              "PLANNER_RESTART_RECOVERY_STALE",
              "Task execution changed before its Coordinator lease was claimed.",
            );
          }
          if (cause.code === "TASK_EXECUTION_PERSISTENCE_FAILED") {
            const durable = await this.readTaskAfterPersistenceRace(request.taskId);
            if (
              durable !== null &&
              (durable.revision !== unclaimed.revision ||
                durable.executionOwner !== unclaimed.executionOwner ||
                durable.executionLeaseExpiresAt !==
                  unclaimed.executionLeaseExpiresAt)
            ) {
              throw new LocalPlannerError(
                "PLANNER_RESTART_RECOVERY_STALE",
                "Another Coordinator won the durable execution claim.",
              );
            }
          }
        }
        throw cause;
      }
      onClaim(claim);
      if (task.state !== "PRECHECK") {
        task = await this.recoverTaskAfterRestart(
          request,
          record,
          task,
          capturedWorldVersion,
          deadlineMs,
        );
      }
    }
    if (task.state === "PRECHECK") {
      task = await this.transitionRestartTask(request, task, "PLAN", deadlineMs, {
        currentStep: "slow-cognitive-loop",
        worldStateVersion: capturedWorldVersion,
      });
    }
    return { task, worldStateVersion: task.worldStateVersion, claim };
  }

  private async readTaskAfterPersistenceRace(
    taskId: string,
  ): Promise<TaskExecutionRecord | null> {
    try {
      return await this.taskStateMachine.get(taskId);
    } catch {
      return null;
    }
  }

  private async recoverTaskAfterRestart(
    request: LocalPlanRequest,
    record: BotRegistryRecord,
    task: TaskExecutionRecord,
    worldStateVersion: number,
    deadlineMs: number,
  ): Promise<TaskExecutionRecord> {
    if (task.state === "PLAN") {
      const replanned = await this.transitionRestartTask(request, task, "REPLAN", deadlineMs, {
        currentStep: "restart-replan-interrupted-plan",
        worldStateVersion,
      });
      return this.transitionRestartTask(request, replanned, "PLAN", deadlineMs, {
        currentStep: "slow-cognitive-loop",
        expectedResult: { outcome: "completed" },
        actualResult: null,
        movementLease: null,
        worldStateVersion,
      });
    }
    if (task.state === "RECOVER") {
      const replanned = await this.transitionRestartTask(request, task, "REPLAN", deadlineMs, {
        currentStep: "restart-replan-interrupted-recovery",
        worldStateVersion,
      });
      return this.transitionRestartTask(request, replanned, "PLAN", deadlineMs, {
        currentStep: "slow-cognitive-loop",
        expectedResult: { outcome: "completed" },
        actualResult: null,
        movementLease: null,
        worldStateVersion,
      });
    }
    if (task.state === "REPLAN") {
      return this.transitionRestartTask(request, task, "PLAN", deadlineMs, {
        currentStep: "slow-cognitive-loop",
        expectedResult: { outcome: "completed" },
        actualResult: null,
        movementLease: null,
        worldStateVersion,
      });
    }
    if (task.state === "EXECUTE") {
      const interruptedSkill = restartExecutionSkill(task, record);
      if (interruptedSkill === null || !interruptedSkill.idempotent) {
        const reason = interruptedSkill === null
          ? "COORDINATOR_RESTART_EXECUTION_SKILL_UNKNOWN"
          : "COORDINATOR_RESTART_EXECUTION_NON_IDEMPOTENT";
        await this.abortRestartTask(request, task, reason, deadlineMs);
        throw new LocalPlannerError(
          "PLANNER_RESTART_RECOVERY_UNSAFE",
          "Interrupted execution cannot be conservatively replanned after restart.",
        );
      }
      const recovered = await this.transitionRestartTask(request, task, "RECOVER", deadlineMs, {
        currentStep: "restart-recover-interrupted-execution",
        failureReason: "COORDINATOR_RESTART_DURING_EXECUTE",
        movementLease: null,
        worldStateVersion,
      });
      if (recovered.state === "ABORT") {
        this.recordTaskAbortMetric(
          recovered,
          recovered.failureReason ?? "RECOVERY_BUDGET_EXHAUSTED",
        );
        throw new LocalPlannerError(
          "PLANNER_RESTART_RECOVERY_EXHAUSTED",
          "Interrupted execution exhausted its persistent recovery budget.",
        );
      }
      const replanned = await this.transitionRestartTask(request, recovered, "REPLAN", deadlineMs, {
        currentStep: "restart-replan-interrupted-execution",
        worldStateVersion,
      });
      return this.transitionRestartTask(request, replanned, "PLAN", deadlineMs, {
        currentStep: "slow-cognitive-loop",
        expectedResult: { outcome: "completed" },
        actualResult: null,
        movementLease: null,
        worldStateVersion,
      });
    }
    await this.abortRestartTask(
      request,
      task,
      `COORDINATOR_RESTART_STATE_UNRECOVERABLE:${task.state}`,
      deadlineMs,
    );
    throw new LocalPlannerError(
      "PLANNER_RESTART_RECOVERY_UNSAFE",
      "Persisted execution state cannot be conservatively resumed after restart.",
    );
  }

  private async transitionRestartTask(
    request: LocalPlanRequest,
    task: TaskExecutionRecord,
    to: Parameters<PersistentTaskStateMachine["transition"]>[1],
    deadlineMs: number,
    patch: Parameters<PersistentTaskStateMachine["transition"]>[2] = {},
  ): Promise<TaskExecutionRecord> {
    this.assertRestartRecoveryActive(request, deadlineMs);
    try {
      const transitioned = await this.transitionTaskExecution(task.taskId, to, {
        ...patch,
        expectedRevision: task.revision,
      });
      this.assertRestartRecoveryActive(request, deadlineMs);
      return transitioned;
    } catch (cause) {
      if (
        cause instanceof LocalPlannerError &&
        cause.code === "PLANNER_STALE_RESPONSE"
      ) {
        throw new LocalPlannerError(
          "PLANNER_RESTART_RECOVERY_STALE",
          "Persisted task changed while restart recovery was committing.",
        );
      }
      throw cause;
    }
  }

  private async abortRestartTask(
    request: LocalPlanRequest,
    task: TaskExecutionRecord,
    reason: string,
    deadlineMs: number,
  ): Promise<void> {
    const aborted = await this.transitionRestartTask(request, task, "ABORT", deadlineMs, {
      currentStep: "restart-recovery-aborted",
      failureReason: reason,
      movementLease: null,
    });
    this.recordTaskAbortMetric(aborted, reason);
  }

  private assertRestartRecoveryActive(
    request: LocalPlanRequest,
    deadlineMs: number,
  ): void {
    this.assertWithinDeadline(deadlineMs, request.signal);
    const external = request.currentVersions?.();
    if (external?.taskCancelled === true) {
      throw new LocalPlannerError(
        "PLANNER_CANCELLED",
        "Task execution was cancelled during restart recovery.",
      );
    }
    if (external?.taskCompleted === true) {
      throw new LocalPlannerError(
        "PLANNER_RESTART_RECOVERY_STALE",
        "Task execution completed while restart recovery was active.",
      );
    }
  }

  private assertTaskStartFresh(
    request: LocalPlanRequest,
    task: TaskExecutionRecord | null,
  ): void {
    if (request.signal?.aborted) {
      throw new LocalPlannerError(
        "PLANNER_CANCELLED",
        "Task execution was cancelled before planning started.",
      );
    }
    const external = request.currentVersions?.();
    if (external?.taskCancelled === true) {
      throw new LocalPlannerError(
        "PLANNER_CANCELLED",
        "Task execution was cancelled before planning started.",
      );
    }
    if (external?.taskCompleted === true) {
      throw new LocalPlannerError(
        "PLANNER_STALE_RESPONSE",
        "Task execution completed before planning started.",
      );
    }
    const expectedPlanVersion = task?.planVersion ?? 0;
    if (
      (request.planVersion !== undefined &&
        request.planVersion !== expectedPlanVersion) ||
      (task !== null &&
        external !== undefined &&
        external.planVersion !== task.planVersion) ||
      (task !== null &&
        request.worldStateVersion !== undefined &&
        request.worldStateVersion < task.worldStateVersion) ||
      (request.worldStateVersion !== undefined &&
        external !== undefined &&
        external.worldStateVersion !== request.worldStateVersion)
    ) {
      throw new LocalPlannerError(
        "PLANNER_STALE_RESPONSE",
        "Task or world version changed before planning started.",
      );
    }
  }

  /**
   * P0-4 语义 revalidation：响应回来时不比较 wall-clock，也不要求世界版本
   * 冻结——真实高层规划（Spark 实测 ~13s）期间 bot 的 worldStateVersion 必然
   * 前进（inventory/nearby 变化），相等断言会把所有"慢而有效"的响应构造性
   * 判死（PLANNER_STALE_RESPONSE 假阳性）。
   *
   * 仍然拒绝（真正的过期语义）：
   * - task 已消失 / 非 PLAN 态 / 已取消 / 执行 claim 已易主（被 supersede）
   * - planVersion 变化（另一个 planner 已介入）
   * - bot 已离线（会话失效）
   * - 世界版本回退（注册表损坏信号，fail closed）
   *
   * 世界版本前进（drift）被接受：计划分发的每一步 Skill 都有自己的
   * precondition/capability 检查与 server 验证，材质不匹配会走结构化
   * skill 失败 → replan，而不是在这里执行未经检验的旧世界假设。
   */
  private async assertTaskExecutionFresh(
    request: LocalPlanRequest,
    captured: PlannerExecutionContext,
  ): Promise<void> {
    const current = await this.taskStateMachine.get(request.taskId);
    const currentBot = this.options.registry.get(request.botId);
    const worldDriftAccepted =
      current !== null && current.worldStateVersion !== captured.task.worldStateVersion;
    const botWorldVersion = currentBot !== null ? worldStateVersion(currentBot) : 0;
    if (
      current === null ||
      current.state !== "PLAN" ||
      current.cancellationToken.cancelled ||
      !this.hasActiveExecutionClaim(current, captured.claim) ||
      current.planVersion !== captured.task.planVersion ||
      (currentBot === null || currentBot.connectionState !== "online") ||
      (botWorldVersion !== 0 && botWorldVersion < captured.worldStateVersion)
    ) {
      throw new LocalPlannerError(
        "PLANNER_STALE_RESPONSE",
        "Local planner response no longer matches the active task, claim, or Bot session.",
      );
    }
    if (worldDriftAccepted || botWorldVersion > captured.worldStateVersion) {
      this.options.logger?.info?.("coordinator_planner_world_drift_accepted", {
        taskId: request.taskId,
        botId: request.botId,
        taskWorldDrift: current.worldStateVersion - captured.task.worldStateVersion,
        botWorldDrift: botWorldVersion - captured.worldStateVersion,
        note: "slow-but-valid planning response revalidated semantically; per-skill preconditions remain the safety boundary",
      });
    }
  }

  private async finishSuccessfulTaskExecution(
    request: LocalPlanRequest,
    result: SkillExecutionResultV1,
    execution: TaskExecutionRecord,
  ): Promise<void> {
    const actualResult = skillResultSummary(result);
    const verified = await this.transitionTaskExecution(
      request.taskId,
      "VERIFY",
      {
        expectedRevision: execution.revision,
        currentStep: "postcondition-verify",
        actualResult,
      },
    );
    await this.transitionTaskExecution(request.taskId, "SUCCESS", {
      expectedRevision: verified.revision,
      currentStep: null,
      actualResult,
    });
    this.options.metrics?.increment("bot_task_success_total", {
      bot_id: request.botId,
    });
  }

  private validatedSkillResult(
    input: unknown,
    invocation: SkillInvocationV1,
    expectedRuntimeInstanceId: string,
  ): SkillExecutionResultV1 {
    let result: SkillExecutionResultV1;
    try {
      result = parseSkillExecutionResult(input);
    } catch {
      throw new LocalPlannerError(
        "PLANNER_SKILL_RESULT_INVALID",
        "Skill transport returned an invalid result envelope.",
      );
    }
    if (
      result.source.instanceId !== expectedRuntimeInstanceId ||
      result.botId !== invocation.botId ||
      result.taskId !== invocation.taskId ||
      result.traceId !== invocation.traceId ||
      result.payload.invocationId !== invocation.payload.invocationId ||
      result.payload.skillId !== invocation.payload.skillId ||
      result.payload.skillVersion !== invocation.payload.skillVersion
    ) {
      throw new LocalPlannerError(
        "PLANNER_SKILL_RESULT_INVALID",
        "Skill result identity does not match the active invocation.",
      );
    }
    return result;
  }

  private async assertExecutionAttemptFresh(
    request: LocalPlanRequest,
    expected: TaskExecutionRecord,
    claim: PlannerExecutionClaim,
  ): Promise<TaskExecutionRecord> {
    const current = await this.taskStateMachine.get(request.taskId);
    const external = request.currentVersions?.();
    if (
      current?.cancellationToken.cancelled === true ||
      external?.taskCancelled === true
    ) {
      throw new LocalPlannerError(
        "PLANNER_CANCELLED",
        "Task execution was cancelled while a Skill attempt was active.",
      );
    }
    if (
      current === null ||
      external?.taskCompleted === true ||
      !this.hasActiveExecutionClaim(current, claim) ||
      current.state !== expected.state ||
      current.revision !== expected.revision ||
      current.planVersion !== expected.planVersion ||
      current.worldStateVersion !== expected.worldStateVersion ||
      (external !== undefined &&
        (external.planVersion !== expected.planVersion ||
          external.worldStateVersion !== expected.worldStateVersion))
    ) {
      throw new LocalPlannerError(
        "PLANNER_STALE_RESPONSE",
        "Skill result no longer matches the active task execution revision.",
      );
    }
    return current;
  }

  private async waitForSafetyClear(input: Readonly<{
    request: LocalPlanRequest;
    expectedTask: TaskExecutionRecord;
    initialRecord: BotRegistryRecord;
    initialSkill: BotSkillCatalogEntryV1;
    deadlineMs: number;
    claim: PlannerExecutionClaim;
  }>): Promise<BotRegistryRecord> {
    let remainingWaitMs = Math.min(
      this.maxSafetyRecoveryWaitMs,
      Math.max(0, input.deadlineMs - this.validNow().getTime()),
    );
    for (;;) {
      this.assertWithinDeadline(input.deadlineMs, input.request.signal);
      await this.assertExecutionAttemptFresh(
        input.request,
        input.expectedTask,
        input.claim,
      );
      const record = this.options.registry.get(input.request.botId);
      if (
        !record ||
        record.connectionState !== "online" ||
        !record.currentStatus ||
        !record.currentStatus.safety ||
        !dispatchContextMatches(
          record,
          input.initialRecord,
          input.initialSkill,
        )
      ) {
        throw new LocalPlannerError(
          "PLANNER_BOT_UNAVAILABLE",
          "Bot Runtime changed or disconnected during L0 recovery.",
        );
      }
      if (!record.currentStatus.safety.normalTasksPaused) return record;
      if (remainingWaitMs <= 0) {
        throw new LocalPlannerError(
          "PLANNER_SAFETY_PAUSED",
          "L0 safety did not clear within the bounded recovery wait.",
        );
      }
      const delayMs = Math.min(
        this.safetyRecoveryPollIntervalMs,
        remainingWaitMs,
      );
      await abortableDelay(delayMs, input.request.signal);
      remainingWaitMs -= delayMs;
      this.assertWithinDeadline(input.deadlineMs, input.request.signal);
    }
  }

  private async failTaskExecution(
    request: LocalPlanRequest,
    cause: unknown,
    claim: PlannerExecutionClaim | null,
  ): Promise<void> {
    if (claim === null) return;
    const current = await this.readTaskAfterPersistenceRace(request.taskId);
    if (
      current === null ||
      current.state === "SUCCESS" ||
      current.state === "ABORT" ||
      !this.hasActiveExecutionClaim(current, claim)
    ) {
      return;
    }
    if (
      cause instanceof LocalPlannerError &&
      cause.code === "PLANNER_RESTART_RECOVERY_STALE"
    ) {
      return;
    }
    const cancellationRequested =
      request.signal?.aborted === true ||
      (cause instanceof LocalPlannerError && cause.code === "PLANNER_CANCELLED");
    const reason = cancellationRequested
      ? "PLANNER_CANCELLED"
      : cause instanceof LocalPlannerError
        ? cause.code
        : "PLANNER_EXECUTION_FAILED";
    if (cancellationRequested) {
      let cancelled: TaskExecutionRecord;
      try {
        cancelled = await this.taskStateMachine.cancel(
          request.taskId,
          reason,
          current.revision,
        );
      } catch (cancelCause) {
        if (
          cancelCause instanceof TaskExecutionError &&
          (cancelCause.code === "TASK_EXECUTION_REVISION_CONFLICT" ||
            cancelCause.code === "TASK_EXECUTION_TERMINAL" ||
            cancelCause.code === "TASK_EXECUTION_PERSISTENCE_FAILED")
        ) {
          return;
        }
        throw cancelCause;
      }
      if (
        cancelled.state === "ABORT" &&
        cancelled.cancellationToken.cancelled
      ) {
        this.recordTaskTransition(request, current, cancelled);
        this.options.metrics?.increment("bot_task_abort_total", {
          bot_id: request.botId,
          reason,
        });
      }
      return;
    }
    if (
      cause instanceof LocalPlannerError &&
      cause.code === "PLANNER_STALE_RESPONSE" &&
      current.state !== "PLAN"
    ) {
      return;
    }
    await this.abortTaskExecution(request.taskId, reason, claim, {
      expectedRevision: current.revision,
    });
  }

  private async abortTaskExecution(
    taskId: string,
    reason: string,
    claim: PlannerExecutionClaim,
    patch: Parameters<PersistentTaskStateMachine["transition"]>[2] = {},
  ): Promise<void> {
    const current = await this.taskStateMachine.get(taskId);
    if (
      current === null ||
      current.state === "SUCCESS" ||
      current.state === "ABORT" ||
      !this.hasActiveExecutionClaim(current, claim) ||
      (patch.expectedRevision !== undefined &&
        patch.expectedRevision !== current.revision)
    ) {
      return;
    }
    let aborted: TaskExecutionRecord;
    try {
      aborted = await this.transitionTaskExecution(taskId, "ABORT", {
        ...patch,
        expectedRevision: patch.expectedRevision ?? current.revision,
        failureReason: reason,
      });
    } catch (abortCause) {
      if (
        abortCause instanceof LocalPlannerError &&
        (abortCause.code === "PLANNER_STALE_RESPONSE" ||
          abortCause.code === "PLANNER_CANCELLED")
      ) {
        return;
      }
      throw abortCause;
    }
    if (aborted.state === "ABORT") {
      this.options.metrics?.increment("bot_task_abort_total", {
        bot_id: current.botId,
        reason,
      });
    }
  }

  private hasActiveExecutionClaim(
    task: TaskExecutionRecord,
    claim: PlannerExecutionClaim,
  ): boolean {
    return (
      task.executionOwner === claim.owner &&
      task.executionLeaseExpiresAt === claim.leaseExpiresAt &&
      Date.parse(claim.leaseExpiresAt) > this.validNow().getTime()
    );
  }

  private recordTaskAbortMetric(task: TaskExecutionRecord, reason: string): void {
    this.options.metrics?.increment("bot_task_abort_total", {
      bot_id: task.botId,
      reason,
    });
  }

  private async transitionTaskExecution(
    taskId: string,
    to: Parameters<PersistentTaskStateMachine["transition"]>[1],
    patch: Parameters<PersistentTaskStateMachine["transition"]>[2] = {},
  ): Promise<TaskExecutionRecord> {
    const before = await this.taskStateMachine.get(taskId);
    let after: TaskExecutionRecord;
    try {
      after = await this.taskStateMachine.transition(taskId, to, patch);
    } catch (cause) {
      if (cause instanceof TaskExecutionError) {
        if (cause.code === "TASK_EXECUTION_CANCELLED") {
          throw new LocalPlannerError(
            "PLANNER_CANCELLED",
            "Task execution was cancelled during a Coordinator transition.",
          );
        }
        if (
          cause.code === "TASK_EXECUTION_REVISION_CONFLICT" ||
          cause.code === "TASK_EXECUTION_TERMINAL"
        ) {
          throw new LocalPlannerError(
            "PLANNER_STALE_RESPONSE",
            "Task execution changed before the Coordinator transition committed.",
          );
        }
        if (
          cause.code === "TASK_EXECUTION_PERSISTENCE_FAILED" &&
          patch.expectedRevision !== undefined
        ) {
          let durable: TaskExecutionRecord | null = null;
          try {
            durable = await this.taskStateMachine.get(taskId);
          } catch {
            // Preserve the persistence failure when the durable winner is unknown.
          }
          if (durable?.cancellationToken.cancelled) {
            throw new LocalPlannerError(
              "PLANNER_CANCELLED",
              "Task execution was cancelled while a transition was persisted.",
            );
          }
          if (
            durable !== null &&
            durable.revision !== patch.expectedRevision
          ) {
            throw new LocalPlannerError(
              "PLANNER_STALE_RESPONSE",
              "A newer durable task revision won the transition race.",
            );
          }
        }
      }
      throw cause;
    }
    this.recordTaskTransition(
      { taskId, botId: after.botId, traceId: taskId },
      before,
      after,
    );
    return after;
  }

  private recordTaskTransition(
    request: Pick<LocalPlanRequest, "taskId" | "botId" | "traceId">,
    before: TaskExecutionRecord | null,
    after: TaskExecutionRecord,
  ): void {
    if (before?.state === after.state) return;
    this.options.metrics?.increment("bot_task_state_transitions_total", {
      bot_id: request.botId,
      from: before?.state ?? "CREATED",
      to: after.state,
    });
    if (after.state === "SUCCESS" || after.state === "ABORT") {
      this.recordPositiveMetric(
        "bot_task_completion_time_ms_total",
        {
          bot_id: request.botId,
          outcome: after.state === "SUCCESS" ? "success" : "abort",
        },
        Date.parse(after.updatedAt) - Date.parse(after.startTime),
      );
    }
    const fields = {
      traceId: request.traceId,
      taskId: request.taskId,
      botId: request.botId,
      skillId: null,
      modelName: null,
      fromState: before?.state ?? null,
      toState: after.state,
      currentStep: after.currentStep,
      planVersion: after.planVersion,
      worldStateVersion: after.worldStateVersion,
      retryCount: after.retryCount,
      recoveryCount: after.recoveryCount,
      expected: after.expectedResult,
      actual: after.actualResult,
      failureReason: after.failureReason,
    };
    try {
      const write = after.state === "ABORT"
        ? this.options.logger?.warn.bind(this.options.logger)
        : this.options.logger?.info.bind(this.options.logger);
      write?.("coordinator_task_transition", fields);
    } catch {
      // Observability cannot alter deterministic task execution.
    }
  }

  private recordAIUsage(
    request: Pick<LocalPlanRequest, "botId">,
    ai: AIScheduledResult<GenerateResult>,
  ): void {
    const labels = { bot_id: request.botId };
    this.recordPositiveMetric(
      "bot_llm_prompt_tokens_total",
      labels,
      ai.value.usage.promptTokens,
    );
    this.recordPositiveMetric(
      "bot_llm_completion_tokens_total",
      labels,
      ai.value.usage.completionTokens,
    );
    this.recordPositiveMetric(
      "bot_llm_queue_time_ms_total",
      labels,
      ai.queueTimeMs,
    );
    this.recordPositiveMetric(
      "bot_llm_execution_time_ms_total",
      labels,
      ai.executionTimeMs,
    );
    this.recordPositiveMetric(
      "bot_llm_total_latency_ms_total",
      labels,
      ai.totalTimeMs,
    );
  }

  private recordPositiveMetric(
    name: LifecycleMetricName,
    labels: Readonly<Record<string, string>>,
    rawAmount: number,
  ): void {
    const amount = roundedPositiveSafeInteger(rawAmount);
    if (amount !== null) this.options.metrics?.increment(name, labels, amount);
  }

  private validateRequest(request: LocalPlanRequest): void {
    const valid =
      identifierSchema.safeParse(request.requestId).success &&
      identifierSchema.safeParse(request.traceId).success &&
      identifierSchema.safeParse(request.taskId).success &&
      identifierSchema.safeParse(request.botId).success &&
      typeof request.operatorGoal === "string" &&
      request.operatorGoal.trim().length >= 1 &&
      request.operatorGoal.length <= 4_096 &&
      !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(
        request.operatorGoal,
      ) &&
      (request.assignmentLeaseOwner === undefined ||
        identifierSchema.safeParse(request.assignmentLeaseOwner).success) &&
      Number.isSafeInteger(request.timeoutMs) &&
      request.timeoutMs >= 10 &&
      request.timeoutMs <= 10 * 60_000 &&
      (request.planVersion === undefined || Number.isSafeInteger(request.planVersion)) &&
      (request.worldStateVersion === undefined || Number.isSafeInteger(request.worldStateVersion));
    if (!valid) {
      throw new LocalPlannerError(
        "PLANNER_REQUEST_INVALID",
        "Local planner request failed bounded validation.",
      );
    }
  }

  private assertFreshResponse(
    request: LocalPlanRequest,
    ai: AIScheduledResult<GenerateResult>,
    expected: PlannerExecutionContext,
  ): void {
    const createdAtMs = Date.parse(ai.enqueuedAt);
    const completedAtMs = Date.parse(ai.completedAt);
    if (
      ai.requestId !== request.requestId ||
      ai.botId !== request.botId ||
      !Number.isFinite(createdAtMs) ||
      !Number.isFinite(completedAtMs) ||
      completedAtMs < createdAtMs
    ) {
      throw new LocalPlannerError(
        "PLANNER_STALE_RESPONSE",
        "Local planner response identity or lifetime is stale.",
      );
    }
    if (!request.currentVersions) return;
    const current = request.currentVersions();
    if (
      current.taskCancelled === true ||
      current.taskCompleted === true ||
      current.planVersion !== expected.task.planVersion ||
      current.worldStateVersion < expected.task.worldStateVersion
    ) {
      // 世界版本前进不再判死（语义 revalidation，见 assertTaskExecutionFresh）；
      // 取消/完成/换 planner/版本回退仍然拒绝。
      throw new LocalPlannerError(
        "PLANNER_STALE_RESPONSE",
        "Local planner response no longer matches the active task or world version.",
      );
    }
  }

  private requireAvailableBot(botId: string): BotRegistryRecord {
    const record = this.options.registry.get(botId);
    if (
      !record ||
      record.connectionState !== "online" ||
      !record.currentStatus ||
      !record.currentStatus.safety
    ) {
      throw new LocalPlannerError(
        "PLANNER_BOT_UNAVAILABLE",
        "Target Bot is not online with current state.",
      );
    }
    if (record.currentStatus.safety.normalTasksPaused) {
      throw new LocalPlannerError(
        "PLANNER_SAFETY_PAUSED",
        "Target Bot L0 safety has paused normal tasks.",
      );
    }
    if (!record.skillCatalog) {
      throw new LocalPlannerError(
        "PLANNER_SKILL_CATALOG_UNAVAILABLE",
        "Target Bot has not advertised a skill catalog.",
      );
    }
    return record;
  }

  private requireUnchangedDispatchContext(
    botId: string,
    initialRecord: BotRegistryRecord,
    initialSkill: BotSkillCatalogEntryV1,
  ): BotRegistryRecord {
    const currentRecord = this.requireAvailableBot(botId);
    const currentSkill = currentRecord.skillCatalog!.skills.find(
      ({ skillId, skillVersion, availability }) =>
        skillId === initialSkill.skillId &&
        skillVersion === initialSkill.skillVersion &&
        availability === "available",
    );
    if (
      currentRecord.runtimeInstanceId !== initialRecord.runtimeInstanceId ||
      currentRecord.serverProfileId !== initialRecord.serverProfileId ||
      !currentSkill ||
      JSON.stringify(currentSkill) !== JSON.stringify(initialSkill)
    ) {
      throw new LocalPlannerError(
        "PLANNER_BOT_UNAVAILABLE",
        "Bot Runtime, ServerProfile, or Skill catalog changed during planning.",
      );
    }
    return currentRecord;
  }

  private invocation(
    request: LocalPlanRequest,
    skillId: string,
    skillVersion: string,
    input: SkillJsonValue,
    requestedAt: Date,
    expiresAtMs: number,
  ): SkillInvocationV1 {
    const expiresAt = new Date(expiresAtMs).toISOString();
    return skillInvocationV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      traceId: request.traceId,
      timestamp: requestedAt.toISOString(),
      source: {
        service: "coordinator",
        instanceId: this.coordinatorInstanceId,
      },
      botId: request.botId,
      taskId: request.taskId,
      type: "skill.invoke.v1",
      payload: {
        invocationId: this.randomId(),
        skillId,
        skillVersion,
        expiresAt,
        input,
        authorization: {
          decisionId: this.randomId(),
          actorId: this.actorId,
          issuedAt: requestedAt.toISOString(),
          expiresAt,
        },
      },
    });
  }

  private validNow(): Date {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new LocalPlannerError(
        "PLANNER_REQUEST_INVALID",
        "Local planner clock is invalid.",
      );
    }
    return value;
  }

  private assertWithinDeadline(
    deadlineMs: number,
    signal?: AbortSignal,
  ): void {
    if (signal?.aborted) {
      throw new LocalPlannerError(
        "PLANNER_CANCELLED",
        "Local planner request was cancelled.",
      );
    }
    if (this.validNow().getTime() >= deadlineMs) {
      throw new LocalPlannerError(
        "PLANNER_TIMEOUT",
        "Local planner exceeded its total request deadline.",
      );
    }
  }

  /**
   * Records which ground block a placement was sited on.
   *
   * The block *name* only. The position stays out for the same reason the
   * operator goal and Skill inputs do: diagnostics must not become a wider
   * disclosure channel than the prompt, and a station coordinate is a base
   * coordinate. The name is what triage actually needs — it says whether the
   * scan ladder found a site on its first candidate or its last.
   */
  private logPlacementSite(
    request: LocalPlanRequest,
    referenceBlockName: string,
  ): void {
    const logger = this.options.logger;
    if (!logger) return;
    try {
      logger.info("coordinator_planner_placement_site_observed", {
        traceId: request.traceId,
        taskId: request.taskId,
        botId: request.botId,
        referenceBlockName,
      });
    } catch {
      // Diagnostics must never change what the planner reports.
    }
  }

  /**
   * Records that a one-shot dispatch which produced nothing was re-planned.
   *
   * Without it the second attempt is indistinguishable from a first-pass
   * plan_items decision, and the operator-visible result no longer mentions the
   * Skill that was tried first. The Skill id is planner-derived, so this adds no
   * disclosure the catalog does not already carry.
   */
  private logEmptyDispatchReplanned(
    request: LocalPlanRequest,
    emptySkillId: string,
  ): void {
    const logger = this.options.logger;
    if (!logger) return;
    try {
      logger.warn("coordinator_planner_empty_dispatch_replanned", {
        traceId: request.traceId,
        taskId: request.taskId,
        botId: request.botId,
        emptySkillId,
      });
    } catch {
      // Diagnostics must never change what the planner reports.
    }
  }

  /**
   * Emits the step ladder for one goal.  Only planner-derived values are
   * recorded — step kinds, trusted item names, and outcome codes.  The
   * operator goal, Skill inputs, and world coordinates stay out, so turning
   * diagnostics on never widens what a log reader can see.
   */
  private logSupervision(
    request: LocalPlanRequest,
    steps: readonly PlanStep[],
    supervision: SupervisionResult,
  ): void {
    const logger = this.options.logger;
    if (!logger) return;
    const fields = {
      traceId: request.traceId,
      taskId: request.taskId,
      botId: request.botId,
      plannedSteps: steps.length,
      stepsCompleted: supervision.stepsCompleted,
      repairStepsInserted: supervision.repairStepsInserted,
      failureCode: supervision.failure?.errorCode ?? null,
      failureCategory: supervision.failure?.category ?? null,
      failureAction: supervision.failure?.action ?? null,
      failureStepIndex: supervision.failure?.stepIndex ?? null,
      failureItemName: supervision.failure?.itemName ?? null,
      steps: supervision.events.map((event) => ({
        kind: event.kind,
        stepIndex: event.stepIndex,
        itemName: event.itemName,
        attempt: event.attempt,
        execution: event.execution,
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        ...(event.category === undefined ? {} : { category: event.category }),
        ...(event.action === undefined ? {} : { action: event.action }),
        ...(event.insertedSteps === undefined
          ? {}
          : { insertedSteps: event.insertedSteps }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      })),
    };
    try {
      if (supervision.completed) {
        logger.info("coordinator_planner_goal_supervision", fields);
      } else {
        logger.warn("coordinator_planner_goal_supervision", fields);
      }
    } catch {
      // Diagnostics must never change what the planner reports.
    }
  }

  /**
   * `NON_IDEMPOTENT_RESULT_UNCERTAIN` is the right thing to *return* — a
   * non-idempotent step that may have already had side effects must not be
   * replayed. But it replaces the code the Skill actually reported, so the
   * supervision log alone cannot say what went wrong: a live `crafting_table`
   * plan recorded the mask while the real cause, `COLLECT_BLOCKS_FAILED`, was
   * only visible by cross-referencing the Runtime log on another host.
   *
   * So the mask is recorded alongside the code it hid. The returned outcome is
   * untouched; this only adds the one field that makes the coordinator log
   * self-sufficient.
   */
  /**
   * Names the excluded items a declined goal actually mentioned, so the one
   * question a `noop` cannot otherwise answer — "was this even offered?" — has a
   * recorded answer. Silence here means the goal named nothing excluded, which
   * is the case where the model's decline stands on its own.
   *
   * Uses the same spelling rule as the retry guard, so an item reported here is
   * exactly one the guard would also have recognised had it been bindable.
   */
  private logUnbindableGoalNames(
    request: LocalPlanRequest,
    operatorGoal: string,
    bindability: GoalBindability,
  ): void {
    const logger = this.options.logger;
    if (!logger) return;
    try {
      const named = bindability.excluded.filter(({ itemName }) =>
        goalNamesPlannedItem(operatorGoal, itemName),
      );
      if (named.length === 0) return;
      logger.warn("coordinator_planner_goal_named_unbindable_item", {
        traceId: request.traceId,
        taskId: request.taskId,
        botId: request.botId,
        unbindableItems: named.map(
          ({ itemName, reason }) => `${itemName}=${reason}`,
        ),
      });
    } catch {
      // Diagnostics must never change what the planner reports.
    }
  }

  private logMaskedStepFailure(
    request: LocalPlanRequest,
    step: PlanStep,
    original: StepOutcome,
    guarded: StepOutcome,
  ): void {
    const logger = this.options.logger;
    if (!logger) return;
    if (original.ok || guarded.ok) return;
    if (original.errorCode === guarded.errorCode) return;
    try {
      logger.warn("coordinator_planner_step_failure_masked", {
        traceId: request.traceId,
        taskId: request.taskId,
        botId: request.botId,
        skillId: step.skillId,
        itemName: step.itemName,
        reportedErrorCode: guarded.errorCode,
        skillErrorCode: original.errorCode,
      });
    } catch {
      // Diagnostics must never change what the planner reports.
    }
  }
}

function parseDecision(content: string): LocalPlannerDecision {
  try {
    return parseStructuredOutput(content, {
      name: "local-planner-decision",
      schema: localPlannerDecisionSchema,
    });
  } catch (error) {
    throw new LocalPlannerError(
      "PLANNER_DECISION_INVALID",
      "Local planner response failed strict JSON validation.",
      { cause: error },
    );
  }
}

function worldStateVersion(record: BotRegistryRecord): number {
  const candidate = record.worldState?.version;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate
    : 0;
}

function skillResultSummary(result: SkillExecutionResultV1): SkillJsonValue {
  return skillJsonValueSchema.parse({
    outcome: result.payload.outcome,
    skillId: result.payload.skillId,
    skillVersion: result.payload.skillVersion,
    attempts: result.payload.attempts,
    ...(result.payload.outcome === "completed"
      ? { output: result.payload.output }
      : { errorCode: result.payload.errorCode }),
  });
}

function isRecoverableL0SkillResult(result: SkillExecutionResultV1): boolean {
  return (
    result.payload.outcome !== "completed" &&
    RECOVERABLE_L0_ERROR_CODES.has(result.payload.errorCode)
  );
}

function isSafeL0Replay(
  result: SkillExecutionResultV1,
  skill: BotSkillCatalogEntryV1,
): boolean {
  if (result.payload.outcome === "completed") return false;
  // A precondition pause happens before a Skill can mutate the world. Other
  // interruptions may have committed a partial side effect.
  return skill.idempotent || result.payload.errorCode === "NORMAL_ACTIONS_PAUSED";
}

function dispatchContextMatches(
  currentRecord: BotRegistryRecord,
  initialRecord: BotRegistryRecord,
  initialSkill: BotSkillCatalogEntryV1,
): boolean {
  const currentSkill = currentRecord.skillCatalog?.skills.find(
    ({ skillId, skillVersion, availability }) =>
      skillId === initialSkill.skillId &&
      skillVersion === initialSkill.skillVersion &&
      availability === "available",
  );
  return (
    currentRecord.runtimeInstanceId === initialRecord.runtimeInstanceId &&
    currentRecord.serverProfileId === initialRecord.serverProfileId &&
    currentRecord.skillCatalog?.sequence === initialRecord.skillCatalog?.sequence &&
    currentSkill !== undefined &&
    JSON.stringify(currentSkill) === JSON.stringify(initialSkill)
  );
}

function restartExecutionSkill(
  task: TaskExecutionRecord,
  record: BotRegistryRecord,
): BotSkillCatalogEntryV1 | null {
  if (
    task.currentStep === null ||
    task.expectedResult === null ||
    Array.isArray(task.expectedResult) ||
    typeof task.expectedResult !== "object"
  ) {
    return null;
  }
  const expected = task.expectedResult as Record<string, unknown>;
  if (expected.outcome !== "completed") return null;
  const skillId = expected.skillId;
  const skillVersion = expected.skillVersion;
  if (
    typeof skillId !== "string" ||
    typeof skillVersion !== "string" ||
    task.currentStep !== skillId
  ) {
    return null;
  }
  return (
    record.skillCatalog?.skills.find(
      (skill) =>
        skill.skillId === skillId && skill.skillVersion === skillVersion,
    ) ?? null
  );
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new LocalPlannerError("PLANNER_CANCELLED", "Recovery wait was cancelled."),
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => finish(
      new LocalPlannerError("PLANNER_CANCELLED", "Recovery wait was cancelled."),
    );
    const finish = (error?: LocalPlannerError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function roundedPositiveSafeInteger(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : null;
}

function stepOutcomeFromResult(
  step: PlanStep,
  result: SkillExecutionResultV1,
  inventoryHeld: number = 0,
): StepOutcome {
  if (result.payload.outcome === "completed") {
    return completedOutputSatisfiesStep(step, result.payload.output, inventoryHeld)
      ? { ok: true }
      : { ok: false, errorCode: "STEP_OUTPUT_INSUFFICIENT" };
  }
  const errorCode =
    "errorCode" in result.payload && typeof result.payload.errorCode === "string"
      ? result.payload.errorCode
      : "SKILL_HANDLER_FAILED";
  return { ok: false, errorCode };
}

/**
 * Phase 3.6：从步骤绑定里取“值得走近”的世界目标位置。
 * mine 步骤的站点位置来自 binding；没有世界目标的步骤返回 null。
 */
function stepTargetPosition(
  step: PlanStep,
  binding: Readonly<{ placementSites: ReadonlyMap<string, { x: number; y: number; z: number }> }>,
): { x: number; y: number; z: number } | null {
  if (step.kind === "mine") {
    const site = step.station === null ? undefined : binding.placementSites.get(step.station);
    return site ?? null;
  }
  return null;
}

function nonIdempotentStepOutcome(
  result: SkillExecutionResultV1,
  outcome: StepOutcome,
): StepOutcome {
  if (outcome.ok) return outcome;
  // `rejected` 就是"谢绝了，什么都没动"。原先还额外要求 attempts === 0，那等于
  // 用"跑了几次"冒充"动没动过"：executor 的 attempts 在 definition.execute 一进去
  // 就是 1，不管适配器有没有真的碰过世界。实测代价是 collect.block 的**前置**
  // 可达性检查（一块都没挖）被当成"可能挖了一半"，真实码
  // COLLECT_TARGET_UNREACHABLE（STALE_WORLD → REOBSERVE_THEN_RETRY）被改写成
  // NON_IDEMPOTENT_RESULT_UNCERTAIN（CONTRACT_BUG → ESCALATE_TO_OPERATOR），
  // 第一次尝试就升级人工、repairStepsInserted=0。
  //
  // 不能改成按错误码放行：同一个码会从"动过"和"没动过"两个分支抛出
  // （collect 的前置检查 vs NoPath catch），只有抛出点知道。所以判据是抛出点
  // 自己声明的 SkillRefusal → executor 报 rejected，这里只读这一个事实。
  if (result.payload.outcome === "rejected") return outcome;
  // 其余终态都可能在失败前留下了部分副作用，重投不安全。
  return { ok: false, errorCode: NON_IDEMPOTENT_RESULT_UNCERTAIN };
}

/**
 * The counts that say the world or the inventory actually moved.
 *
 * A deliberate subset of the goal-summary allow-list. The names left out are
 * measurements, not production: `distanceToTarget: 0` means the bot arrived,
 * `targetsFound: 0` is an observation, and `totalScoreBefore/After` describe a
 * ranking. Reading a zero in any of those as "nothing happened" would be exactly
 * the inversion this predicate exists to avoid.
 */
const PRODUCTION_COUNT_KEYS = Object.freeze([
  "itemsCollected",
  "craftedCount",
  "smeltedCount",
  "movedCount",
  "changedCount",
] as const);

/**
 * True when a completed dispatch published production counts and every one of
 * them is zero — that is, the Skill succeeded at doing nothing.
 *
 * Fails closed in both directions that matter. A Skill that published no
 * production count at all returns false, because "cannot tell" must not be
 * spelled the same way as "told us it did nothing". And an unsuccessful outcome
 * returns false, because an error code already explains itself and re-planning
 * around it would be guessing at a cause.
 *
 * Reads the Skill's own output through the same allow-listed extraction the wire
 * uses, so the coordinator never derives a count it was not given.
 */
function dispatchChangedNothing(result: SkillExecutionResultV1): boolean {
  if (result.payload.outcome !== "completed") return false;
  const summary = goalResultSummaryFromOutput(result.payload.output);
  if (summary === undefined) return false;
  const produced = PRODUCTION_COUNT_KEYS.map((key) => summary[key]).filter(
    (count): count is number => count !== undefined,
  );
  return produced.length > 0 && produced.every((count) => count === 0);
}

function skillResultErrorCode(result: SkillExecutionResultV1): string {
  return "errorCode" in result.payload && typeof result.payload.errorCode === "string"
    ? result.payload.errorCode
    : "SKILL_HANDLER_FAILED";
}

function assertPlanGoalsGrounded(
  goals: readonly GoalRequest[],
  operatorGoal: string,
): void {
  for (const goal of goals) {
    if (!goalNamesPlannedItem(operatorGoal, goal.itemName)) {
      throw new LocalPlannerError(
        "PLANNER_INPUT_UNGROUNDED",
        `Planned item ${goal.itemName} was not named by the operator goal.`,
      );
    }
  }
}

/**
 * Maps a parsed coordinator goal template onto an invoke_skill decision for a
 * skill the Runtime actually advertises. Returns null when the required skill
 * is not in the catalog — the goal then falls back to the model branch rather
 * than dispatching something unverified.
 *
 * Inputs embed the trusted ServerProfile placeholder exactly like a model
 * decision would; injectTrustedServerProfile swaps in the real value and
 * rejects any attempt to spell a different one.
 */
function deterministicSkillDecision(
  parsed: Exclude<DeterministicGoal, { kind: "acquire-item" }>,
  request: LocalPlanRequest,
  dimension: string,
  availableSkills: readonly BotSkillCatalogEntryV1[],
  blueprintFilesForDecision: ReadonlyMap<string, BlueprintFile>,
): DeterministicSkillDecision | null {
  const advertisedVersion = (skillId: string): string | null => {
    const entry = availableSkills.find(
      (candidate) =>
        candidate.skillId === skillId && candidate.availability === "available",
    );
    return entry?.skillVersion ?? null;
  };
  if (parsed.kind === "move-to") {
    const skillVersion = advertisedVersion("movement.goto");
    if (skillVersion === null) return null;
    return {
      action: "invoke_skill",
      botId: request.botId,
      taskId: request.taskId,
      skillId: "movement.goto",
      skillVersion,
      input: {
        target: {
          x: parsed.x,
          y: parsed.y,
          z: parsed.z,
          dimension,
          serverProfileId: TRUSTED_SERVER_PROFILE_PLACEHOLDER,
        },
        radius: 2,
      },
      reasonCode: "DETERMINISTIC_MOVE",
    };
  }
  if (parsed.kind === "scan-block") {
    const skillVersion = advertisedVersion("world.scan");
    if (skillVersion === null) return null;
    return {
      action: "invoke_skill",
      botId: request.botId,
      taskId: request.taskId,
      skillId: "world.scan",
      skillVersion,
      input: {
        blockName: parsed.blockName,
        maxCount: 16,
        maxDistance: 64,
        dimension,
        serverProfileId: TRUSTED_SERVER_PROFILE_PLACEHOLDER,
      },
      reasonCode: "DETERMINISTIC_SCAN",
    };
  }
  if (parsed.kind === "secure-food") {
    const skillVersion = advertisedVersion("food.secure");
    if (skillVersion === null) return null;
    return {
      action: "invoke_skill",
      botId: request.botId,
      taskId: request.taskId,
      skillId: "food.secure",
      skillVersion,
      input: {
        targetCount: parsed.targetCount,
        dimension,
        serverProfileId: TRUSTED_SERVER_PROFILE_PLACEHOLDER,
      },
      reasonCode: "DETERMINISTIC_FOOD",
    };
  }
  if (parsed.kind === "combat-stance") {
    const stanceVersion = advertisedVersion("combat.stance");
    if (stanceVersion === null) return null;
    return {
      action: "invoke_skill",
      botId: request.botId,
      taskId: request.taskId,
      skillId: "combat.stance",
      skillVersion: stanceVersion,
      input: {
        stance: parsed.stance,
        serverProfileId: TRUSTED_SERVER_PROFILE_PLACEHOLDER,
      },
      reasonCode: "DETERMINISTIC_STANCE",
    };
  }
  if (parsed.kind === "equip-armor") {
    const equipVersion = advertisedVersion("inventory.equip-armor");
    if (equipVersion === null) return null;
    return {
      action: "invoke_skill",
      botId: request.botId,
      taskId: request.taskId,
      skillId: "inventory.equip-armor",
      skillVersion: equipVersion,
      input: {
        serverProfileId: TRUSTED_SERVER_PROFILE_PLACEHOLDER,
      },
      reasonCode: "DETERMINISTIC_EQUIP",
    };
  }
  if (parsed.kind === "build-blueprint-file") {
    const blueprintVersion = advertisedVersion("build.blueprint");
    if (blueprintVersion === null) return null;
    // 文件蓝图：cells 全部来自加载期校验过的 JSON（模型零转写），goal 只贡献
    // 锚点。批界/站位由文件声明；批间移动由编排层显式 movement goal 完成。
    const blueprint = blueprintFilesForDecision.get(parsed.name);
    if (blueprint === undefined) return null;
    return {
      action: "invoke_skill",
      botId: request.botId,
      taskId: request.taskId,
      skillId: "build.blueprint",
      skillVersion: blueprintVersion,
      input: {
        blueprint: {
          anchor: parsed.anchor,
          dimension,
          serverProfileId: TRUSTED_SERVER_PROFILE_PLACEHOLDER,
          cells: blueprintCellsForDispatch(blueprint),
        },
        ...(parsed.startIndex > 0 ? { startIndex: parsed.startIndex } : {}),
        maxPlacements: blueprint.batchSize,
      },
      reasonCode: "DETERMINISTIC_BLUEPRINT_FILE",
    };
  }
  if (parsed.kind === "build-blueprint-row") {
    const blueprintVersion = advertisedVersion("build.blueprint");
    if (blueprintVersion === null) return null;
    // 确定性构造蓝图：每格 offset 沿受控方向递增，参考面=格正下方、朝上。
    // 模型只被允许做非模板目标——结构化蓝图从不经过模型转写（保真度瓶颈）。
    const step =
      parsed.direction === "+x" ? { x: 1, y: 0, z: 0 }
      : parsed.direction === "-x" ? { x: -1, y: 0, z: 0 }
      : parsed.direction === "+z" ? { x: 0, y: 0, z: 1 }
      : { x: 0, y: 0, z: -1 };
    const cells = Array.from({ length: parsed.count }, (_, index) => ({
      offset: { x: step.x * index, y: 0, z: step.z * index },
      itemName: parsed.itemName,
      blockClass: "structural" as const,
      order: index * 8,
      referenceOffset: { x: 0, y: -1, z: 0 },
      face: { x: 0, y: 1, z: 0 },
    }));
    return {
      action: "invoke_skill",
      botId: request.botId,
      taskId: request.taskId,
      skillId: "build.blueprint",
      skillVersion: blueprintVersion,
      input: {
        blueprint: {
          anchor: parsed.anchor,
          dimension,
          serverProfileId: TRUSTED_SERVER_PROFILE_PLACEHOLDER,
          cells,
        },
        ...(parsed.startIndex > 0 ? { startIndex: parsed.startIndex } : {}),
        ...(parsed.maxPlacements !== null ? { maxPlacements: parsed.maxPlacements } : {}),
      },
      reasonCode: "DETERMINISTIC_BLUEPRINT_ROW",
    };
  }
  const skillVersion = advertisedVersion("shelter.dig");
  if (skillVersion === null) return null;
  return {
    action: "invoke_skill",
    botId: request.botId,
    taskId: request.taskId,
    skillId: "shelter.dig",
    skillVersion,
    input: {
      direction: parsed.direction,
      depth: parsed.depth,
      sealItemName: parsed.sealItemName,
      dimension,
      serverProfileId: TRUSTED_SERVER_PROFILE_PLACEHOLDER,
    },
    reasonCode: "DETERMINISTIC_SHELTER",
  };
}

function planGoalsAreGrounded(
  goals: readonly GoalRequest[],
  operatorGoal: string,
): boolean {
  return goals.every((goal) =>
    goalNamesPlannedItem(operatorGoal, goal.itemName),
  );
}

type SmeltStepInputs = Readonly<{
  inputItemName: string;
  fuelItemName: string;
  fuelCount: number;
}>;

/**
 * Extracts the smelt request from the deterministic planner ledger. A smelt
 * step consumes exactly one input material plus one selected fuel candidate;
 * returning null for any malformed shape keeps the coordinator fail-closed.
 */
function smeltInputsForStep(step: PlanStep): SmeltStepInputs | null {
  if (step.kind !== "smelt") return null;
  const fuel = step.consumes.find(({ itemName }) =>
    step.fuelCandidates.includes(itemName),
  );
  const input = step.consumes.find(({ itemName }) =>
    !step.fuelCandidates.includes(itemName),
  );
  if (
    !fuel ||
    !input ||
    !Number.isSafeInteger(fuel.count) ||
    fuel.count < 1 ||
    !Number.isSafeInteger(input.count) ||
    input.count < 1
  ) {
    return null;
  }
  return {
    inputItemName: input.itemName,
    fuelItemName: fuel.itemName,
    fuelCount: fuel.count,
  };
}

function completedOutputSatisfiesStep(
  step: PlanStep,
  output: SkillJsonValue,
  inventoryHeld: number = 0,
): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  // 已有快速通道（2026-09-04 闭环轮根因修复）：技能层发现目标物品手持量
  // 已满足时直接报 completed + craftedCount/smeltedCount:0（零产出）。
  // 此前 completedOutputSatisfiesStep 只认"本次产出达标"，两层语义打架
  // →STEP_OUTPUT_INSUFFICIENT→NON_IDEMPOTENT 循环失败抑制。对齐：零产出
  // + 手持已满足（inventoryHeld ≥ 产出需求）同样算步骤满足。
  const alreadySatisfied =
    Number.isSafeInteger(inventoryHeld) &&
    inventoryHeld >= step.producedCount &&
    inventoryHeld > 0;
  if (step.kind === "mine") {
    return (
      output.blockName === step.targetBlock &&
      typeof output.targetsFound === "number" &&
      Number.isInteger(output.targetsFound) &&
      output.targetsFound >= step.runs &&
      typeof output.itemsCollected === "number" &&
      Number.isInteger(output.itemsCollected) &&
      output.itemsCollected >= step.producedCount
    );
  }
  if (step.kind === "craft") {
    return (
      output.itemName === step.itemName &&
      output.requestedCount === step.runs &&
      typeof output.craftedCount === "number" &&
      Number.isInteger(output.craftedCount) &&
      (output.craftedCount >= step.producedCount ||
        (output.craftedCount === 0 && alreadySatisfied)) &&
      output.usedCraftingTable === (step.station !== null)
    );
  }
  if (step.kind === "smelt") {
    const smelt = smeltInputsForStep(step);
    return (
      smelt !== null &&
      output.inputItemName === smelt.inputItemName &&
      output.fuelItemName === smelt.fuelItemName &&
      output.outputItemName === step.itemName &&
      output.requestedCount === step.runs &&
      output.insertedFuelCount === smelt.fuelCount &&
      typeof output.smeltedCount === "number" &&
      Number.isInteger(output.smeltedCount) &&
      output.smeltedCount >= step.producedCount
    );
  }
  if (step.kind === "place-station") {
    // `placed: true` alone is the Runtime's word that it tried. The read-back
    // name and position are what prove the station the plan needs is the one
    // now standing there, so a later craft binds to an observed block.
    return (
      output.placed === true &&
      output.placedBlockName === step.itemName &&
      readPosition(output.position ?? null) !== null
    );
  }
  return false;
}

/**
 * A whole-block position, or null when the value is not one.
 *
 * Integers specifically: a fractional coordinate is an entity position, not a
 * block, and handing one back as a placement site would bind a later craft to a
 * block address that does not exist.
 */
function readPosition(value: SkillJsonValue): PlacementPosition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { x, y, z } = value as Record<string, SkillJsonValue>;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number" ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(z)
  ) {
    return null;
  }
  return { x, y, z };
}

/**
 * Where the Runtime confirmed a station actually landed, or null when its result
 * does not say.
 *
 * Read from the placement output rather than computed as `referenceBlock + face`,
 * because the coordinator's arithmetic is a prediction while this field is the
 * Runtime's own read-back of the block it found standing there afterwards.
 */
function placedStationPosition(
  result: SkillExecutionResultV1,
): PlacementPosition | null {
  if (result.payload.outcome !== "completed") return null;
  const output = result.payload.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  return readPosition((output as Record<string, SkillJsonValue>).position ?? null);
}

/**
 * The closest scanned block inside the placement window, or null when the scan
 * returned nothing usable.
 *
 * The window is both-sided on purpose. Below the minimum the match is the block
 * under the bot's own feet, and building on it would place a station inside the
 * bot; past the maximum it is out of placement reach and the Runtime would
 * refuse. Returning null for an empty window makes the step report
 * STEP_TARGET_NOT_FOUND rather than dispatching a placement that cannot work.
 */
function nearestPlacementReference(
  output: SkillJsonValue | null,
  openPositions: ReadonlySet<string>,
): PlacementPosition | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const matches = (output as Record<string, SkillJsonValue>).matches;
  if (!Array.isArray(matches)) return null;
  let best: PlacementPosition | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const match of matches) {
    if (!match || typeof match !== "object" || Array.isArray(match)) continue;
    const distance = (match as Record<string, SkillJsonValue>).distance;
    if (
      typeof distance !== "number" ||
      !Number.isFinite(distance) ||
      distance < COORDINATOR_PLACEMENT_MIN_DISTANCE ||
      distance > COORDINATOR_PLACEMENT_MAX_DISTANCE ||
      distance >= bestDistance
    ) {
      continue;
    }
    const position = readPosition(match);
    if (position === null) continue;
    if (!openPositions.has(positionKey({
      x: position.x,
      y: position.y + COORDINATOR_PLACEMENT_FACE.y,
      z: position.z,
    }))) {
      continue;
    }
    best = position;
    bestDistance = distance;
  }
  return best;
}

function scannedPositionKeys(output: SkillJsonValue | null): ReadonlySet<string> {
  const positions = new Set<string>();
  if (!output || typeof output !== "object" || Array.isArray(output)) return positions;
  const matches = (output as Record<string, SkillJsonValue>).matches;
  if (!Array.isArray(matches)) return positions;
  for (const match of matches) {
    const position = readPosition(match);
    if (position !== null) positions.add(positionKey(position));
  }
  return positions;
}

function positionKey(position: PlacementPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function transportFailureCode(cause: unknown): string {
  if (
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    const code = cause.code;
    if (code.includes("ABORT") || code.includes("CANCEL")) {
      return "SKILL_CANCELLED";
    }
  }
  return "SKILL_HANDLER_FAILED";
}

function safeBotContext(record: BotRegistryRecord, taskId: string) {
  const status = record.currentStatus!;
  return {
    botId: record.botId,
    taskId,
    connectionState: record.connectionState,
    health: status.health.current,
    food: status.food.level,
    armorPoints: status.armorPoints,
    inventory: (status.inventory ?? []).map(({ itemName, count }) => ({
      itemName,
      count,
    })),
    safetyMode: status.safety?.mode ?? null,
    activeRiskCodes: status.safety?.activeRisks ?? ["SAFETY_STATUS_UNAVAILABLE"],
    minecraftVersion: record.minecraftVersion?.resolvedVersion ?? null,
    currentDimension: status.position?.dimension ?? null,
  };
}

function heldCountFor(
  step: PlanStep,
  record: BotRegistryRecord,
): number {
  if (!("itemName" in step)) return 0;
  return (
    (record.currentStatus?.inventory ?? []).find(
      (item) => item.itemName === step.itemName,
    )?.count ?? 0
  );
}

function plannerInventoryFromRecord(
  record: BotRegistryRecord,
): PlannerInventory {
  const items = record.currentStatus?.inventory;
  if (!items) return {};
  const inventory: Record<string, number> = {};
  for (const { itemName, count } of items) {
    if (!Number.isSafeInteger(count) || count < 1) continue;
    inventory[itemName] = count;
  }
  return inventory;
}

function plannerInputSchema(schema: SkillJsonValue, depth = 0): SkillJsonValue {
  if (depth > 20) {
    throw new LocalPlannerError(
      "PLANNER_SKILL_CATALOG_UNAVAILABLE",
      "Advertised Skill schema exceeds the planner depth boundary.",
    );
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  const output: Record<string, SkillJsonValue> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (
      key === "properties" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const properties: Record<string, SkillJsonValue> = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        properties[propertyName] =
          propertyName === "serverProfileId"
            ? {
                const: TRUSTED_SERVER_PROFILE_PLACEHOLDER,
                description: "Trusted Coordinator field; return the constant exactly.",
              }
            : plannerInputSchema(propertySchema, depth + 1);
      }
      output[key] = properties;
      continue;
    }
    if (PLANNER_SCHEMA_LITERAL_KEYWORDS.has(key)) {
      output[key] = structuredClone(value);
      continue;
    }
    if (PLANNER_SCHEMA_CHILD_KEYWORDS.has(key)) {
      output[key] = plannerInputSchema(value, depth + 1);
      continue;
    }
    if (PLANNER_SCHEMA_CHILD_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      output[key] = value.map((entry) => plannerInputSchema(entry, depth + 1));
    }
  }
  return output;
}

const PLANNER_SCHEMA_LITERAL_KEYWORDS = new Set([
  "type",
  "required",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);
const PLANNER_SCHEMA_CHILD_KEYWORDS = new Set([
  "items",
  "contains",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
]);
const PLANNER_SCHEMA_CHILD_ARRAY_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

function validateAdvertisedInput(
  schema: SkillJsonValue,
  input: SkillJsonValue,
): SkillJsonValue {
  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(
      schema as Parameters<typeof z.fromJSONSchema>[0],
    );
  } catch {
    throw new LocalPlannerError(
      "PLANNER_SKILL_CATALOG_UNAVAILABLE",
      "Runtime advertised an unsupported Skill input schema.",
    );
  }
  const result = validator.safeParse(input);
  if (!result.success) {
    throw new LocalPlannerError(
      "PLANNER_DECISION_INVALID",
      "Local planner Skill input failed the advertised JSON Schema.",
    );
  }
  return skillJsonValueSchema.parse(result.data);
}

function safeOperatorGoal(
  operatorGoal: string,
  record: BotRegistryRecord,
): string {
  const goal = operatorGoal.trim();
  const lowerGoal = goal.toLocaleLowerCase("en-US");
  const protectedValues = [record.serverProfileId, record.runtimeInstanceId];
  const containsKnownProtectedValue = protectedValues.some(
    (value) => value.length > 0 && lowerGoal.includes(value.toLocaleLowerCase("en-US")),
  );
  const containsSensitiveLabel =
    /\b(?:password|secret|api[ _-]?key|token|whitelist|allowlist|server address|base coordinates?)\b|密码|密钥|令牌|白名单|正式服地址|基地坐标/iu.test(
      goal,
    );
  const containsNetworkIdentity =
    /\b(?:https?|wss?|ssh):\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9-]+(?:\.[a-z0-9-]+){1,}\b/iu.test(
      goal,
    );
  const exactPosition = record.currentStatus?.position;
  const exposesCurrentPosition = exactPosition
    ? coordinateTriplesFromGoal(goal).some(
        ([x, y, z]) =>
          x === exactPosition.x && y === exactPosition.y && z === exactPosition.z,
      )
    : false;
  if (
    containsKnownProtectedValue ||
    containsSensitiveLabel ||
    containsNetworkIdentity ||
    exposesCurrentPosition
  ) {
    throw new LocalPlannerError(
      "PLANNER_SENSITIVE_GOAL",
      "Operator goal contains information that is not allowed in model prompts.",
    );
  }
  return goal;
}

function assertGroundedSensitiveInput(
  input: SkillJsonValue,
  operatorGoal: string,
  record: BotRegistryRecord,
): void {
  const coordinateTriples = coordinateTriplesFromGoal(operatorGoal);
  const allowedDimensions = dimensionsFromGoal(
    operatorGoal,
    record.currentStatus?.position.dimension ?? null,
  );
  const visit = (value: SkillJsonValue): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, SkillJsonValue>;
    if (
      typeof object.x === "number" &&
      typeof object.y === "number" &&
      typeof object.z === "number" &&
      !coordinateTriples.some(
        ([x, y, z]) => x === object.x && y === object.y && z === object.z,
      )
    ) {
      throw new LocalPlannerError(
        "PLANNER_INPUT_UNGROUNDED",
        "Coordinate input was not deterministically grounded in the operator goal.",
      );
    }
    for (const [key, child] of Object.entries(object)) {
      if (
        key === "dimension" &&
        typeof child === "string" &&
        !allowedDimensions.has(child)
      ) {
        throw new LocalPlannerError(
          "PLANNER_INPUT_UNGROUNDED",
          "Dimension input was not grounded in trusted state or the operator goal.",
        );
      }
      if (
        PLAYER_IDENTITY_FIELDS.has(key) &&
        typeof child === "string" &&
        !containsGoalToken(operatorGoal, child)
      ) {
        throw new LocalPlannerError(
          "PLANNER_INPUT_UNGROUNDED",
          "Player identity input was not grounded in the operator goal.",
        );
      }
      visit(child);
    }
  };
  visit(input);
}

const PLAYER_IDENTITY_FIELDS = new Set([
  "playerId",
  "playerName",
  "targetPlayer",
  "username",
]);

function coordinateTriplesFromGoal(goal: string): Array<readonly [number, number, number]> {
  const number = "-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
  const separator = "(?:\\s*[,;，、]\\s*|\\s+)";
  const patterns = [
    new RegExp(
      `(?:^|[^\\p{L}\\p{N}_])x\\s*[:=：]?\\s*(${number})${separator}y\\s*[:=：]?\\s*(${number})${separator}z\\s*[:=：]?\\s*(${number})`,
      "giu",
    ),
    new RegExp(
      `(?:coordinates?|coords?|position|坐标|位置)\\s*[:=：]?\\s*[\\[(（]?\\s*(${number})${separator}(${number})${separator}(${number})`,
      "giu",
    ),
  ];
  const triples: Array<readonly [number, number, number]> = [];
  for (const pattern of patterns) {
    for (const match of goal.matchAll(pattern)) {
      triples.push([Number(match[1]), Number(match[2]), Number(match[3])]);
    }
  }
  return triples;
}

function dimensionsFromGoal(
  goal: string,
  currentDimension: string | null,
): ReadonlySet<string> {
  const dimensions = new Set<string>();
  if (currentDimension) dimensions.add(currentDimension);
  if (/minecraft:overworld|\boverworld\b|主世界/iu.test(goal)) {
    dimensions.add("minecraft:overworld");
  }
  if (/minecraft:the_nether|\bnether\b|下界/iu.test(goal)) {
    dimensions.add("minecraft:the_nether");
  }
  if (/minecraft:the_end|\bthe end\b|末地/iu.test(goal)) {
    dimensions.add("minecraft:the_end");
  }
  return dimensions;
}

function containsGoalToken(goal: string, token: string): boolean {
  return goalTokenPattern(token, "iu").test(goal);
}

/**
 * The one spelling rule every goal-token reader shares. `goalNameSpans` needs
 * the pattern itself rather than a boolean, so it lives here instead of being
 * rebuilt per caller — two copies of this rule would be two chances for the
 * retry guard and the grounding check to disagree.
 *
 * The word boundaries are lookarounds rather than consumed characters so a
 * match spans the token alone. Consuming a delimiter would fold it into the
 * span and make a nested name look the same length as its container, which is
 * exactly the comparison `strictlyCovers` depends on. Acceptance is unchanged:
 * either way a token must not be flanked by an identifier character.
 */
function goalTokenPattern(token: string, flags: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`,
    flags,
  );
}

function boundedAbortSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  return externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;
}

function injectTrustedServerProfile(
  input: SkillJsonValue,
  serverProfileId: string,
): SkillJsonValue {
  if (Array.isArray(input)) {
    return input.map((value) =>
      injectTrustedServerProfile(value, serverProfileId),
    );
  }
  if (!input || typeof input !== "object") return input;
  const output: Record<string, SkillJsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "serverProfileId") {
      if (value !== TRUSTED_SERVER_PROFILE_PLACEHOLDER) {
        throw new LocalPlannerError(
          "PLANNER_DECISION_INVALID",
          "Local planner attempted to provide a trusted ServerProfile value.",
        );
      }
      output[key] = serverProfileId;
      continue;
    }
    output[key] = injectTrustedServerProfile(value, serverProfileId);
  }
  return output;
}

// ---- S-12 回放语料采集（env 门控 STUDIO_REPLAY_CAPTURE=1；有界 8MB；失败静默）----
const REPLAY_CAPTURE_PATH = "runtime-data/replay-inputs.jsonl";
const REPLAY_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
let replayCaptureEnabled: boolean | null = null;

function openReplayCapture(): ((entry: Record<string, unknown>) => void) | null {
  if (replayCaptureEnabled === null) {
    replayCaptureEnabled = process.env.STUDIO_REPLAY_CAPTURE === "1";
  }
  if (!replayCaptureEnabled) return null;
  try {
    const stat = statSync(REPLAY_CAPTURE_PATH);
    if (stat.size >= REPLAY_CAPTURE_MAX_BYTES) return null;
  } catch {
    // 不存在：首次采集
  }
  try {
    mkdirSync(dirname(REPLAY_CAPTURE_PATH), { recursive: true });
    const fd = openSync(REPLAY_CAPTURE_PATH, "a");
    return (entry) => {
      try { appendFileSync(fd, JSON.stringify(entry) + "\n"); } catch { /* 采集失败静默 */ }
    };
  } catch {
    return null;
  }
}
