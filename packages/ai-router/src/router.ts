import { AIError, asAIError } from "./errors.js";
import type { AIRequest } from "./request.js";
import { parseStructuredOutput } from "./structured-output.js";
import type {
  AIProvider,
  AIProviderHealth,
  AIRouterResponse,
} from "./types/provider.js";

export class AIRouter {
  private readonly providers = new Map<string, AIProvider>();

  register(provider: AIProvider): void {
    if (this.providers.has(provider.name)) {
      throw new AIError(
        "AI_CONFIG_INVALID",
        `AI provider name is already registered: ${provider.name}`,
      );
    }
    this.providers.set(provider.name, provider);
  }

  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  listProviders(): readonly string[] {
    return [...this.providers.keys()];
  }

  async route<T>(
    request: AIRequest<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<AIRouterResponse<T>> {
    if (signal.aborted) {
      throw new AIError("AI_CANCELLED", "AI request was cancelled.");
    }
    const providers = this.orderedProviders(request.preferredProvider);
    if (providers.length === 0) {
      throw new AIError("AI_NO_PROVIDER", "No AI provider is registered.");
    }

    const failures: AIError[] = [];
    for (const provider of providers) {
      if (signal.aborted) {
        throw new AIError("AI_CANCELLED", "AI request was cancelled.");
      }
      let health: AIProviderHealth;
      try {
        health = await provider.health(signal);
      } catch (error) {
        failures.push(asAIError(error, provider.name));
        continue;
      }
      if (!health.available) {
        failures.push(
          new AIError("AI_PROVIDER_UNAVAILABLE", "AI provider is unavailable.", {
            retryable: true,
            provider: provider.name,
          }),
        );
        continue;
      }
      try {
        const response = await provider.generate(request, signal);
        const validated = request.output === undefined
          ? undefined
          : parseStructuredOutput(response.content, request.output);
        return {
          provider: provider.name,
          content: response.content,
          usage: response.usage,
          model: response.model,
          ...(response.finishReason === undefined
            ? {}
            : { finishReason: response.finishReason }),
          ...(response.metrics === undefined ? {} : { metrics: response.metrics }),
          ...(validated === undefined ? {} : { validated }),
        } as AIRouterResponse<T>;
      } catch (error) {
        const failure = asAIError(error, provider.name);
        if (failure.code === "AI_CANCELLED" || !failure.retryable) throw failure;
        failures.push(failure);
      }
    }
    const lastFailure = failures.at(-1);
    throw new AIError(
      lastFailure?.code ?? "AI_NO_PROVIDER",
      "All configured AI providers failed or were unavailable.",
      {
        retryable: lastFailure?.retryable ?? true,
        ...(lastFailure?.provider === undefined
          ? {}
          : { provider: lastFailure.provider }),
        ...(lastFailure === undefined ? {} : { cause: lastFailure }),
      },
    );
  }

  async healthCheck(signal?: AbortSignal): Promise<Map<string, AIProviderHealth>> {
    const results = new Map<string, AIProviderHealth>();
    await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        try {
          results.set(provider.name, await provider.health(signal));
        } catch {
          results.set(provider.name, {
            available: false,
            latencyMs: 0,
            errorCode: "AI_PROVIDER_FAILED",
          });
        }
      }),
    );
    return results;
  }

  private orderedProviders(preferredProvider?: string): AIProvider[] {
    const providers = [...this.providers.values()];
    if (preferredProvider === undefined) return providers;
    return providers.sort((left, right) =>
      Number(right.name === preferredProvider) - Number(left.name === preferredProvider),
    );
  }
}
