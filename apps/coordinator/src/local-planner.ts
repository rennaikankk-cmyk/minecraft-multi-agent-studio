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
  skillIdForStepKind,
  type GoalRequest,
  type PlanStep,
  type PlannerInventory,
  type StepOutcome,
} from "@minecraft-studio/skills";
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

const PLAN_ITEMS_ACQUISITION_GOAL_PATTERN =
  /(?:obtain|craft|make|build|gather|collect|acquire|获取|制作|采集|收集|合成)/iu;

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
  const named = [...new Set(plannedItemNames)].filter((itemName) =>
    planGoalItemNameSchema.safeParse(itemName).success &&
    goalNamesPlannedItem(operatorGoal, itemName),
  );
  return named.length === 1 ? named[0]! : null;
}

/**
 * The single spelling rule shared by the retry guard and the pre-dispatch
 * grounding check, so a goal the guard treats as naming an item can never be
 * one that assertPlanGoalsGrounded then rejects as ungrounded.
 */
function goalNamesPlannedItem(operatorGoal: string, itemName: string): boolean {
  const aliases = PLANNED_ITEM_GOAL_ALIASES[itemName] ?? [];
  return (
    containsGoalToken(operatorGoal, itemName) ||
    containsGoalToken(operatorGoal, itemName.replaceAll("_", " ")) ||
    aliases.some((alias) => containsGoalToken(operatorGoal, alias))
  );
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
  constructor(
    readonly code: LocalPlannerErrorCode,
    message: string,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(message, options);
    this.name = "LocalPlannerError";
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
  now?: () => Date;
  randomId?: () => string;
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

const COORDINATOR_COLLECT_MAX_DISTANCE = 16;
const REOBSERVE_TIMEOUT_MS = 5_000;
const NON_IDEMPOTENT_RESULT_UNCERTAIN = "NON_IDEMPOTENT_RESULT_UNCERTAIN";
const PLANNED_ITEM_GOAL_ALIASES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    oak_log: Object.freeze(["oak log", "oak_log", "橡木原木", "原木"]),
    oak_planks: Object.freeze([
      "oak planks",
      "oak_planks",
      "橡木木板",
      "木板",
    ]),
    stick: Object.freeze(["stick", "sticks", "木棍"]),
    crafting_table: Object.freeze([
      "crafting table",
      "crafting_table",
      "工作台",
      "合成台",
    ]),
  });

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
    const plannedItemNames = this.coordinatorBindableGoalNames(availableSkills);
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

  private coordinatorBindableGoalNames(
    availableSkills: readonly BotSkillCatalogEntryV1[],
  ): readonly string[] {
    const available = new Set(
      availableSkills.map(({ skillId }) => skillId),
    );
    const names: string[] = [];
    for (const itemName of this.goalPlanner.resourceGraph.knownItemNames()) {
      const plan = this.goalPlanner.plan([{ itemName, count: 1 }], {});
      if (!plan.planned || plan.steps.length === 0) continue;
      if (
        plan.steps.every(
          (step) =>
            available.has(skillIdForStepKind[step.kind]) &&
            (step.kind === "mine" ||
              (step.kind === "craft" && step.station === null)),
        )
      ) {
        names.push(itemName);
      }
    }
    return Object.freeze(names);
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
      return null;
    }
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
        (step) =>
          !availableSkillIds.has(step.skillId) ||
          (step.kind === "craft" && step.station !== null) ||
          step.kind === "smelt" ||
          step.kind === "place-station",
      )
    ) {
      throw new LocalPlannerError(
        "PLANNER_GOAL_UNSUPPORTED",
        "The Runtime catalog cannot safely bind every derived plan step.",
      );
    }

    let last: LastSkillResult | null = null;
    const supervision = await this.planSupervisor.run(
      plan.steps,
      async (step, _attempt): Promise<StepOutcome> => {
        this.assertWithinDeadline(deadlineMs, request.signal);
        let bound: BoundPlanStep | null;
        try {
          bound = this.bindPlanStep(
            request,
            initialRecord,
            availableSkills,
            step,
            deadlineMs,
            request.signal,
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
          if (bound.idempotent) return outcome;
          return nonIdempotentStepOutcome(result, outcome);
        } catch (cause) {
          if (!bound.idempotent) {
            return {
              ok: false,
              errorCode: NON_IDEMPOTENT_RESULT_UNCERTAIN,
            };
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
      if (failure.errorCode === "STEP_TARGET_NOT_FOUND") {
        throw new LocalPlannerError(
          "STEP_TARGET_NOT_FOUND",
          "A trusted world target was not available for the next plan step.",
        );
      }
      if (
        failure.errorCode === "PLAN_STEP_DISPATCH_UNAVAILABLE" ||
        failure.errorCode === "SKILL_INVOCATION_INVALID"
      ) {
        throw new LocalPlannerError(failure.errorCode, failure.errorCode);
      }
      throw new LocalPlannerError(
        "PLANNER_GOAL_EXECUTION_FAILED",
        failedResult
          ? skillResultErrorCode(failedResult.result)
          : failure.errorCode,
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
    externalSignal?: AbortSignal,
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
    const input = this.planStepInput(step, dimension, currentRecord.serverProfileId);
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
    if (step.kind === "craft" && step.station === null) {
      return {
        itemName: step.itemName,
        count: step.runs,
        craftingTable: null,
        dimension,
        serverProfileId,
      };
    }
    // Workstations, furnaces, and placement faces must come from a
    // server-scoped observation provider. The coordinator has no such fact
    // in the current registry, so it fails closed instead of guessing.
    return null;
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
  return false;
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
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`,
    "iu",
  ).test(goal);
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
