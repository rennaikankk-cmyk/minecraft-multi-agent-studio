import { randomUUID } from "node:crypto";

import {
  aiRequestPriorities,
  type AIScheduledResult,
  type GenerateResult,
  type ScheduledAIRouter,
} from "@minecraft-studio/ai-router";
import {
  identifierSchema,
  skillIdentifierSchema,
  skillInvocationV1Schema,
  skillJsonValueSchema,
  skillVersionSchema,
  type SkillExecutionResultV1,
  type SkillInvocationV1,
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
  | "PLANNER_SKILL_UNAVAILABLE";

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

    const prompt = buildLocalPlannerPrompt({
      promptVersion: LOCAL_PLANNER_PROMPT_VERSION,
      operatorGoal: request.operatorGoal,
      bot: safeBotContext(record, request.taskId),
      availableSkills: availableSkills.map(
        ({ skillId, skillVersion, verification }) => ({
          skillId,
          skillVersion,
          verification,
        }),
      ),
    });
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
    if (
      !availableSkills.some(
        ({ skillId, skillVersion }) =>
          skillId === decision.skillId && skillVersion === decision.skillVersion,
      )
    ) {
      throw new LocalPlannerError(
        "PLANNER_SKILL_UNAVAILABLE",
        "Local planner selected a skill outside the Runtime catalog.",
      );
    }

    const invocation = this.invocation(request, decision);
    const dispatchSignal = request.signal ?? new AbortController().signal;
    const result = await this.options.transport.sendSkillInvocation(
      invocation,
      record.runtimeInstanceId,
      dispatchSignal,
    );
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

  private invocation(
    request: LocalPlanRequest,
    decision: Extract<LocalPlannerDecision, { action: "invoke_skill" }>,
  ): SkillInvocationV1 {
    const requestedAt = this.now();
    if (!Number.isFinite(requestedAt.getTime())) {
      throw new LocalPlannerError(
        "PLANNER_REQUEST_INVALID",
        "Local planner clock is invalid.",
      );
    }
    const expiresAt = new Date(requestedAt.getTime() + 30_000).toISOString();
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
        input: decision.input,
        authorization: {
          decisionId: this.randomId(),
          actorId: this.actorId,
          issuedAt: requestedAt.toISOString(),
          expiresAt,
        },
      },
    });
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
  };
}
