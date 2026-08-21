import { randomUUID } from "node:crypto";

import {
  aiRequestPriorities,
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
import { z } from "zod";

import type { BotRegistry, BotRegistryRecord } from "./bot-registry.js";
import {
  buildLocalPlannerPrompt,
  LOCAL_PLANNER_PROMPT_VERSION,
  LOCAL_PLANNER_SYSTEM_PROMPT,
} from "./planner-prompts.js";

const reasonCodeSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/u);
const TRUSTED_SERVER_PROFILE_PLACEHOLDER = "$CURRENT_SERVER_PROFILE";

export const localPlannerDecisionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("noop"),
      botId: identifierSchema,
      taskId: identifierSchema,
      reasonCode: reasonCodeSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("invoke_skill"),
      botId: identifierSchema,
      taskId: identifierSchema,
      skillId: skillIdentifierSchema,
      skillVersion: skillVersionSchema,
      input: skillJsonValueSchema,
      reasonCode: reasonCodeSchema,
    })
    .strict(),
]);

export type LocalPlannerDecision = z.infer<typeof localPlannerDecisionSchema>;

export type LocalPlanRequest = Readonly<{
  requestId: string;
  traceId: string;
  taskId: string;
  botId: string;
  operatorGoal: string;
  timeoutMs: number;
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

export type SkillInvocationTransport = Readonly<{
  sendSkillInvocation: (
    invocation: SkillInvocationV1,
    expectedRuntimeInstanceId: string,
    signal: AbortSignal,
  ) => Promise<SkillExecutionResultV1>;
}>;

export type LocalPlannerErrorCode =
  | "PLANNER_REQUEST_INVALID"
  | "PLANNER_BOT_UNAVAILABLE"
  | "PLANNER_SAFETY_PAUSED"
  | "PLANNER_SKILL_CATALOG_UNAVAILABLE"
  | "PLANNER_DECISION_INVALID"
  | "PLANNER_DECISION_MISMATCH"
  | "PLANNER_SKILL_UNAVAILABLE"
  | "PLANNER_INPUT_UNGROUNDED"
  | "PLANNER_SENSITIVE_GOAL"
  | "PLANNER_TIMEOUT";

export class LocalPlannerError extends Error {
  constructor(readonly code: LocalPlannerErrorCode, message: string) {
    super(message);
    this.name = "LocalPlannerError";
  }
}

export type CoordinatorLocalPlannerOptions = Readonly<{
  ai: Pick<ScheduledAIRouter, "generate">;
  registry: Pick<BotRegistry, "get">;
  transport: SkillInvocationTransport;
  coordinatorInstanceId: string;
  actorId?: string;
  now?: () => Date;
  randomId?: () => string;
}>;

export class CoordinatorLocalPlanner {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly coordinatorInstanceId: string;
  private readonly actorId: string;

  constructor(private readonly options: CoordinatorLocalPlannerOptions) {
    this.coordinatorInstanceId = identifierSchema.parse(
      options.coordinatorInstanceId,
    );
    this.actorId = identifierSchema.parse(options.actorId ?? "local-planner");
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
  }

  async planAndDispatch(request: LocalPlanRequest): Promise<LocalPlanResult> {
    this.validateRequest(request);
    const startedAt = this.validNow();
    const deadlineMs = startedAt.getTime() + request.timeoutMs;
    this.assertWithinDeadline(deadlineMs, request.signal);
    const record = this.requireAvailableBot(request.botId);
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

    let prompt: string;
    try {
      prompt = buildLocalPlannerPrompt({
        promptVersion: LOCAL_PLANNER_PROMPT_VERSION,
        operatorGoal,
        bot: safeBotContext(record, request.taskId),
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
      schema: localPlannerDecisionSchema,
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
      return { action: "noop", reasonCode: decision.reasonCode, ai };
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
      decision,
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
      currentRecord.skillCatalog!.sequence !== initialRecord.skillCatalog!.sequence ||
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
    decision: Extract<LocalPlannerDecision, { action: "invoke_skill" }>,
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
        skillId: decision.skillId,
        skillVersion: decision.skillVersion,
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
    return localPlannerDecisionSchema.parse(JSON.parse(content) as unknown);
  } catch {
    throw new LocalPlannerError(
      "PLANNER_DECISION_INVALID",
      "Local planner response failed strict JSON validation.",
    );
  }
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
