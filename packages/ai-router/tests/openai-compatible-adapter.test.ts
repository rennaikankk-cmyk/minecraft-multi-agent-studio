import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAICompatibleAdapter, compatibleChatEndpoint, parseRetryAfter } from '../src/adapters/openai-compatible-adapter.js';
import { AIRouter } from '../src/router.js';
import { AIRequestScheduler } from '../src/scheduler.js';
import { ScheduledAIRouter } from '../src/scheduled-router.js';
import type { GenerateOptions } from '../src/types/adapter.js';

const request: GenerateOptions = { prompt: 'Select the supplied opaque target reference.', maxTokens: 128, temperature: 0, timeoutMs: 5000, traceId: 'test-cloud' };
const response = (message: unknown = { content: '{"target":"ref-1"}' }, extra = {}) => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], ...extra }), { headers: { 'Content-Type': 'application/json' } });
const options = { baseUrl: 'https://provider.example.invalid/openai/v1', model: 'configured-model', apiKey: 'private-fixture-key' };
afterEach(() => vi.useRealTimers());

describe('controlled OpenAI-compatible provider fixture (no external calls)', () => {
  it('joins roots, version prefixes and full endpoints without duplicating v1', () => {
    expect(compatibleChatEndpoint('https://provider.example.invalid')).toBe('https://provider.example.invalid/v1/chat/completions');
    for (const path of ['/openai/v1', '/openai/v1/', '/openai/v1/chat/completions']) {
      expect(compatibleChatEndpoint(`https://provider.example.invalid${path}`)).toBe('https://provider.example.invalid/openai/v1/chat/completions');
    }
    for (const invalid of ['http://provider.example.invalid/v1', 'https://key@provider.example.invalid/v1', 'https://provider.example.invalid/v1?key=secret']) {
      expect(() => compatibleChatEndpoint(invalid)).toThrow();
    }
    expect(compatibleChatEndpoint('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('routes directly to generation without health/models and reports missing usage as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://provider.example.invalid/openai/v1/chat/completions');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer private-fixture-key' });
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: false, max_tokens: 64, model: 'configured-model' });
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('chat_template_kwargs');
      return response();
    });
    const adapter = new OpenAICompatibleAdapter({ ...options, fetchImplementation: fetcher, maxOutputTokens: 64 });
    expect(await adapter.health()).toEqual({ available: false, status: 'unverified' });
    const router = new AIRouter(); router.register(adapter);
    const result = await router.generate(request);
    expect(result).not.toHaveProperty('usage');
    expect(result).not.toHaveProperty('cost');
    expect(await adapter.health()).toMatchObject({ available: true, status: 'available' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['none', 'json_object', 'json_schema', 'tool'] as const)('supports the configured %s structured contract and validates output locally', async (mode) => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (mode === 'none') expect(body).not.toHaveProperty('response_format');
      if (mode === 'json_object' || mode === 'json_schema') expect(body.response_format.type).toBe(mode);
      if (mode === 'tool') {
        expect(body.tool_choice.function.name).toBe('structured_response');
        return response({ content: null, tool_calls: [{ type: 'function', function: { name: 'structured_response', arguments: '{"target":"ref-1"}' } }] });
      }
      return response({ content: [{ type: 'text', text: '{"target":"ref-1"}' }] }, { usage: { prompt_tokens: 12, completion_tokens: 6 } });
    });
    const adapter = new OpenAICompatibleAdapter({ ...options, structuredOutput: mode, fetchImplementation: fetcher });
    expect(await adapter.generate({ ...request, schema: z.object({ target: z.literal('ref-1') }) })).toMatchObject({ validated: { target: 'ref-1' } });
  });

  it.each([401, 403])('classifies HTTP %s as permanent authentication failure and blocks repeated Bot calls', async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('private-fixture-key echoed by server', { status }));
    const adapter = new OpenAICompatibleAdapter({ ...options, fetchImplementation: fetcher });
    for (let i = 0; i < 2; i++) {
      await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'AI_AUTH_FAILED', retryable: false, statusCode: status });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await adapter.health())).not.toContain('private-fixture-key');
  });

  it('shares provider rate-limit cooldown across Bots and parses numeric/date Retry-After', async () => {
    let now = 1000;
    const fetcher = vi.fn<typeof fetch>(async () => new Response('ignored', { status: 429, headers: { 'Retry-After': '2' } }));
    const adapter = new OpenAICompatibleAdapter({ ...options, now: () => now, fetchImplementation: fetcher });
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'AI_RATE_LIMITED', retryAfterMs: 2000 });
    now += 500;
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'AI_RATE_LIMITED', retryAfterMs: 1500 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:04 GMT', 1000)).toBe(3000);
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });

  it.each([[400, 'AI_CONFIG_INVALID', false], [500, 'AI_PROVIDER_UNAVAILABLE', true], [503, 'AI_PROVIDER_UNAVAILABLE', true]] as const)('classifies HTTP %s separately', async (status, code, retryable) => {
    const adapter = new OpenAICompatibleAdapter({ ...options, fetchImplementation: async () => new Response('secret-upstream-body', { status }) });
    await expect(adapter.generate(request)).rejects.toMatchObject({ code, retryable, statusCode: status });
  });

  it('rejects malformed/schema-invalid output and unexpected tools without leaking model text', async () => {
    for (const message of [{ content: 'secret bad output' }, { content: '{"target":"other"}' }, { content: null, tool_calls: [{ type: 'function', function: { name: 'run_shell', arguments: '{}' } }] }]) {
      const adapter = new OpenAICompatibleAdapter({ ...options, fetchImplementation: async () => response(message) });
      await expect(adapter.generate({ ...request, schema: z.object({ target: z.literal('ref-1') }) })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID', retryable: false });
    }
  });

  it('honors caller cancellation and rejects a late result from a transport ignoring abort', async () => {
    const controller = new AbortController();
    const adapter = new OpenAICompatibleAdapter({ ...options, fetchImplementation: async () => { controller.abort(); return response(); } });
    await expect(adapter.generate({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: 'AI_CANCELLED', retryable: false });
  });

  it('classifies provider timeout and redacts transport causes', async () => {
    const adapter = new OpenAICompatibleAdapter({ ...options, fetchImplementation: async (_url, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('private-fixture-key')), { once: true });
    }) });
    await expect(adapter.generate({ ...request, timeoutMs: 5 })).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT', retryable: true });
    const failed = new OpenAICompatibleAdapter({ ...options, fetchImplementation: async () => { throw new Error('private-fixture-key'); } });
    try { await failed.generate(request); } catch (error) {
      expect(error).toMatchObject({ code: 'AI_PROVIDER_FAILED' });
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain('private-fixture-key');
    }
  });

  it('retries only through the existing scheduler and honors Retry-After within the total deadline', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '1' } })).mockResolvedValueOnce(response());
    const router = new AIRouter(); router.register(new OpenAICompatibleAdapter({ ...options, fetchImplementation: fetcher }));
    const scheduler = new AIRequestScheduler({ defaultRetry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2000, jitterRatio: 0 } });
    const scheduled = new ScheduledAIRouter(router, scheduler);
    const pending = scheduled.generate({ ...request, requestId: 'request-1', botId: 'BotOne', priority: 30 });
    const completion = expect(pending).resolves.toMatchObject({ attempts: 2 });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await completion;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('never retries permanent auth and refuses Retry-After exceeding its retry budget', async () => {
    for (const status of [401, 429]) {
      const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status, headers: { 'Retry-After': '120' } }));
      const router = new AIRouter(); router.register(new OpenAICompatibleAdapter({ ...options, fetchImplementation: fetcher }));
      const scheduler = new AIRequestScheduler({ defaultRetry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1000 } });
      await expect(new ScheduledAIRouter(router, scheduler).generate({ ...request, requestId: 'request-1', botId: 'BotOne', priority: 30 })).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
