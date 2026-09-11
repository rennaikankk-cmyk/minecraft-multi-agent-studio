import { z } from "zod";

import { AIError, asAIError } from "../errors.js";
import type { AIErrorCode } from "../errors.js";
import type {
  AIAdapter,
  GenerateOptions,
  GenerateResult,
  HealthResult,
} from "../types/adapter.js";

const ollamaModelsResponseSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            name: z.string().min(1),
            model: z.string().min(1).optional(),
          })
          .loose(),
      )
      .min(1),
  })
  .loose();

const ollamaChatResponseSchema = z
  .object({
    message: z.object({ content: z.string().min(1) }).loose(),
    prompt_eval_count: z.number().int().nonnegative(),
    eval_count: z.number().int().nonnegative(),
  })
  .loose();

/**
 * HTTP classification table shared with the cloud adapter: 401/403 are permanent
 * credential failures, 429 and 5xx are transient, and every other 4xx is a
 * request defect that must not be retried.
 */
function classifyHttpStatus(status: number): Readonly<{ code: AIErrorCode; retryable: boolean }> {
  if (status === 401 || status === 403) return { code: "AI_AUTH_FAILED", retryable: false };
  if (status === 429) return { code: "AI_RATE_LIMITED", retryable: true };
  if (status >= 500) return { code: "AI_PROVIDER_UNAVAILABLE", retryable: true };
  return { code: "AI_CONFIG_INVALID", retryable: false };
}

/**
 * Ollama's native API exposes `think: false`, which prevents reasoning-model
 * tokens from consuming the bounded planning budget before the JSON decision.
 */
export class OllamaAdapter implements AIAdapter {
  readonly name = "ollama";
  readonly type = "local" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return {
          available: false,
          latencyMs: Date.now() - start,
          error: `HTTP ${response.status}`,
        };
      }
      const models = ollamaModelsResponseSchema.parse(await response.json());
      const modelAvailable = models.models.some(
        ({ name, model }) => name === this.model || model === this.model,
      );
      return {
        available: modelAvailable,
        latencyMs: Date.now() - start,
        ...(modelAvailable ? {} : { error: `Model ${this.model} is not advertised.` }),
      };
    } catch (error) {
      return {
        available: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private failure(code: AIErrorCode, retryable: boolean): AIError {
    return new AIError(code, `Ollama request failed (${code}).`, {
      provider: this.name,
      retryable,
    });
  }

  private httpError(status: number): AIError {
    const { code, retryable } = classifyHttpStatus(status);
    // The upstream status text and body are deliberately not echoed: they can
    // carry gateway or credential material, while the stable code carries the
    // meaning every consumer classifies on.
    return new AIError(code, `Ollama provider returned HTTP ${status}.`, {
      provider: this.name,
      retryable,
      statusCode: status,
    });
  }

  private async readCompletion(
    response: Response,
  ): Promise<z.infer<typeof ollamaChatResponseSchema>> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw this.failure("AI_OUTPUT_INVALID", false);
    }
    const parsed = ollamaChatResponseSchema.safeParse(payload);
    if (!parsed.success) throw this.failure("AI_OUTPUT_INVALID", false);
    return parsed.data;
  }

  /**
   * A schema that `z.toJSONSchema` cannot express is a request defect that fails
   * identically on every attempt, so it is classified as a non-retryable
   * configuration error instead of reaching the retryable transport default.
   */
  private outputFormat(
    schema: NonNullable<GenerateOptions["schema"]>,
  ): Record<string, unknown> {
    try {
      return { format: z.toJSONSchema(schema) };
    } catch {
      throw this.failure("AI_CONFIG_INVALID", false);
    }
  }

  /**
   * Single normalisation point for every failure on this path. Caller
   * cancellation and our own timeout win over whatever the transport surfaced,
   * an already-classified `AIError` is passed through unchanged, and only a
   * genuinely unknown throw becomes a retryable transport failure.
   */
  private normalizeError(request: GenerateOptions, error: unknown, timedOut: boolean): AIError {
    if (request.signal?.aborted) return this.failure("AI_CANCELLED", false);
    if (timedOut) return this.failure("AI_PROVIDER_TIMEOUT", true);
    return asAIError(error, this.name);
  }

  async generate(request: GenerateOptions): Promise<GenerateResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        // Aborting with a classified error keeps the timeout retryable even when
        // the transport rethrows the abort reason verbatim; the previous plain
        // `Error` reason surfaced as an unclassifiable failure.
        controller.abort(this.failure("AI_PROVIDER_TIMEOUT", true));
      },
      request.timeoutMs,
    );
    const abortFromCaller = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abortFromCaller();
    else request.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          messages: [
            ...(request.systemPrompt
              ? [{ role: "system", content: request.systemPrompt }]
              : []),
            { role: "user", content: request.prompt },
          ],
          options: {
            temperature: request.temperature,
            num_predict: request.maxTokens,
          },
          ...(request.schema ? this.outputFormat(request.schema) : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw this.httpError(response.status);
      }

      const data = await this.readCompletion(response);
      return {
        content: data.message.content,
        usage: {
          promptTokens: data.prompt_eval_count,
          completionTokens: data.eval_count,
        },
      };
    } catch (error) {
      throw this.normalizeError(request, error, timedOut);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
