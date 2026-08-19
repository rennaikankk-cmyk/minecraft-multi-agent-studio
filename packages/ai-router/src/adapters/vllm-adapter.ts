import type { AIAdapter, GenerateOptions, GenerateResult, HealthResult } from '../types/adapter.js';

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
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

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
          temperature: request.temperature
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`vLLM error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return {
        content: data.choices[0].message.content,
        usage: {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens
        }
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
