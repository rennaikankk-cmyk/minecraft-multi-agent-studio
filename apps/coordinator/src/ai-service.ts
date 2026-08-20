import {
  AIRouter,
  AIRequestScheduler,
  OpenAICompatibleProvider,
  type AIProvider,
  type AIProviderHealth,
  type AISchedulerSnapshot,
} from "@minecraft-studio/ai-router";

import { CoordinatorAIPlanner, type CoordinatorPlanHandle, type CoordinatorPlanRequest } from "./ai-planner.js";
import {
  loadCoordinatorAIServiceConfig,
  type CoordinatorAIServiceConfig,
} from "./ai-service-config.js";
import type { BotRegistry } from "./bot-registry.js";

export type CoordinatorAIServiceOptions = Readonly<{
  registry: BotRegistry;
  provider: AIProvider;
  config: Extract<CoordinatorAIServiceConfig, { enabled: true }>;
}>;

export class CoordinatorAIService {
  private readonly router = new AIRouter();
  private readonly scheduler: AIRequestScheduler;
  private readonly planner: CoordinatorAIPlanner;

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
    });
  }

  requestPlan(input: CoordinatorPlanRequest): CoordinatorPlanHandle {
    return this.planner.requestPlan(input);
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
}

export function createCoordinatorAIServiceFromEnv(
  registry: BotRegistry,
  env: NodeJS.ProcessEnv = process.env,
): CoordinatorAIService | null {
  const config = loadCoordinatorAIServiceConfig(env);
  if (!config.enabled) return null;
  return new CoordinatorAIService({
    registry,
    config,
    provider: new OpenAICompatibleProvider({
      name: config.providerName,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
    }),
  });
}
