import type { AIAdapter, GenerateOptions, GenerateResult, HealthResult } from '../types/adapter.js';
import { z } from 'zod';

const chatCompletionResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string() }).loose(),
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

export class VLLMAdapter implements AIAdapter {
  readonly name = 'vllm';
  readonly type = 'local' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string
  ) {}

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      return {
        available: response.ok,
        latencyMs: Date.now() - start,
        ...(response.ok ? {} : { error: `HTTP ${response.status}` })
      };
    } catch (error) {
      return {
        available: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async generate(request: GenerateOptions): Promise<GenerateResult> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`vLLM request exceeded ${request.timeoutMs}ms.`)),
      request.timeoutMs,
    );
    const abortFromCaller = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abortFromCaller();
    else request.signal?.addEventListener('abort', abortFromCaller, { once: true });

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
            { role: 'user', content: request.prompt }
          ],
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          ...(request.schema
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: 'structured_response',
                    strict: true,
                    schema: z.toJSONSchema(request.schema),
                  },
                },
              }
            : {}),
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`vLLM error: ${response.status} ${response.statusText}`);
      }

      const data = chatCompletionResponseSchema.parse(await response.json());
      const choice = data.choices[0];
      if (!choice) throw new Error('vLLM response did not contain a completion choice.');
      return {
        content: choice.message.content,
        usage: {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens
        }
      };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}
