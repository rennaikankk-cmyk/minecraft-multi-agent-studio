import type { AIRequest } from "../request.js";

export type AIProviderKind = "local" | "cloud" | "mock";

export type AIProviderHealth = Readonly<{
  available: boolean;
  latencyMs: number;
  model?: string;
  errorCode?: string;
}>;

export type AIUsage = Readonly<{
  promptTokens: number;
  completionTokens: number;
}>;

export type AIProviderResponse = Readonly<{
  content: string;
  usage: AIUsage;
  model: string;
  finishReason?: string;
}>;

export interface AIProvider {
  readonly name: string;
  readonly kind: AIProviderKind;
  health(signal?: AbortSignal): Promise<AIProviderHealth>;
  generate(request: AIRequest, signal: AbortSignal): Promise<AIProviderResponse>;
}

export type AIRouterResponse<T = unknown> = Readonly<{
  provider: string;
  content: string;
  usage: AIUsage;
  model: string;
  finishReason?: string;
  validated?: T;
}>;
