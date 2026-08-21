import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { VLLMAdapter } from '../src/adapters/vllm-adapter.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VLLMAdapter', () => {
  it('requests strict OpenAI-compatible structured output and validates the response', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"action":"noop"}' } }],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new VLLMAdapter('http://192.168.100.2:8000', 'test-model');

    await expect(
      adapter.generate({
        prompt: 'plan',
        maxTokens: 64,
        temperature: 0,
        timeoutMs: 5_000,
        traceId: 'trace-vllm',
        schema: z.object({ action: z.literal('noop') }).strict(),
      }),
    ).resolves.toEqual({
      content: '{"action":"noop"}',
      usage: { promptTokens: 12, completionTokens: 5 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://192.168.100.2:8000/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'test-model',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'structured_response',
          strict: true,
          schema: { type: 'object' },
        },
      },
    });
  });

  it('rejects malformed successful responses instead of returning invented defaults', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const adapter = new VLLMAdapter('http://192.168.100.2:8000', 'test-model');

    await expect(
      adapter.generate({
        prompt: 'plan',
        maxTokens: 64,
        temperature: 0,
        timeoutMs: 5_000,
        traceId: 'trace-vllm-invalid',
      }),
    ).rejects.toThrow();
  });
});
