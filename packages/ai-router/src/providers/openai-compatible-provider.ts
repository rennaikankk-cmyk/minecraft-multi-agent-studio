import { z } from "zod";

import { AIError, asAIError } from "../errors.js";
import type { AIRequest } from "../request.js";
import type {
  AIProvider,
  AIProviderHealth,
  AIProviderKind,
  AIProviderResponse,
} from "../types/provider.js";

const chatResponseSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z.object({
          message: z.object({ content: z.string() }).passthrough(),
          finish_reason: z.string().nullish(),
        }).passthrough(),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type OpenAICompatibleProviderConfig = Readonly<{
  name: string;
  baseUrl: string;
  model: string;
  kind?: Exclude<AIProviderKind, "mock">;
  apiKey?: string;
  healthPath?: string;
  healthTimeoutMs?: number;
  extraHeaders?: Readonly<Record<string, string>>;
}>;

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function combineWithTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): Readonly<{ signal: AbortSignal; cleanup(): void }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) onAbort();
  const timeout = setTimeout(
    () => controller.abort(new AIError("AI_REQUEST_TIMEOUT", "AI health check timed out.")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  readonly kind: Exclude<AIProviderKind, "mock">;
  protected readonly model: string;
  private readonly apiBaseUrl: string;
  private readonly rootBaseUrl: string;
  private readonly apiKey?: string;
  private readonly healthPath?: string;
  private readonly healthTimeoutMs: number;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  constructor(config: OpenAICompatibleProviderConfig) {
    this.name = config.name;
    this.kind = config.kind ?? "local";
    this.model = config.model;
    const baseUrl = withoutTrailingSlash(config.baseUrl);
    this.apiBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    this.rootBaseUrl = baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
    if (config.apiKey !== undefined) this.apiKey = config.apiKey;
    if (config.healthPath !== undefined) this.healthPath = config.healthPath;
    this.healthTimeoutMs = config.healthTimeoutMs ?? 5_000;
    this.extraHeaders = config.extraHeaders ?? {};
  }

  async health(signal?: AbortSignal): Promise<AIProviderHealth> {
    const startedAt = Date.now();
    const combined = combineWithTimeout(signal, this.healthTimeoutMs);
    try {
      const configuredHealthUrl = this.healthPath === undefined
        ? `${this.rootBaseUrl}/health`
        : new URL(this.healthPath, `${this.rootBaseUrl}/`).toString();
      const healthResponse = await fetch(configuredHealthUrl, {
        headers: this.headers(),
        signal: combined.signal,
      });
      if (healthResponse.ok) {
        return {
          available: true,
          latencyMs: Date.now() - startedAt,
          model: this.model,
        };
      }
      const modelsResponse = await fetch(`${this.apiBaseUrl}/models`, {
        headers: this.headers(),
        signal: combined.signal,
      });
      return {
        available: modelsResponse.ok,
        latencyMs: Date.now() - startedAt,
        model: this.model,
        ...(modelsResponse.ok ? {} : { errorCode: `HTTP_${modelsResponse.status}` }),
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new AIError("AI_CANCELLED", "AI health check was cancelled.", {
          provider: this.name,
          cause: error,
        });
      }
      return {
        available: false,
        latencyMs: Date.now() - startedAt,
        model: this.model,
        errorCode: "AI_HEALTH_FAILED",
      };
    } finally {
      combined.cleanup();
    }
  }

  async generate(
    request: AIRequest,
    signal: AbortSignal,
  ): Promise<AIProviderResponse> {
    const responseFormat = request.output === undefined
      ? undefined
      : request.output.jsonSchema === undefined
        ? { type: "json_object" }
        : {
            type: "json_schema",
            json_schema: {
              name: request.output.name,
              strict: true,
              schema: request.output.jsonSchema,
            },
          };
    try {
      const response = await fetch(`${this.apiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers(),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            ...(request.systemPrompt === undefined
              ? []
              : [{ role: "system", content: request.systemPrompt }]),
            { role: "user", content: request.prompt },
          ],
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
        }),
        signal,
      });
      if (!response.ok) {
        throw new AIError(
          "AI_PROVIDER_FAILED",
          `OpenAI-compatible provider returned HTTP ${response.status}.`,
          {
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
            provider: this.name,
          },
        );
      }
      const parsed = chatResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new AIError(
          "AI_PROVIDER_FAILED",
          "OpenAI-compatible provider returned an invalid response envelope.",
          { retryable: true, provider: this.name },
        );
      }
      const choice = parsed.data.choices[0]!;
      return {
        content: choice.message.content,
        model: parsed.data.model ?? this.model,
        usage: {
          promptTokens: parsed.data.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.data.usage?.completion_tokens ?? 0,
        },
        ...(choice.finish_reason == null
          ? {}
          : { finishReason: choice.finish_reason }),
      };
    } catch (error) {
      if (signal.aborted) {
        throw new AIError("AI_CANCELLED", "AI provider request was cancelled.", {
          provider: this.name,
          cause: error,
        });
      }
      throw asAIError(error, this.name);
    }
  }

  private headers(): Record<string, string> {
    return {
      ...this.extraHeaders,
      ...(this.apiKey === undefined ? {} : { Authorization: `Bearer ${this.apiKey}` }),
    };
  }
}
