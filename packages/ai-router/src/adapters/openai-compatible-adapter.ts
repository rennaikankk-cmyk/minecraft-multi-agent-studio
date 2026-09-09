import { z } from 'zod';
import { AIError } from '../errors.js';
import { parseStructuredOutput } from '../structured-output.js';
import type { AIAdapter, GenerateOptions, GenerateResult, HealthResult } from '../types/adapter.js';

export type CloudStructuredOutput = 'none' | 'json_object' | 'json_schema' | 'tool';
export type OpenAICompatibleAdapterOptions = Readonly<{
  baseUrl: string;
  model: string;
  apiKey: string;
  structuredOutput?: CloudStructuredOutput;
  maxOutputTokens?: number;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}>;

/** An explicit Chat Completions contract, independent of vLLM health and discovery.
 * Non-streaming only; the scheduler owns retry count and the total deadline.
 */
export class OpenAICompatibleAdapter implements AIAdapter {
  readonly name = 'openai-compatible';
  readonly type = 'cloud' as const;
  readonly requiresHealthCheck = false;
  private readonly endpoint: string;
  private readonly mode: CloudStructuredOutput;
  private readonly maxTokens: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private observation: HealthResult = { available: false, status: 'unverified' };
  private retryNotBefore = 0;
  private permanentFailure: AIError | null = null;

  constructor(private readonly options: OpenAICompatibleAdapterOptions) {
    this.endpoint = compatibleChatEndpoint(options.baseUrl);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u.test(options.model) ||
        !options.apiKey.trim() || options.apiKey.length > 4096 || /[\r\n]/u.test(options.apiKey)) {
      throw new AIError('AI_CONFIG_INVALID', 'Cloud model or backend API key is invalid.');
    }
    this.mode = options.structuredOutput ?? 'none';
    if (!['none', 'json_object', 'json_schema', 'tool'].includes(this.mode)) {
      throw new AIError('AI_CONFIG_INVALID', 'Cloud structured output contract is invalid.');
    }
    this.maxTokens = options.maxOutputTokens ?? 4096;
    if (!Number.isSafeInteger(this.maxTokens) || this.maxTokens < 1 || this.maxTokens > 131072) {
      throw new AIError('AI_CONFIG_INVALID', 'Cloud output token budget is invalid.');
    }
    this.doFetch = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async health(): Promise<HealthResult> { return { ...this.observation }; }

  async generate(request: GenerateOptions): Promise<GenerateResult> {
    if (request.signal?.aborted) throw this.error('AI_CANCELLED', false);
    if (this.permanentFailure) throw this.permanentFailure;
    if (this.retryNotBefore > this.now()) {
      throw new AIError('AI_RATE_LIMITED', 'Cloud provider cooldown is active.', {
        provider: this.name, retryable: true, retryAfterMs: this.retryNotBefore - this.now(), statusCode: 429,
      });
    }
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 600000 ||
        !Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1 ||
        !Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2) {
      throw this.error('AI_CONFIG_INVALID', false);
    }
    const controller = new AbortController();
    let timedOut = false;
    const started = this.now();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs);
    const cancel = () => controller.abort();
    request.signal?.addEventListener('abort', cancel, { once: true });
    try {
      let outputContract: Record<string, unknown>;
      try { outputContract = this.outputContract(request); } catch { throw this.error('AI_CONFIG_INVALID', false); }
      const response = await this.doFetch(this.endpoint, {
        method: 'POST', redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey.trim()}` },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
            { role: 'user', content: request.prompt },
          ],
          stream: false,
          max_tokens: Math.min(request.maxTokens, this.maxTokens),
          temperature: request.temperature,
          ...outputContract,
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw this.error(timedOut ? 'AI_PROVIDER_TIMEOUT' : 'AI_CANCELLED', timedOut);
      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now()) ?? (response.status === 429 ? 1000 : undefined);
        const code = response.status === 401 || response.status === 403 ? 'AI_AUTH_FAILED'
          : response.status === 429 ? 'AI_RATE_LIMITED'
            : response.status >= 500 ? 'AI_PROVIDER_UNAVAILABLE' : 'AI_CONFIG_INVALID';
        const retryable = code === 'AI_RATE_LIMITED' || code === 'AI_PROVIDER_UNAVAILABLE';
        const error = new AIError(code, `Cloud provider returned HTTP ${response.status}.`, {
          provider: this.name, retryable, statusCode: response.status,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
        // A shared adapter applies provider cooldown across Bots. Authentication
        // errors stay blocked until controlled configuration creates a new adapter.
        if (code === 'AI_RATE_LIMITED') this.retryNotBefore = this.now() + (retryAfterMs ?? 1000);
        if (code === 'AI_AUTH_FAILED') this.permanentFailure = error;
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
      const data: unknown = await response.json().catch(() => { throw this.error('AI_OUTPUT_INVALID', false); });
      if (controller.signal.aborted) throw this.error(timedOut ? 'AI_PROVIDER_TIMEOUT' : 'AI_CANCELLED', timedOut);
      const result = parseCompletion(data, this.mode);
      if (request.schema) {
        try {
          result.validated = parseStructuredOutput(result.content, { name: 'cloud_response', schema: request.schema });
        } catch { throw this.error('AI_OUTPUT_INVALID', false); }
      }
      this.observation = { available: true, status: 'available', latencyMs: Math.max(0, this.now() - started) };
      return result;
    } catch (cause) {
      const error = request.signal?.aborted ? this.error('AI_CANCELLED', false)
        : timedOut ? this.error('AI_PROVIDER_TIMEOUT', true)
          : cause instanceof AIError ? cause : this.error('AI_PROVIDER_FAILED', true);
      if (error.code !== 'AI_CANCELLED') this.observation = {
        available: false, status: 'unavailable', latencyMs: Math.max(0, this.now() - started), error: error.code,
      };
      // Transport errors and response bodies may echo secrets; expose stable
      // codes only and never attach upstream error causes or response text.
      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', cancel);
    }
  }

  private outputContract(request: GenerateOptions): Record<string, unknown> {
    if (!request.schema || this.mode === 'none') return {};
    if (this.mode === 'json_object') return { response_format: { type: 'json_object' } };
    const schema = z.toJSONSchema(request.schema);
    if (this.mode === 'json_schema') return { response_format: {
      type: 'json_schema', json_schema: { name: 'structured_response', strict: true, schema },
    } };
    return {
      tools: [{ type: 'function', function: { name: 'structured_response', description: 'Return the validated response.', parameters: schema } }],
      tool_choice: { type: 'function', function: { name: 'structured_response' } },
      parallel_tool_calls: false,
    };
  }

  private error(code: ConstructorParameters<typeof AIError>[0], retryable: boolean): AIError {
    return new AIError(code, `Cloud request failed (${code}).`, { provider: this.name, retryable });
  }
}

export function compatibleChatEndpoint(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new AIError('AI_CONFIG_INVALID', 'Cloud endpoint is invalid.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new AIError('AI_CONFIG_INVALID', 'Cloud endpoint requires HTTPS, no embedded credentials or query; HTTP is limited to loopback fixtures.');
  }
  const prefix = url.pathname.replace(/\/+$/u, '');
  url.pathname = prefix.endsWith('/chat/completions') ? prefix : `${prefix || '/v1'}/chat/completions`;
  return url.href;
}

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const ms = Math.ceil(Number(trimmed) * 1000);
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

function parseCompletion(payload: unknown, mode: CloudStructuredOutput): GenerateResult {
  const textPart = z.object({ type: z.literal('text'), text: z.string() }).loose();
  const schema = z.object({ choices: z.array(z.object({
    message: z.object({
      content: z.union([z.string(), z.array(textPart)]).nullable().optional(),
      refusal: z.string().nullable().optional(),
      tool_calls: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string(), arguments: z.string() }).loose() }).loose()).optional(),
    }).loose(),
    finish_reason: z.string().nullable().optional(),
  }).loose()).min(1), usage: z.unknown().optional() }).loose().safeParse(payload);
  if (!schema.success) throw new AIError('AI_OUTPUT_INVALID', 'Cloud response does not satisfy the completion contract.');
  const choice = schema.data.choices[0]!;
  const message = choice.message;
  let content = typeof message.content === 'string' ? message.content : message.content?.map((part) => part.text).join('') ?? '';
  if (message.tool_calls?.length) {
    if (mode !== 'tool' || message.tool_calls.length !== 1 || message.tool_calls[0]?.function.name !== 'structured_response') {
      throw new AIError('AI_OUTPUT_INVALID', 'Cloud response contains an unexpected tool call.');
    }
    content = message.tool_calls[0].function.arguments;
  }
  if (!content.trim() || message.refusal) throw new AIError('AI_OUTPUT_INVALID', 'Cloud response has no usable completion.');
  const usage = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).loose().safeParse(schema.data.usage);
  return { content, ...(choice.finish_reason === undefined ? {} : { finishReason: choice.finish_reason }),
    ...(usage.success ? { usage: { promptTokens: usage.data.prompt_tokens, completionTokens: usage.data.completion_tokens } } : {}) };
}
