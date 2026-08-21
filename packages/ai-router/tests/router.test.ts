import { describe, expect, it } from 'vitest';
import { AIRouter } from '../src/router.js';
import type { AIAdapter, GenerateOptions, GenerateResult, HealthResult } from '../src/types/adapter.js';

interface StubOptions {
  name: string;
  available: boolean;
  healthError?: Error;
}

class StubAdapter implements AIAdapter {
  readonly name: string;
  readonly type = 'local' as const;

  healthCalls = 0;
  generateCalls: GenerateOptions[] = [];

  private readonly available: boolean;
  private readonly healthError?: Error;

  constructor(opts: StubOptions) {
    this.name = opts.name;
    this.available = opts.available;
    this.healthError = opts.healthError;
  }

  async health(): Promise<HealthResult> {
    this.healthCalls += 1;
    if (this.healthError) {
      throw this.healthError;
    }
    return { available: this.available, latencyMs: 1 };
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    this.generateCalls.push(opts);
    return {
      content: `reply-from-${this.name}`,
      usage: { promptTokens: 3, completionTokens: 5 },
    };
  }
}

function generateOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    prompt: 'assign tasks to idle bots',
    maxTokens: 128,
    temperature: 0,
    timeoutMs: 5_000,
    traceId: 'trace-router-test',
    ...overrides,
  };
}

describe('AIRouter.generate', () => {
  it('routes to the first registered adapter that reports available', async () => {
    const router = new AIRouter();
    const primary = new StubAdapter({ name: 'primary', available: true });
    const fallback = new StubAdapter({ name: 'fallback', available: true });
    router.register(primary);
    router.register(fallback);

    const result = await router.generate(generateOptions());

    expect(result.content).toBe('reply-from-primary');
    expect(primary.generateCalls).toHaveLength(1);
    expect(fallback.generateCalls).toHaveLength(0);
  });

  it('falls through to the next adapter when the preferred one is unavailable', async () => {
    const router = new AIRouter();
    const offline = new StubAdapter({ name: 'offline-spark', available: false });
    const fallback = new StubAdapter({ name: 'fallback', available: true });
    router.register(offline);
    router.register(fallback);

    const result = await router.generate(generateOptions());

    expect(result.content).toBe('reply-from-fallback');
    expect(offline.healthCalls).toBe(1);
    expect(offline.generateCalls).toHaveLength(0);
  });

  it('forwards generate options through to the selected adapter unchanged', async () => {
    const router = new AIRouter();
    const adapter = new StubAdapter({ name: 'primary', available: true });
    router.register(adapter);

    const opts = generateOptions({ systemPrompt: 'you coordinate bots', traceId: 'trace-forward' });
    await router.generate(opts);

    expect(adapter.generateCalls[0]).toEqual(opts);
  });

  it('throws when no adapter is registered', async () => {
    const router = new AIRouter();

    await expect(router.generate(generateOptions())).rejects.toThrow('No available AI adapter');
  });

  it('throws when every registered adapter is unavailable', async () => {
    const router = new AIRouter();
    router.register(new StubAdapter({ name: 'offline-a', available: false }));
    router.register(new StubAdapter({ name: 'offline-b', available: false }));

    await expect(router.generate(generateOptions())).rejects.toThrow('No available AI adapter');
  });

  it('propagates health-probe failures instead of silently skipping the adapter', async () => {
    const router = new AIRouter();
    router.register(
      new StubAdapter({ name: 'broken', available: true, healthError: new Error('ECONNREFUSED') })
    );
    const healthy = new StubAdapter({ name: 'healthy', available: true });
    router.register(healthy);

    await expect(router.generate(generateOptions())).rejects.toThrow('ECONNREFUSED');
    expect(healthy.generateCalls).toHaveLength(0);
  });
});

describe('AIRouter.healthCheck', () => {
  it('reports availability keyed by adapter name', async () => {
    const router = new AIRouter();
    router.register(new StubAdapter({ name: 'spark-vllm', available: true }));
    router.register(new StubAdapter({ name: 'offline', available: false }));

    const health = await router.healthCheck();

    expect(health.get('spark-vllm')).toBe(true);
    expect(health.get('offline')).toBe(false);
    expect(health.size).toBe(2);
  });

  it('returns an empty map when nothing is registered', async () => {
    const health = await new AIRouter().healthCheck();

    expect(health.size).toBe(0);
  });

  it('probes every adapter, not just the first available one', async () => {
    const router = new AIRouter();
    const first = new StubAdapter({ name: 'first', available: true });
    const second = new StubAdapter({ name: 'second', available: true });
    router.register(first);
    router.register(second);

    await router.healthCheck();

    expect(first.healthCalls).toBe(1);
    expect(second.healthCalls).toBe(1);
  });
});
