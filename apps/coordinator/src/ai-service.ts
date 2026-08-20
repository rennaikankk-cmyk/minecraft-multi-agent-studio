import {
  AIRouter,
  AIRequestScheduler,
  OpenAICompatibleProvider,
  type AIProvider,
  type AIProviderHealth,
  type AISchedulerSnapshot,
} from "@minecraft-studio/ai-router";
import type { AppLogger } from "@minecraft-studio/observability";
import type {
  BotAiPerformanceV1,
  SkillExecutionResultV1,
} from "@minecraft-studio/protocol";

import {
  CoordinatorAIPlanner,
  type CoordinatorPlanHandle,
  type CoordinatorPlanProposal,
  type CoordinatorPlanRequest,
  type CoordinatorRelevantMemoryProvider,
} from "./ai-planner.js";
import {
  loadCoordinatorAIServiceConfig,
  type CoordinatorAIServiceConfig,
} from "./ai-service-config.js";
import type { BotRegistry } from "./bot-registry.js";
import {
  SkillInvocationController,
  type SkillInvocationAuditSink,
  type SkillInvocationGrant,
  type SkillInvocationTransport,
} from "./skill-invocation-controller.js";

export type CoordinatorAIExecutionOptions = Readonly<{
  instanceId: string;
  transport: SkillInvocationTransport;
  auditSink: SkillInvocationAuditSink;
  logger: AppLogger;
  teamStateProvider?: (botId: string) => readonly string[];
  relevantMemoryProvider?: CoordinatorRelevantMemoryProvider;
  onPlanningObservation?: (observation: BotAiPerformanceV1) => void;
}>;

export type CoordinatorAIServiceOptions = Readonly<{
  registry: BotRegistry;
  provider: AIProvider;
  config: Extract<CoordinatorAIServiceConfig, { enabled: true }>;
  relevantMemoryProvider?: CoordinatorRelevantMemoryProvider;
  execution?: CoordinatorAIExecutionOptions;
}>;

export type CoordinatorAIExecutionResult =
  | Extract<CoordinatorPlanProposal, { action: "wait" }>
  | SkillExecutionResultV1;

export type CoordinatorAIExecutionHandle = Readonly<{
  requestId: string;
  promise: Promise<CoordinatorAIExecutionResult>;
  cancel(reason?: string): boolean;
}>;

export class CoordinatorAIService {
  private readonly router = new AIRouter();
  private readonly scheduler: AIRequestScheduler;
  private readonly planner: CoordinatorAIPlanner;
  private readonly invocationController: SkillInvocationController | null;

  constructor(private readonly options: CoordinatorAIServiceOptions) {
    this.router.register(options.provider);
    this.scheduler = new AIRequestScheduler(this.router, options.config.scheduler);
    this.planner = new CoordinatorAIPlanner({
      registry: options.registry,
      scheduler: this.scheduler,
      preferredProvider: options.provider.name,
      maxTokens: options.config.maxTokens,
      temperature: options.config.temperature,
      timeoutMs: options.config.timeoutMs,
      ...(options.relevantMemoryProvider === undefined
        ? {}
        : { relevantMemoryProvider: options.relevantMemoryProvider }),
      ...(options.execution?.onPlanningObservation === undefined
        ? {}
        : { onObservation: options.execution.onPlanningObservation }),
    });
    this.invocationController = options.execution
      ? new SkillInvocationController({
          instanceId: options.execution.instanceId,
          registry: options.registry,
          transport: options.execution.transport,
          auditSink: options.execution.auditSink,
          logger: options.execution.logger,
        })
      : null;
  }

  requestPlan(input: CoordinatorPlanRequest): CoordinatorPlanHandle {
    return this.planner.requestPlan(this.withTeamState(input));
  }

  requestAndExecute(
    input: CoordinatorPlanRequest,
    grant: SkillInvocationGrant,
  ): CoordinatorAIExecutionHandle {
    if (!this.invocationController) {
      throw new Error("Coordinator AI skill execution is not configured.");
    }
    const planning = this.planner.requestPlan(this.withTeamState(input));
    const controller = new AbortController();
    let settled = false;
    const cancel = (reason = "coordinator_ai_execution_cancelled") => {
      const planningCancelled = planning.cancel(reason);
      const executionCancelled = !settled && !controller.signal.aborted;
      if (executionCancelled) controller.abort(reason);
      return planningCancelled || executionCancelled;
    };
    const promise: Promise<CoordinatorAIExecutionResult> = (async () => {
      const proposal = await planning.promise;
      if (proposal.action === "wait") return proposal;
      return await this.invocationController!.executeProposal(
        proposal,
        grant,
        controller.signal,
      );
    })();
    void promise.finally(() => { settled = true; }).catch(() => undefined);
    return Object.freeze({ requestId: planning.requestId, promise, cancel });
  }

  async health(): Promise<AIProviderHealth> {
    return (await this.router.healthCheck()).get(this.options.provider.name) ?? {
      available: false,
      latencyMs: 0,
      errorCode: "AI_PROVIDER_NOT_REGISTERED",
    };
  }

  schedulerSnapshot(): AISchedulerSnapshot {
    return this.scheduler.snapshot();
  }

  close(): void {
    this.planner.close();
    this.scheduler.close("coordinator_shutdown");
  }

  private withTeamState(input: CoordinatorPlanRequest): CoordinatorPlanRequest {
    if (input.teamState !== undefined || !this.options.execution?.teamStateProvider) {
      return input;
    }
    return Object.freeze({
      ...input,
      teamState: this.options.execution.teamStateProvider(input.botId),
    });
  }
}

export function createCoordinatorAIServiceFromEnv(
  registry: BotRegistry,
  execution?: CoordinatorAIExecutionOptions,
  env: NodeJS.ProcessEnv = process.env,
): CoordinatorAIService | null {
  const config = loadCoordinatorAIServiceConfig(env);
  if (!config.enabled) return null;
  return new CoordinatorAIService({
    registry,
    config,
    ...(execution?.relevantMemoryProvider === undefined
      ? {}
      : { relevantMemoryProvider: execution.relevantMemoryProvider }),
    ...(execution ? { execution } : {}),
    provider: new OpenAICompatibleProvider({
      name: config.providerName,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
    }),
  });
}
