import type { AIAdapter, GenerateOptions, GenerateResult } from './types/adapter.js';

export class AIRouter {
  private adapters: AIAdapter[] = [];

  register(adapter: AIAdapter): void {
    this.adapters.push(adapter);
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    for (const adapter of this.adapters) {
      const health = await adapter.health();
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
