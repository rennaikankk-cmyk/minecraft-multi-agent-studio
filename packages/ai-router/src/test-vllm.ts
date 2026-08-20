import { VLLMAdapter } from './adapters/vllm-adapter.js';
import { AIRouter } from './router.js';
import { randomUUID } from 'node:crypto';

const adapter = new VLLMAdapter('http://localhost:8000', 'huihui-qwen');
const router = new AIRouter();
router.register(adapter);

console.log('Testing vLLM health...');
const health = await adapter.health();
console.log('Health:', health);

console.log('\nGenerating response (first call may take 30-60s to warm up)...');
const result = await router.route({
  requestId: randomUUID(),
  botId: 'manual-vllm-test',
  taskType: 'planner',
  priority: 30,
  timestamp: new Date().toISOString(),
  stateVersion: 0,
  taskVersion: 0,
  prompt: 'I see a zombie at x=105, y=64, z=205. What should I do?',
  systemPrompt: 'You are a Minecraft survival expert. Give ONE direct action.',
  maxTokens: 100,
  temperature: 0.7,
  timeoutMs: 120000,  // 2 分钟
  traceId: 'test-001'
});

console.log('\n=== Result ===');
console.log(JSON.stringify(result, null, 2));
