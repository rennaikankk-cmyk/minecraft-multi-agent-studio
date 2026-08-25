import { randomUUID } from "node:crypto";

import {
  aiRequestPriorities,
  parseStructuredOutput,
  type AIScheduledResult,
  type GenerateResult,
  type ScheduledAIRouter,
} from "@minecraft-studio/ai-router";
import {
  identifierSchema,
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
  type GoalRequest,
  type PlanStep,
  type PlannerInventory,
  type StepOutcome,
  type SupervisionResult,
} from "@minecraft-studio/skills";
import type { AppLogger } from "@minecraft-studio/observability";
import { z } from "zod";

import type { BotRegistry, BotRegistryRecord } from "./bot-registry.js";
import {
  BotAssignmentError,
  type BotAssignmentService,
} from "./bot-assignment.js";
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
 * Offers exactly one plan_items branch for a single trusted item, with no noop
 * and no invoke branch.
 *
 * Reserved for the retry below. With all branches offered, the model answers a
 * gather-then-craft goal with noop/NO_SAFE_SKILL every time: it reads "no one
 * advertised skill completes this" as grounds to decline, and no amount of
 * prompt wording moved it (v7 through v11 all measured 0). Removing the branch
 * it wrongly prefers is the only lever left that does not weaken a check.
 *
 * Narrowing is safe precisely because it constrains generation only: the
 * response is still re-parsed with the protocol-backed
 * localPlannerDecisionSchema, still grounded against the operator goal, and
 * every expanded step is still authorized by the deterministic GoalPlanner.
 */
export function buildLocalPlannerPlanItemsRetrySchema(
  itemName: string,
  trustedIdentity?: LocalPlannerTrustedIdentity,
) {
  if (!planGoalItemNameSchema.safeParse(itemName).success) {
    throw new LocalPlannerError(
      "PLANNER_GOAL_UNSUPPORTED",
      "The retry item name is outside the trusted planning vocabulary.",
    );
  }
  return localPlannerPlanItemsDecisionSchema(z.literal(itemName)).extend(
    trustedIdentityFields(trustedIdentity),
  );
}

/**
 * 取得类动词。中文一侧此前只认书面的"获取/制作/采集/收集/合成"，
 * 而"做一个熔炉""挖点铁矿"这类最常见的口语说法一个都不匹配——目标里明明写了
 * 可达物品，却因为动词没登记而降级成 noop。英文一侧早已同时收 make 与 build，
 * 中文补齐到同一水位。
 *
 * 放宽的只是"这句话是不是在要东西"，不是任何安全判定：候选仍只能来自
 * 确定性规划器已证明可达的集合，且必须唯一命中，否则照样返回 null。
 */
const PLAN_ITEMS_ACQUISITION_GOAL_PATTERN =
  /(?:obtain|craft|make|build|gather|collect|acquire|mine|smelt|获取|制作|采集|收集|合成|做|造|挖|烧)/iu;

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
}>;

export type LocalPlanResult =
  | Readonly<{
      action: "noop";
      reasonCode: string;
      ai: AIScheduledResult<GenerateResult>;
    }>
  | Readonly<{
      action: "skill_result";
      reasonCode: string;
      invocation: SkillInvocationV1;
      result: SkillExecutionResultV1;
      ai: AIScheduledResult<GenerateResult>;
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
  | "SKILL_INVOCATION_INVALID";

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
  now?: () => Date;
  randomId?: () => string;
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

const COORDINATOR_COLLECT_MAX_DISTANCE = 16;
const REOBSERVE_TIMEOUT_MS = 5_000;
const NON_IDEMPOTENT_RESULT_UNCERTAIN = "NON_IDEMPOTENT_RESULT_UNCERTAIN";

/** The one face a scanned ground block can be built on without further observation. */
const COORDINATOR_PLACEMENT_FACE = Object.freeze({ x: 0, y: 1, z: 0 });
/**
 * Stations the coordinator can place. `furnace` is deliberately absent: placing
 * it is the easy half, and the `smelt` step that follows still needs fuel
 * accounting and furnace interaction the coordinator cannot bind.
 */
const COORDINATOR_PLACEABLE_STATIONS: ReadonlySet<string> = new Set([
  "crafting_table",
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
/**
 * A reference must be far enough not to be the block under the bot's own feet
 * and near enough to stay inside placement reach. Outside this window the
 * coordinator reports no site rather than dispatching a placement the Runtime
 * would refuse.
 */
const COORDINATOR_PLACEMENT_MIN_DISTANCE = 2;
const COORDINATOR_PLACEMENT_MAX_DISTANCE = 4.5;

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
    oak_planks: Object.freeze([
      "oak planks",
      "oak_planks",
      "橡木木板",
      "木板",
    ]),
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
  private readonly planSupervisor: PlanSupervisor;

  constructor(private readonly options: CoordinatorLocalPlannerOptions) {
    this.coordinatorInstanceId = identifierSchema.parse(
      options.coordinatorInstanceId,
    );
    this.actorId = identifierSchema.parse(options.actorId ?? "local-planner");
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.goalPlanner = new GoalPlanner();
    this.planSupervisor = new PlanSupervisor(this.goalPlanner);
  }

  async planAndDispatch(request: LocalPlanRequest): Promise<LocalPlanResult> {
    this.validateRequest(request);
    const startedAt = this.validNow();
    const deadlineMs = startedAt.getTime() + request.timeoutMs;
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
    this.assertWithinDeadline(deadlineMs, request.signal);
    const decision = parseDecision(ai.value.content);
    if (decision.botId !== request.botId || decision.taskId !== request.taskId) {
      throw new LocalPlannerError(
        "PLANNER_DECISION_MISMATCH",
        "Local planner decision changed the trusted task or Bot identity.",
      );
    }
    if (decision.action === "noop") {
      const retried = await this.retryDeclinedAcquisitionGoal({
        request,
        operatorGoal,
        plannedItemNames,
        record,
        availableSkills,
        deadlineMs,
      });
      if (retried) return retried;
      this.logUnbindableGoalNames(request, operatorGoal, bindability);
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
    assertGroundedSensitiveInput(modelInput, operatorGoal, record);

    const currentRecord = this.requireUnchangedDispatchContext(
      request.botId,
      record,
      advertisedSkill,
    );
    const currentSkill = currentRecord.skillCatalog!.skills.find(
      ({ skillId, skillVersion, availability }) =>
        skillId === decision.skillId && skillVersion === decision.skillVersion,
    )!;
    const trustedInput = injectTrustedServerProfile(
      modelInput,
      currentRecord.serverProfileId,
    );
    validateAdvertisedInput(currentSkill.inputSchema, trustedInput);

    this.assertWithinDeadline(deadlineMs, request.signal);
    const dispatchStartedAt = this.validNow();
    const invocationDeadlineMs = Math.min(
      deadlineMs,
      dispatchStartedAt.getTime() + currentSkill.timeoutMs,
    );
    const skillTimeoutMs = Math.max(
      1,
      Math.floor(invocationDeadlineMs - dispatchStartedAt.getTime()),
    );
    const invocation = this.invocation(
      request,
      decision.skillId,
      decision.skillVersion,
      trustedInput,
      dispatchStartedAt,
      invocationDeadlineMs,
    );
    const dispatchSignal = boundedAbortSignal(request.signal, skillTimeoutMs);
    const result = await this.options.transport.sendSkillInvocation(
      invocation,
      currentRecord.runtimeInstanceId,
      dispatchSignal,
    );
    this.assertWithinDeadline(deadlineMs, request.signal);
    return {
      action: "skill_result",
      reasonCode: decision.reasonCode,
      invocation,
      result,
      ai,
    };
    });
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
        bindableCount: bindability.bindable.length,
        excludedCount: bindability.excluded.length,
        exclusionReasons: reasonCounts,
      });
    } catch {
      // Diagnostics must never change what the planner reports.
    }
  }

  /**
   * Re-asks a declined single-item acquisition goal with only the plan_items
   * branch on offer, and returns null whenever the goal is not one.
   *
   * Measured behaviour, not a guess: offered every branch, the model answers
   * "craft one crafting_table from nearby resources" with noop/NO_SAFE_SKILL on
   * 6 of 6 requests while a forced single-branch probe produced the correct
   * decision 4 of 4 times. The capability is there; the branch choice is what
   * fails, so this removes the choice for the one goal shape that is provably
   * reachable and asks again.
   *
   * A null return leaves the model's original noop standing untouched, which is
   * why an honest decline can never be overturned here: the guard requires an
   * acquisition verb and exactly one named item from the trusted reachable set,
   * and no such goal is one the deterministic planner cannot serve.
   */
  private async retryDeclinedAcquisitionGoal({
    request,
    operatorGoal,
    plannedItemNames,
    record,
    availableSkills,
    deadlineMs,
  }: {
    request: LocalPlanRequest;
    operatorGoal: string;
    plannedItemNames: readonly string[];
    record: BotRegistryRecord;
    availableSkills: readonly BotSkillCatalogEntryV1[];
    deadlineMs: number;
  }): Promise<LocalPlanResult | null> {
    const itemName = plannedAcquisitionGoalItem(operatorGoal, plannedItemNames);
    if (itemName === null) return null;
    this.assertWithinDeadline(deadlineMs, request.signal);

    const retryAi = await this.options.ai.generate({
      requestId: `${request.requestId}:plan-items-retry`,
      botId: request.botId,
      priority: aiRequestPriorities.planning,
      supersedeKey: `plan-items-retry:${request.taskId}`,
      prompt: buildLocalPlannerPrompt({
        promptVersion: LOCAL_PLANNER_PROMPT_VERSION,
        operatorGoal,
        bot: safeBotContext(record, request.taskId),
        plannedItems: [itemName],
        availableSkills: [],
      }),
      systemPrompt: LOCAL_PLANNER_SYSTEM_PROMPT,
      schema: buildLocalPlannerPlanItemsRetrySchema(itemName, {
        botId: request.botId,
        taskId: request.taskId,
      }),
      maxTokens: 512,
      temperature: 0,
      timeoutMs: request.timeoutMs,
      traceId: request.traceId,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    this.assertWithinDeadline(deadlineMs, request.signal);

    // The narrowed grammar constrains generation only. The response still has
    // to satisfy the protocol-backed schema and carry the trusted identity,
    // exactly as a first-pass decision does.
    const retryDecision = parseDecision(retryAi.value.content);
    if (
      retryDecision.action !== "plan_items" ||
      retryDecision.botId !== request.botId ||
      retryDecision.taskId !== request.taskId
    ) {
      this.logRetry(request, itemName, "discarded", retryDecision.action);
      return null;
    }
    this.logRetry(request, itemName, "accepted", retryDecision.action);
    return this.planItemsAndDispatch(
      request,
      retryDecision,
      record,
      availableSkills,
      retryAi,
      deadlineMs,
    );
  }

  private async planItemsAndDispatch(
    request: LocalPlanRequest,
    decision: LocalPlannerPlanItemsDecision,
    initialRecord: BotRegistryRecord,
    availableSkills: readonly BotSkillCatalogEntryV1[],
    ai: AIScheduledResult<GenerateResult>,
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
    const plan = this.goalPlanner.plan(goals, {} satisfies PlannerInventory);
    if (!plan.planned || plan.steps.length === 0) {
      throw new LocalPlannerError(
        "PLANNER_GOAL_UNSUPPORTED",
        plan.planned
          ? "The requested goal requires no dispatchable steps."
          : `The trusted planner could not derive ${plan.blockedOn}.`,
      );
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
          const outcome = stepOutcomeFromResult(step, result);
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
            const guarded = {
              ok: false as const,
              errorCode: NON_IDEMPOTENT_RESULT_UNCERTAIN,
            };
            this.logMaskedStepFailure(
              request,
              step,
              { ok: false, errorCode: transportFailureCode(cause) },
              guarded,
            );
            return guarded;
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
      startedAt.getTime() + currentSkill.timeoutMs,
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
    // Furnaces and villager trades still need facts the coordinator does not
    // hold, so they keep failing closed instead of guessing.
    return null;
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
      const reference = nearestPlacementReference(output);
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
      request.timeoutMs <= 10 * 60_000;
    if (!valid) {
      throw new LocalPlannerError(
        "PLANNER_REQUEST_INVALID",
        "Local planner request failed bounded validation.",
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
    if (signal?.aborted || this.validNow().getTime() >= deadlineMs) {
      throw new LocalPlannerError(
        "PLANNER_TIMEOUT",
        "Local planner exceeded or cancelled its total request deadline.",
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
   * Records whether the narrowed re-ask overturned a declined acquisition
   * goal.  The retry is otherwise invisible: a discarded one looks exactly
   * like a first-pass noop from outside the planner.
   */
  private logRetry(
    request: LocalPlanRequest,
    itemName: string,
    disposition: "accepted" | "discarded",
    retriedAction: string,
  ): void {
    const logger = this.options.logger;
    if (!logger) return;
    try {
      logger.info("coordinator_planner_plan_items_retry", {
        traceId: request.traceId,
        taskId: request.taskId,
        botId: request.botId,
        itemName,
        disposition,
        retriedAction,
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

function stepOutcomeFromResult(
  step: PlanStep,
  result: SkillExecutionResultV1,
): StepOutcome {
  if (result.payload.outcome === "completed") {
    return completedOutputSatisfiesStep(step, result.payload.output)
      ? { ok: true }
      : { ok: false, errorCode: "STEP_OUTPUT_INSUFFICIENT" };
  }
  const errorCode =
    "errorCode" in result.payload && typeof result.payload.errorCode === "string"
      ? result.payload.errorCode
      : "SKILL_HANDLER_FAILED";
  return { ok: false, errorCode };
}

function nonIdempotentStepOutcome(
  result: SkillExecutionResultV1,
  outcome: StepOutcome,
): StepOutcome {
  if (outcome.ok) return outcome;
  if (
    result.payload.outcome === "rejected" &&
    result.payload.attempts === 0
  ) {
    return outcome;
  }
  // A handler may have produced partial side effects before any other terminal
  // outcome. Only a pre-execution rejection proves a fresh invocation is safe.
  return { ok: false, errorCode: NON_IDEMPOTENT_RESULT_UNCERTAIN };
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

function completedOutputSatisfiesStep(
  step: PlanStep,
  output: SkillJsonValue,
): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
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
      output.craftedCount >= step.producedCount &&
      output.usedCraftingTable === (step.station !== null)
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
    best = position;
    bestDistance = distance;
  }
  return best;
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
    safetyMode: status.safety?.mode ?? null,
    activeRiskCodes: status.safety?.activeRisks ?? ["SAFETY_STATUS_UNAVAILABLE"],
    minecraftVersion: record.minecraftVersion?.resolvedVersion ?? null,
    currentDimension: status.position?.dimension ?? null,
  };
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
