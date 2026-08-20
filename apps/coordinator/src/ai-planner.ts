import { randomUUID } from "node:crypto";

import {
  AIError,
  AI_PRIORITIES,
  aiSkillDecisionJsonSchema,
  aiSkillDecisionSchema,
  buildPrefixCachePrompt,
  compactBotContextSchema,
  type AIScheduledHandle,
  type AISkillDecision,
  type AITaskType,
  type AIRequestScheduler,
  type JSONValue,
} from "@minecraft-studio/ai-router";

import type { BotRegistry, BotRegistryRecord } from "./bot-registry.js";

export type CoordinatorAIPlanningErrorCode =
  | "BOT_NOT_FOUND"
  | "BOT_NOT_ONLINE"
  | "BOT_STATUS_UNAVAILABLE"
  | "SKILL_CATALOG_UNAVAILABLE"
  | "SKILL_NOT_AVAILABLE"
  | "TASK_VERSION_STALE"
  | "AI_DECISION_MISSING";

export class CoordinatorAIPlanningError extends Error {
  readonly code: CoordinatorAIPlanningErrorCode;

  constructor(code: CoordinatorAIPlanningErrorCode, message: string) {
    super(message);
    this.name = "CoordinatorAIPlanningError";
    this.code = code;
  }
}

export type CoordinatorPlanRequest = Readonly<{
  botId: string;
  task: string;
  taskVersion: number;
  taskId?: string;
  traceId?: string;
  taskType?: AITaskType;
  priority?: number;
  relevantMemory?: readonly string[];
  recentFailures?: readonly string[];
  teamState?: readonly string[];
  signal?: AbortSignal;
}>;

type ProposalMetadata = Readonly<{
  requestId: string;
  botId: string;
  taskId?: string;
  stateVersion: number;
  taskVersion: number;
  provider: string;
  model: string;
  reason: string;
  confidence: number;
}>;

export type CoordinatorPlanProposal =
  | (ProposalMetadata & Readonly<{ action: "wait" }>)
  | (ProposalMetadata &
      Readonly<{
        action: "execute_skill";
        skillId: string;
        skillVersion: string;
        selectedVariantId: string;
        arguments: Readonly<Record<string, JSONValue>>;
      }>);

export type CoordinatorPlanHandle = Readonly<{
  requestId: string;
  promise: Promise<CoordinatorPlanProposal>;
  cancel(reason?: string): boolean;
}>;

export type CoordinatorAIPlannerOptions = Readonly<{
  registry: BotRegistry;
  scheduler: AIRequestScheduler;
  systemPrompt?: string;
  minecraftRules?: string;
  preferredProvider?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  now?: () => Date;
  randomId?: () => string;
}>;

const DEFAULT_SYSTEM_PROMPT = [
  "You are the high-level planner for a controlled Minecraft Bot.",
  "Return exactly one structured decision. Never invent a skill or claim execution.",
  "The Coordinator will validate the proposal; the Bot Runtime and L0 safety layer retain execution authority.",
].join(" ");

const DEFAULT_MINECRAFT_RULES = [
  "Prefer survival and explicit task progress over exploration.",
  "Use only skills marked available in the supplied catalog.",
  "Choose wait when state, compatibility, or task information is insufficient.",
].join("\n");

export class CoordinatorAIPlanner {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly taskVersions = new Map<string, number>();
  private readonly stateVersions = new Map<string, number>();
  private readonly active = new Map<string, Set<AIScheduledHandle<AISkillDecision>>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly options: CoordinatorAIPlannerOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.unsubscribe = options.registry.subscribe((record) => this.onRegistryChange(record));
  }

  requestPlan(input: CoordinatorPlanRequest): CoordinatorPlanHandle {
    validateRequest(input);
    const record = this.requirePlanningRecord(input.botId);
    const status = record.currentStatus!;
    const catalog = record.skillCatalog!;
    const previousTaskVersion = this.taskVersions.get(input.botId) ?? 0;
    if (input.taskVersion < previousTaskVersion) {
      throw new CoordinatorAIPlanningError(
        "TASK_VERSION_STALE",
        "Coordinator rejected an obsolete task version before AI planning.",
      );
    }
    this.taskVersions.set(input.botId, input.taskVersion);
    this.stateVersions.set(input.botId, status.sequence);
    this.options.scheduler.invalidateBot(
      input.botId,
      status.sequence,
      input.taskVersion,
    );

    const availableSkills = catalog.skills
      .filter(
        (skill) =>
          skill.availability === "available" && skill.selectedVariantId !== null,
      )
      .sort((left, right) =>
        left.skillId.localeCompare(right.skillId) ||
        left.skillVersion.localeCompare(right.skillVersion),
      );
    const context = compactBotContextSchema.parse({
      botId: input.botId,
      currentTask: status.currentTask?.title ?? input.task,
      health: status.health.current,
      food: status.food.level,
      position: {
        x: status.position.x,
        y: status.position.y,
        z: status.position.z,
      },
      dimension: status.position.dimension,
      importantInventory: [],
      equipment: [],
      nearbyThreats: [],
      nearbyEntities: [],
      relevantMemory: [...(input.relevantMemory ?? [])],
      relevantSkills: availableSkills.map(({ skillId }) => skillId),
      recentFailures: [...(input.recentFailures ?? [])],
      teamState: [...(input.teamState ?? [])],
    });
    const prompt = buildPrefixCachePrompt({
      systemPrompt: this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      minecraftRules: this.options.minecraftRules ?? DEFAULT_MINECRAFT_RULES,
      skillCatalog: JSON.stringify(
        availableSkills.map(({ skillId, skillVersion, selectedVariantId }) => ({
          skillId,
          skillVersion,
          selectedVariantId,
        })),
      ),
      outputSchema: JSON.stringify(aiSkillDecisionJsonSchema),
      context,
      task: input.task,
    });
    const requestId = this.randomId();
    const scheduled = this.options.scheduler.submit<AISkillDecision>(
      {
        requestId,
        traceId: input.traceId ?? `ai-plan-${requestId}`,
        botId: input.botId,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        taskType: input.taskType ?? "planner",
        priority: input.priority ?? AI_PRIORITIES.NORMAL_PLANNING,
        timestamp: this.now().toISOString(),
        stateVersion: status.sequence,
        taskVersion: input.taskVersion,
        prompt: prompt.prompt,
        systemPrompt: prompt.systemPrompt,
        maxTokens: this.options.maxTokens ?? 512,
        temperature: this.options.temperature ?? 0.2,
        timeoutMs: this.options.timeoutMs ?? 30_000,
        ...(this.options.preferredProvider === undefined
          ? {}
          : { preferredProvider: this.options.preferredProvider }),
        output: {
          name: "minecraft_skill_decision",
          schema: aiSkillDecisionSchema,
          jsonSchema: aiSkillDecisionJsonSchema,
        },
      },
      input.signal === undefined ? {} : { signal: input.signal },
    );
    this.track(input.botId, scheduled);
    const promise = scheduled.promise.then((result) => {
      const decision = result.validated;
      if (decision === undefined) {
        throw new CoordinatorAIPlanningError(
          "AI_DECISION_MISSING",
          "AI response passed the scheduler without a validated decision.",
        );
      }
      const freshRecord = this.requirePlanningRecord(input.botId);
      if (
        freshRecord.runtimeInstanceId !== record.runtimeInstanceId ||
        freshRecord.currentStatus?.sequence !== status.sequence ||
        this.taskVersions.get(input.botId) !== input.taskVersion
      ) {
        throw new AIError(
          "AI_STALE_RESPONSE",
          "Coordinator discarded an AI proposal after Bot state or task changed.",
        );
      }
      const metadata = {
        requestId,
        botId: input.botId,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        stateVersion: status.sequence,
        taskVersion: input.taskVersion,
        provider: result.provider,
        model: result.model,
        reason: decision.reason,
        confidence: decision.confidence,
      };
      if (decision.action === "wait") {
        return Object.freeze({ ...metadata, action: "wait" as const });
      }
      const selected = freshRecord.skillCatalog!.skills.find(
        (skill) =>
          skill.skillId === decision.skill &&
          skill.availability === "available" &&
          skill.selectedVariantId !== null,
      );
      if (selected?.selectedVariantId == null) {
        throw new CoordinatorAIPlanningError(
          "SKILL_NOT_AVAILABLE",
          "Coordinator rejected an AI proposal outside the current compatible skill catalog.",
        );
      }
      return Object.freeze({
        ...metadata,
        action: "execute_skill" as const,
        skillId: selected.skillId,
        skillVersion: selected.skillVersion,
        selectedVariantId: selected.selectedVariantId,
        arguments: decision.arguments,
      });
    }).finally(() => this.untrack(input.botId, scheduled));
    return Object.freeze({
      requestId,
      promise,
      cancel: scheduled.cancel,
    });
  }

  close(): void {
    this.unsubscribe();
    for (const handles of this.active.values()) {
      for (const handle of handles) handle.cancel("coordinator_ai_planner_closed");
    }
    this.active.clear();
  }

  private requirePlanningRecord(botId: string): BotRegistryRecord {
    const record = this.options.registry.get(botId, this.now());
    if (record === null) {
      throw new CoordinatorAIPlanningError("BOT_NOT_FOUND", "Bot is not registered.");
    }
    if (record.connectionState !== "online") {
      throw new CoordinatorAIPlanningError(
        "BOT_NOT_ONLINE",
        "Bot must be online before AI planning.",
      );
    }
    if (record.currentStatus === null) {
      throw new CoordinatorAIPlanningError(
        "BOT_STATUS_UNAVAILABLE",
        "Bot has not published a usable status snapshot.",
      );
    }
    if (record.skillCatalog === null) {
      throw new CoordinatorAIPlanningError(
        "SKILL_CATALOG_UNAVAILABLE",
        "Bot has not published a version-bound skill catalog.",
      );
    }
    return record;
  }

  private onRegistryChange(record: BotRegistryRecord): void {
    if (record.connectionState !== "online" || record.currentStatus === null) {
      for (const handle of this.active.get(record.botId) ?? []) {
        handle.cancel("bot_not_online");
      }
      return;
    }
    const stateVersion = record.currentStatus.sequence;
    const previous = this.stateVersions.get(record.botId);
    this.stateVersions.set(record.botId, stateVersion);
    if (previous !== undefined && stateVersion > previous) {
      this.options.scheduler.invalidateBot(
        record.botId,
        stateVersion,
        this.taskVersions.get(record.botId) ?? 0,
      );
    }
  }

  private track(botId: string, handle: AIScheduledHandle<AISkillDecision>): void {
    const handles = this.active.get(botId) ?? new Set();
    handles.add(handle);
    this.active.set(botId, handles);
  }

  private untrack(botId: string, handle: AIScheduledHandle<AISkillDecision>): void {
    const handles = this.active.get(botId);
    handles?.delete(handle);
    if (handles?.size === 0) this.active.delete(botId);
  }
}

function validateRequest(input: CoordinatorPlanRequest): void {
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(input.botId)) {
    throw new TypeError("botId must be a bounded identifier.");
  }
  if (input.task.trim().length < 1 || input.task.length > 10_000) {
    throw new TypeError("task must contain between 1 and 10000 characters.");
  }
  if (!Number.isSafeInteger(input.taskVersion) || input.taskVersion < 0) {
    throw new TypeError("taskVersion must be a nonnegative safe integer.");
  }
  if (input.priority !== undefined &&
      (!Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 1_000)) {
    throw new TypeError("priority must be an integer between 0 and 1000.");
  }
}
