import { OllamaAdapter } from './adapters/ollama-adapter.js';
import { VLLMAdapter } from './adapters/vllm-adapter.js';
import { AIRouter } from './router.js';
import type { AIAdapter } from './types/adapter.js';
import { z } from 'zod';

const environment = (globalThis as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env ?? {};
const baseUrl = environment.LOCAL_AI_HUB_URL ?? 'http://127.0.0.1:11435';
const model = environment.LOCAL_AI_MODEL ?? 'qwen-fast:latest';
const provider = environment.LOCAL_AI_PROVIDER?.trim().toLowerCase() ?? 'vllm';
const adapter: AIAdapter = provider === 'ollama'
  ? new OllamaAdapter(baseUrl, model)
  : new VLLMAdapter(baseUrl, model);
const router = new AIRouter();
router.register(adapter);

console.log(`Testing ${provider} Local AI health at ${baseUrl} with model ${model}...`);
const health = await adapter.health();
console.log('Health:', health);

console.log('\nGenerating a bounded, non-game probe...');
const result = await router.generate({
  prompt: 'Return the JSON object {"status":"ready"} and nothing else.',
  systemPrompt: 'You are a connectivity probe. Do not emit commands, coordinates, or game actions.',
  maxTokens: 64,
  temperature: 0,
  schema: z.object({ status: z.literal('ready') }).strict(),
  timeoutMs: 120_000,
  traceId: 'local-ai-connectivity-probe',
});

console.log('\n=== Result ===');
console.log(JSON.stringify(result, null, 2));
