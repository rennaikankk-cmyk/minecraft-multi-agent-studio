import type { AIAdapter, GenerateOptions, GenerateResult } from './types/adapter.js';

/**
 * 正向健康结果的缓存时长：把「每次 generate 前的串行探测」降为周期性
 * 探测。此前 vLLM/Ollama（requiresHealthCheck 未关闭的本地适配器）每个
 * 请求都先做一次独立 HTTP 往返——模型服务器请求量翻倍，探测延迟串行
 * 计入调度器的 purpose-aware 总超时（combat 档 5s 预算下探测最多吃掉
 * 全部额度），且 /health 瞬时故障会让本可成功的补全直接落空。
 *
 * 只缓存正向结果：负向与抛错都不缓存——即时降级与 fail-visible 语义
 * 保持不变。缓存的「健康」只表示直接尝试 generate；generate 自身的
 * 失败仍走适配器完整错误分类与上层重试。
 */
const HEALTH_CACHE_TTL_MS = 5_000;

export class AIRouter {
  private adapters: AIAdapter[] = [];
  private readonly healthCache = new WeakMap<AIAdapter, { expiresAtMs: number }>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  register(adapter: AIAdapter): void {
    this.adapters.push(adapter);
  }

  /** 探测并维护正向 TTL 缓存；负向/抛错不缓存。返回适配器是否可用。 */
  private async probeHealth(adapter: AIAdapter): Promise<boolean> {
    const cached = this.healthCache.get(adapter);
    if (cached !== undefined && cached.expiresAtMs > this.now()) return true;
    const health = await adapter.health();
    if (health.available) {
      this.healthCache.set(adapter, {
        expiresAtMs: this.now() + HEALTH_CACHE_TTL_MS,
      });
    } else {
      this.healthCache.delete(adapter);
    }
    return health.available;
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    for (const adapter of this.adapters) {
      throwIfAborted(opts.signal);
      if (adapter.requiresHealthCheck === false) return adapter.generate(opts);
      const available = await this.probeHealth(adapter);
      throwIfAborted(opts.signal);
      if (available) {
        try {
          return await adapter.generate(opts);
        } catch (error) {
          // generate 失败立即失效健康结论：适配器可能在探测后宕机——TTL
          // 窗口内的重试若仍走缓存会继续打同一个死适配器（combat 档总
          // 预算 5s 恰等于 TTL，一次失败可吃光全部预算）。失效后重试会
          // 重新探测并故障转移到下一个适配器。
          this.healthCache.delete(adapter);
          throw error;
        }
      }
    }
    throw new Error('No available AI adapter');
  }

  async healthCheck(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    await Promise.all(
      this.adapters.map(async (a) => {
        const h = await a.health();
        // 显式探测是最新的可用性知识，同样维护缓存（刷新 TTL）。
        if (h.available) {
          this.healthCache.set(a, { expiresAtMs: this.now() + HEALTH_CACHE_TTL_MS });
        } else {
          this.healthCache.delete(a);
        }
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
