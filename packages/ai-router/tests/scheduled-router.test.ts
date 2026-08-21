import { describe, expect, it } from 'vitest';
import { AIRouter } from '../src/router.js';
import { ScheduledAIRouter } from '../src/scheduled-router.js';
import { AIRequestScheduler, aiRequestPriorities } from '../src/scheduler.js';
import type {
  AIAdapter,
  GenerateOptions,
  GenerateResult,
  HealthResult,
} from '../src/types/adapter.js';

class AbortAwareAdapter implements AIAdapter {
  readonly name = 'abort-aware';
  readonly type = 'local' as const;
  readonly started: Promise<void>;
  received: GenerateOptions | undefined;
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  async health(): Promise<HealthResult> {
    return { available: true, latencyMs: 1 };
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    this.received = options;
    this.markStarted();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(options.signal?.reason);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

describe('ScheduledAIRouter', () => {
  it('routes through the scheduler and propagates scheduler cancellation to the adapter', async () => {
    const adapter = new AbortAwareAdapter();
    const router = new AIRouter();
    router.register(adapter);
    const scheduler = new AIRequestScheduler();
    const scheduledRouter = new ScheduledAIRouter(router, scheduler);
    const generated = scheduledRouter.generate({
      requestId: 'request-1',
      botId: 'bot-1',
      priority: aiRequestPriorities.combat,
      prompt: 'choose a combat strategy',
      maxTokens: 128,
      temperature: 0,
      timeoutMs: 5_000,
      traceId: 'trace-1',
    });
    const rejection = expect(generated).rejects.toMatchObject({
      code: 'AI_REQUEST_CANCELLED',
    });

    await adapter.started;
    expect(scheduler.cancel('request-1', 'target left')).toBe(true);
    await rejection;
    expect(adapter.received?.signal?.aborted).toBe(true);
    expect(adapter.received).toMatchObject({
      prompt: 'choose a combat strategy',
      traceId: 'trace-1',
    });
  });
});
