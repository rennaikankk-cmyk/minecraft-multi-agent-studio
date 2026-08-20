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
import type { BotAiPerformanceV1 } from "@minecraft-studio/protocol";

import type { BotRegistry, BotRegistryRecord } from "./bot-registry.js";

export type CoordinatorAIPlanningErrorCode =
  | "BOT_NOT_FOUND"
  | "BOT_NOT_ONLINE"
  | "BOT_STATUS_UNAVAILABLE"
  | "SKILL_CATALOG_UNAVAILABLE"
  | "SKILL_NOT_AVAILABLE"
  | "TASK_VERSION_STALE"
  | "MEMORY_LOOKUP_FAILED"
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
  runtimeInstanceId: string;
  taskId?: string;
  stateVersion: number;
  taskVersion: number;
  provider: string;
  model: string;
  reason: string;
  confidence: number;
  taskType: AITaskType;
  queueTimeMs: number;
  totalLatencyMs: number;
  promptTokens: number;
  outputTokens: number;
  providerQueueTimeMs: number | null;
  timeToFirstTokenMs: number | null;
  generationTimeMs: number | null;
  meanInterTokenLatencyMs: number | null;
  generationTokensPerSecond: number | null;
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

export type CoordinatorRelevantMemoryRequest = Readonly<{
  botId: string;
  serverProfileId: string;
  dimension: string;
  position: Readonly<{ x: number; y: number; z: number }>;
  task: string;
  taskId?: string;
  taskVersion: number;
  signal: AbortSignal;
}>;

export type CoordinatorRelevantMemoryProvider = (
  request: CoordinatorRelevantMemoryRequest,
) => Promise<readonly string[]>;

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
  onObservation?: (observation: BotAiPerformanceV1) => void;
  relevantMemoryProvider?: CoordinatorRelevantMemoryProvider;
}>;

type ActivePlanningHandle = Readonly<{
  cancel(reason?: string): boolean;
}>;

type PlanningStatus = NonNullable<BotRegistryRecord["currentStatus"]>;
type PlanningCatalog = NonNullable<BotRegistryRecord["skillCatalog"]>;

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
  private readonly active = new Map<string, Set<ActivePlanningHandle>>();
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
    for (const handle of this.active.get(input.botId) ?? []) {
      handle.cancel("newer_plan_request");
    }
    this.taskVersions.set(input.botId, input.taskVersion);
    this.stateVersions.set(input.botId, status.sequence);
    this.options.scheduler.invalidateBot(
      input.botId,
      status.sequence,
      input.taskVersion,
    );

    const requestId = this.randomId();
    const taskType = input.taskType ?? "planner";
    const controller = new AbortController();
    let scheduled: AIScheduledHandle<AISkillDecision> | null = null;
    const cancel = (reason = "coordinator_ai_plan_cancelled") => {
      const wasPending = !controller.signal.aborted;
      const scheduledCancelled = scheduled?.cancel(reason) ?? false;
      if (wasPending) controller.abort(reason);
      return wasPending || scheduledCancelled;
    };
    const activeHandle = Object.freeze({ cancel });
    this.track(input.botId, activeHandle);
    const onExternalAbort = () => cancel("external_abort");
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (input.signal?.aborted) onExternalAbort();

    const promise = this.executePlan({
      input,
      record,
      status,
      catalog,
      requestId,
      taskType,
      controller,
      onScheduled: (handle) => {
        scheduled = handle;
      },
    }).then(
      (proposal) => {
        this.notifyObservation(observationFromProposal(proposal, this.now()));
        return proposal;
      },
      (error: unknown) => {
        this.notifyObservation({
          state: "failed",
          observedAt: this.now().toISOString(),
          botId: input.botId,
          requestId,
          taskId: input.taskId ?? null,
          taskType,
          provider: this.options.preferredProvider ?? null,
          model: null,
          queueTimeMs: null,
          providerQueueTimeMs: null,
          totalLatencyMs: null,
          timeToFirstTokenMs: null,
          generationTimeMs: null,
          meanInterTokenLatencyMs: null,
          generationTokensPerSecond: null,
          promptTokens: null,
          outputTokens: null,
          errorCode: planningErrorCode(error),
        });
        throw error;
      },
    ).finally(() => {
      input.signal?.removeEventListener("abort", onExternalAbort);
      this.untrack(input.botId, activeHandle);
    });
    return Object.freeze({ requestId, promise, cancel });
  }

  private async executePlan(options: Readonly<{
    input: CoordinatorPlanRequest;
    record: BotRegistryRecord;
    status: PlanningStatus;
    catalog: PlanningCatalog;
    requestId: string;
    taskType: AITaskType;
    controller: AbortController;
    onScheduled(handle: AIScheduledHandle<AISkillDecision>): void;
  }>): Promise<CoordinatorPlanProposal> {
    const {
      input,
      record,
      status,
      catalog,
      requestId,
      taskType,
      controller,
      onScheduled,
    } = options;
    const relevantMemory = await this.loadRelevantMemory(
      input,
      record,
      status,
      controller.signal,
    );
    if (controller.signal.aborted) {
      throw new AIError("AI_CANCELLED", "AI planning was cancelled before enqueue.");
    }
    const preflightRecord = this.requirePlanningRecord(input.botId);
    if (
      preflightRecord.runtimeInstanceId !== record.runtimeInstanceId ||
      preflightRecord.currentStatus?.sequence !== status.sequence ||
      this.taskVersions.get(input.botId) !== input.taskVersion
    ) {
      throw new AIError(
        "AI_STALE_RESPONSE",
        "Coordinator discarded memory after Bot state or task changed.",
      );
    }

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
      relevantMemory: [...relevantMemory],
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
    const scheduled = this.options.scheduler.submit<AISkillDecision>(
      {
        requestId,
        traceId: input.traceId ?? `ai-plan-${requestId}`,
        botId: input.botId,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        taskType,
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
      { signal: controller.signal },
    );
    onScheduled(scheduled);
    this.notifyObservation({
      state: "queued",
      observedAt: this.now().toISOString(),
      botId: input.botId,
      requestId,
      taskId: input.taskId ?? null,
      taskType,
      provider: this.options.preferredProvider ?? null,
      model: null,
      queueTimeMs: null,
      providerQueueTimeMs: null,
      totalLatencyMs: null,
      timeToFirstTokenMs: null,
      generationTimeMs: null,
      meanInterTokenLatencyMs: null,
      generationTokensPerSecond: null,
      promptTokens: null,
      outputTokens: null,
      errorCode: null,
    });
    const result = await scheduled.promise;
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
      runtimeInstanceId: record.runtimeInstanceId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      stateVersion: status.sequence,
      taskVersion: input.taskVersion,
      provider: result.provider,
      model: result.model,
      reason: decision.reason,
      confidence: decision.confidence,
      taskType: result.taskType,
      queueTimeMs: result.queueTimeMs,
      totalLatencyMs: result.totalLatencyMs,
      promptTokens: result.usage.promptTokens,
      outputTokens: result.usage.completionTokens,
      providerQueueTimeMs: result.metrics?.queueTimeMs ?? null,
      timeToFirstTokenMs: result.metrics?.timeToFirstTokenMs ?? null,
      generationTimeMs: result.metrics?.generationTimeMs ?? null,
      meanInterTokenLatencyMs: result.metrics?.meanInterTokenLatencyMs ?? null,
      generationTokensPerSecond: result.metrics?.tokensPerSecond ?? null,
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
  }

  private async loadRelevantMemory(
    input: CoordinatorPlanRequest,
    record: BotRegistryRecord,
    status: PlanningStatus,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    if (input.relevantMemory !== undefined) {
      return [...input.relevantMemory];
    }
    const provider = this.options.relevantMemoryProvider;
    if (!provider) return [];
    try {
      return await provider({
        botId: input.botId,
        serverProfileId: record.serverProfileId,
        dimension: status.position.dimension,
        position: {
          x: status.position.x,
          y: status.position.y,
          z: status.position.z,
        },
        task: input.task,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        taskVersion: input.taskVersion,
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new AIError(
          "AI_CANCELLED",
          "AI planning was cancelled during memory retrieval.",
          { cause: error },
        );
      }
      throw new CoordinatorAIPlanningError(
        "MEMORY_LOOKUP_FAILED",
        "Coordinator memory retrieval failed closed before AI planning.",
      );
    }
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
      for (const handle of this.active.get(record.botId) ?? []) {
        handle.cancel("bot_state_changed");
      }
    }
  }

  private track(botId: string, handle: ActivePlanningHandle): void {
    const handles = this.active.get(botId) ?? new Set();
    handles.add(handle);
    this.active.set(botId, handles);
  }

  private untrack(botId: string, handle: ActivePlanningHandle): void {
    const handles = this.active.get(botId);
    handles?.delete(handle);
    if (handles?.size === 0) this.active.delete(botId);
  }

  private notifyObservation(observation: BotAiPerformanceV1): void {
    try {
      this.options.onObservation?.(Object.freeze(observation));
    } catch {
      // Telemetry must never change the planning result or execution authority.
    }
  }
}

function observationFromProposal(
  proposal: CoordinatorPlanProposal,
  observedAt: Date,
): BotAiPerformanceV1 {
  return {
    state: proposal.action === "wait" ? "waiting" : "completed",
    observedAt: observedAt.toISOString(),
    botId: proposal.botId,
    requestId: proposal.requestId,
    taskId: proposal.taskId ?? null,
    taskType: proposal.taskType,
    provider: proposal.provider,
    model: proposal.model,
    queueTimeMs: proposal.queueTimeMs,
    providerQueueTimeMs: proposal.providerQueueTimeMs,
    totalLatencyMs: proposal.totalLatencyMs,
    timeToFirstTokenMs: proposal.timeToFirstTokenMs,
    generationTimeMs: proposal.generationTimeMs,
    meanInterTokenLatencyMs: proposal.meanInterTokenLatencyMs,
    generationTokensPerSecond: proposal.generationTokensPerSecond,
    promptTokens: proposal.promptTokens,
    outputTokens: proposal.outputTokens,
    errorCode: null,
  };
}

function planningErrorCode(error: unknown): string {
  if (error instanceof CoordinatorAIPlanningError || error instanceof AIError) {
    return error.code;
  }
  return "AI_PLANNING_FAILED";
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
