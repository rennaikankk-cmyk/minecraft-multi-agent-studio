import type { AIAdapter, GenerateOptions, GenerateResult } from './types/adapter.js';

export class AIRouter {
  private adapters: AIAdapter[] = [];

  register(adapter: AIAdapter): void {
    this.adapters.push(adapter);
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    for (const adapter of this.adapters) {
      throwIfAborted(opts.signal);
      if (adapter.requiresHealthCheck === false) return adapter.generate(opts);
      const health = await adapter.health();
      throwIfAborted(opts.signal);
      if (health.available) {
        return adapter.generate(opts);
      }
    }
    throw new Error('No available AI adapter');
  }

  async healthCheck(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    await Promise.all(
      this.adapters.map(async (a) => {
        const h = await a.health();
        results.set(a.name, h.available);
      })
    );
    return results;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('AI request was aborted.');
}
