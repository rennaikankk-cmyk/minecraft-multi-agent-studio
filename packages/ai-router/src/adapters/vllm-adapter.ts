import type { AIAdapter, GenerateOptions, GenerateResult, HealthResult } from '../types/adapter.js';
import { AIError, asAIError } from '../errors.js';
import type { AIErrorCode } from '../errors.js';
import { z } from 'zod';

function sanitizeVllmJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeVllmJsonSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'propertyNames')
      .map(([key, entry]) => [key, sanitizeVllmJsonSchema(entry)]),
  );
}

const chatCompletionResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string() }).loose(),
            finish_reason: z.string().nullable().optional(),
          })
          .loose(),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
      })
      .loose(),
  })
  .loose();

const modelListResponseSchema = z
  .object({
    data: z.array(z.object({ id: z.string().min(1) }).loose()).min(1),
  })
  .loose();

/**
 * HTTP classification table shared with the cloud adapter: 401/403 are permanent
 * credential failures, 429 and 5xx are transient, and every other 4xx is a
 * request defect that must not be retried.
 */
function classifyHttpStatus(status: number): Readonly<{ code: AIErrorCode; retryable: boolean }> {
  if (status === 401 || status === 403) return { code: 'AI_AUTH_FAILED', retryable: false };
  if (status === 429) return { code: 'AI_RATE_LIMITED', retryable: true };
  if (status >= 500) return { code: 'AI_PROVIDER_UNAVAILABLE', retryable: true };
  return { code: 'AI_CONFIG_INVALID', retryable: false };
}

export class VLLMAdapter implements AIAdapter {
  readonly name = 'vllm';
  readonly type = 'local' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string | null,
  ) {}

  private requestHeaders(contentType?: string): Record<string, string> {
    return {
      Accept: 'application/json',
      ...(contentType ? { 'Content-Type': contentType } : {}),
      ...(this.apiKey?.trim()
        ? { Authorization: `Bearer ${this.apiKey.trim()}` }
        : {}),
    };
  }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: this.requestHeaders(),
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        return { available: true, latencyMs: Date.now() - start };
      }
      // Ollama and some other OpenAI-compatible hubs do not expose /health,
      // but do expose the standard model discovery endpoint. Only fall back
      // for an absent endpoint; preserve real upstream failures as unavailable.
      if (response.status !== 404 && response.status !== 405) {
        return {
          available: false,
          latencyMs: Date.now() - start,
          error: `HTTP ${response.status}`,
        };
      }
      const modelsResponse = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.requestHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!modelsResponse.ok) {
        return {
          available: false,
          latencyMs: Date.now() - start,
          error: `HTTP ${modelsResponse.status}`,
        };
      }
      const models = modelListResponseSchema.parse(await modelsResponse.json());
      const modelAvailable = models.data.some(({ id }) => id === this.model);
      return {
        available: modelAvailable,
        latencyMs: Date.now() - start,
        ...(modelAvailable ? {} : { error: `Model ${this.model} is not advertised.` }),
      };
    } catch (error) {
      return {
        available: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private failure(code: AIErrorCode, retryable: boolean): AIError {
    return new AIError(code, `vLLM request failed (${code}).`, {
      provider: this.name,
      retryable,
    });
  }

  private httpError(status: number): AIError {
    const { code, retryable } = classifyHttpStatus(status);
    // The upstream status text and body are deliberately not echoed: they can
    // carry gateway or credential material, while the stable code carries the
    // meaning every consumer classifies on.
    return new AIError(code, `vLLM provider returned HTTP ${status}.`, {
      provider: this.name,
      retryable,
      statusCode: status,
    });
  }

  private async readCompletion(
    response: Response,
  ): Promise<z.infer<typeof chatCompletionResponseSchema>> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw this.failure('AI_OUTPUT_INVALID', false);
    }
    const parsed = chatCompletionResponseSchema.safeParse(payload);
    if (!parsed.success) throw this.failure('AI_OUTPUT_INVALID', false);
    return parsed.data;
  }

  /**
   * A schema that `z.toJSONSchema` cannot express is a request defect that fails
   * identically on every attempt, so it is classified as a non-retryable
   * configuration error instead of reaching the retryable transport default.
   */
  private structuredResponseFormat(
    schema: NonNullable<GenerateOptions['schema']>,
  ): Record<string, unknown> {
    let jsonSchema: unknown;
    try {
      jsonSchema = sanitizeVllmJsonSchema(z.toJSONSchema(schema));
    } catch {
      throw this.failure('AI_CONFIG_INVALID', false);
    }
    return {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'structured_response',
          strict: true,
          schema: jsonSchema,
        },
      },
    };
  }

  /**
   * Single normalisation point for every failure on this path. Caller
   * cancellation and our own timeout win over whatever the transport surfaced,
   * an already-classified `AIError` is passed through unchanged, and only a
   * genuinely unknown throw becomes a retryable transport failure.
   */
  private normalizeError(request: GenerateOptions, error: unknown, timedOut: boolean): AIError {
    if (request.signal?.aborted) return this.failure('AI_CANCELLED', false);
    if (timedOut) return this.failure('AI_PROVIDER_TIMEOUT', true);
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
        controller.abort(this.failure('AI_PROVIDER_TIMEOUT', true));
      },
      request.timeoutMs,
    );
    const abortFromCaller = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abortFromCaller();
    else request.signal?.addEventListener('abort', abortFromCaller, { once: true });

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.requestHeaders('application/json'),
        body: JSON.stringify({
          model: this.model,
          messages: [
            ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
            { role: 'user', content: request.prompt }
          ],
          // Ornith is a Qwen reasoning model. Planner decisions belong in the
          // structured content channel; leaving thinking enabled can consume
          // the whole bounded response with reasoning and return content=null.
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          ...(request.schema ? this.structuredResponseFormat(request.schema) : {}),
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw this.httpError(response.status);
      }

      const data = await this.readCompletion(response);
      const choice = data.choices[0];
      if (!choice) throw this.failure('AI_OUTPUT_INVALID', false);
      return {
        content: choice.message.content,
        ...(choice.finish_reason !== undefined ? { finishReason: choice.finish_reason } : {}),
        usage: {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens
        }
      };
    } catch (error) {
      throw this.normalizeError(request, error, timedOut);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}
