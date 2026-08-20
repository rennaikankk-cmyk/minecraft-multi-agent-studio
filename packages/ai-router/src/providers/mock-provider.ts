import { AIError } from "../errors.js";
import type { AIRequest } from "../request.js";
import type {
  AIProvider,
  AIProviderHealth,
  AIProviderResponse,
} from "../types/provider.js";

export type MockAIResponder = (
  request: AIRequest,
  signal: AbortSignal,
) => Promise<AIProviderResponse> | AIProviderResponse;

export class MockAIProvider implements AIProvider {
  readonly kind = "mock" as const;

  constructor(
    readonly name: string,
    private readonly responder: MockAIResponder,
    private available = true,
  ) {}

  setAvailable(available: boolean): void {
    this.available = available;
  }

  async health(): Promise<AIProviderHealth> {
    return { available: this.available, latencyMs: 0, model: "mock" };
  }

  async generate(
    request: AIRequest,
    signal: AbortSignal,
  ): Promise<AIProviderResponse> {
    if (!this.available) {
      throw new AIError("AI_PROVIDER_UNAVAILABLE", "Mock provider is unavailable.", {
        retryable: true,
        provider: this.name,
      });
    }
    if (signal.aborted) {
      throw new AIError("AI_CANCELLED", "Mock provider request was cancelled.");
    }
    return this.responder(request, signal);
  }
}
